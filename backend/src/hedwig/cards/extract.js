// The cards job: deterministic detectors for every sorted message, then the Reflex model
// (cards.extract, batched, budget feature 'cards') for Purchases/Finance/Travel/Deliveries/Calendar
// mail they found nothing in, then subscriptions. A schedule queues sorted mail without a scan.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { guardedFetch, ATTACHMENT_JOB } from '../core/mailYield.js';
import { runPrompt } from '../prompts/index.js';
import { messageText } from '../text.js';
import { validTimezone } from '../insights/time.js';
import { detectDeterministic, calendarAttachments, dataSignal, needsFill } from './detect/index.js';
import { findSubscriptions } from './subscriptions.js';
import { upsertCard } from './store.js';
import { normFields, normField, dedupeKey } from './kinds.js';
import { loadBlocks, isBlocked, feedbackForMessages } from './feedback.js';

// v2 (audit 2026-09-24): order/booking/invoice patterns, the Reflex fill for partial pattern cards and
// for People/Records mail with data signals whatever its bundle. Bumping it rescans sorted mail.
export const CARDS_VERSION = 'cards-v2';
export const ICS_JOB = 'cards.fetchIcs';
export const CARDS_JOB = 'cards.extract';

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[\u00a0\s]+/g, ' ').trim();
const alnum = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Where a model's quote occurs: the message text or one of its attachments. Whitespace, case and
 * punctuation are forgiven; anything else is not. Pure.
 * @returns {{ attachment: string|null }|null}
 */
export function locateQuote(quote, { text = '', attachments = [] } = {}) {
  const q = norm(quote);
  if (q.length < 4) return null;
  const qa = alnum(quote);
  const inside = (t) => norm(t).includes(q) || (qa.length >= 6 && alnum(t).includes(qa));
  if (inside(text)) return { attachment: null };
  for (const a of attachments) if (inside(a.text)) return { attachment: a.filename || null };
  return null;
}

/** Does the quote actually contain the value (for numbers, references and codes)? Pure. */
export function quoteSupports(kind, field, value, quote) {
  if (value == null) return false;
  const q = alnum(quote);
  if (typeof value === 'number') {
    const whole = String(Math.trunc(Math.abs(value)));
    return q.includes(whole);
  }
  if (['orderNumber', 'invoiceNumber', 'trackingNumber', 'reference', 'flightNumber'].includes(field)) return q.includes(alnum(value));
  return true;
}

const REQUIRED = {
  receipt: (f) => f.merchant || f.total != null,
  invoice: (f) => f.amount != null || f.dueDate,
  subscription: (f) => f.merchant,
  delivery: (f) => f.status || f.trackingNumber || f.expectedDate,
  travel: (f) => f.departAt || f.checkIn || f.reference,
  event: (f) => f.title && f.start,
};

/**
 * Turn one model card into a stored card: keep only fields whose quote is found in the message (or
 * an attachment) and supports the value. Pure.
 */
export function verifyModelCard(raw, { messageId, text, attachments, provenance, layer = 'reflex' }) {
  const kind = raw?.kind;
  if (!REQUIRED[kind]) return null;
  const quotes = new Map();
  for (const q of Array.isArray(raw.quotes) ? raw.quotes : []) if (q?.field && q?.quote && !quotes.has(q.field)) quotes.set(q.field, q.quote);
  const fields = {};
  const sources = {};
  for (const [k, v] of Object.entries(normFields(kind, raw.fields || {}))) {
    const quote = quotes.get(k) || (k === 'currency' ? quotes.get(kind === 'receipt' ? 'total' : 'amount') : null);
    if (!quote) continue;
    const where = locateQuote(quote, { text, attachments });
    if (!where || !quoteSupports(kind, k, v, quote)) continue;
    fields[k] = v;
    sources[k] = { messageId, quote: String(quote).slice(0, 400), ...(where.attachment ? { attachment: where.attachment } : {}), via: layer };
  }
  if (kind === 'receipt' && Array.isArray(raw.fields?.items) && fields.merchant) {
    const items = normField('receipt', 'items', raw.fields.items);
    if (items?.length && quotes.get('items') && locateQuote(quotes.get('items'), { text, attachments })) {
      fields.items = items;
      sources.items = { messageId, quote: String(quotes.get('items')).slice(0, 400), via: layer };
    }
  }
  if (!REQUIRED[kind](fields)) return null;
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0.6));
  return { kind, messageId, fields, sources, confidence, layer, provenance };
}

/** Which mail the Reflex model reads when the detectors found nothing (or only a partial pattern card). Pure. */
export function reflexEligible(row, { bundles, signalReflex = true }) {
  if (!row || row.stream === 'spam') return false;
  if (row.stream === 'records' && row.bundle && bundles.has(row.bundle)) return true;
  return signalReflex && ['records', 'people', 'screener'].includes(row.stream) && dataSignal(row);
}

const REF_FIELD = { receipt: 'orderNumber', invoice: 'invoiceNumber', travel: 'reference', delivery: 'trackingNumber' };

/** The pattern card a model card is about: same kind, and the same reference when both state one. Pure. */
export function twinOf(card, patternCards = []) {
  const key = REF_FIELD[card.kind];
  return (patternCards || []).find((p) => {
    if (p.kind !== card.kind) return false;
    const a = key ? String(p.fields?.[key] || '').replace(/\s+/g, '').toUpperCase() : '';
    const b = key ? String(card.fields?.[key] || '').replace(/\s+/g, '').toUpperCase() : '';
    return !a || !b || a === b;
  }) || null;
}

// ── The job ─────────────────────────────────────────────────────────────────

const ROW_SQL = `SELECT m.id, m.account_id, m.subject, m.from_name, m.from_email, m.date, m.body_text, m.body_html, m.snippet,
                        m.attachments, m.has_attachments, m.folder, s.bundle, s.stream
                   FROM messages m JOIN email_accounts a ON a.id = m.account_id
                   LEFT JOIN hedwig_sort s ON s.message_id = m.id
                  WHERE a.user_id = $1 AND m.id = ANY($2::uuid[]) AND m.is_deleted = false`;

async function markScan(userId, ids, state, { found = new Map(), reflex = new Set(), error = null } = {}) {
  if (!ids.length) return;
  await query(
    `INSERT INTO hedwig_cards_scan (message_id, user_id, version, state, found, reflex, error, scanned_at)
     SELECT id, $2, $3, $4, f, r, $5, NOW() FROM UNNEST($1::uuid[], $6::int[], $7::bool[]) AS t(id, f, r)
      WHERE EXISTS (SELECT 1 FROM messages m WHERE m.id = t.id)
     ON CONFLICT (message_id) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state,
       found = EXCLUDED.found, reflex = EXCLUDED.reflex, error = EXCLUDED.error, scanned_at = NOW()`,
    [ids, userId, CARDS_VERSION, state, error, ids.map((id) => found.get(id) || 0), ids.map((id) => reflex.has(id))],
  );
}

async function attachmentTexts(ids) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT message_id, filename, LEFT(text, 2000) AS text FROM hedwig_attachment_text
      WHERE message_id = ANY($1::uuid[]) AND text IS NOT NULL AND chars > 0 ORDER BY message_id, attachment_index`,
    [ids],
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, []);
    out.get(r.message_id).push({ filename: r.filename, text: r.text });
  }
  return out;
}

async function icsPartsFor(ids) {
  if (!ids.length) return new Map();
  const { rows } = await query('SELECT message_id, attachment_index, filename, text, error FROM hedwig_card_parts WHERE message_id = ANY($1::uuid[])', [ids]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, []);
    out.get(r.message_id).push(r);
  }
  return out;
}

/**
 * Make cards for some of a user's messages.
 * @param {{ userId: string, messageIds: string[] }} payload
 * @returns {Promise<{ status: 'done'|'partial', note: string }>}
 */
export async function runCardsJob({ userId, messageIds = [] }, { now = new Date() } = {}) {
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['cards.enabled']) return { status: 'done', note: 'cards off' };
  const ids = [...new Set(messageIds)].slice(0, 500);
  const { rows } = await query(ROW_SQL, [userId, ids]);
  const tz = validTimezone(cfg['insights.timezone']);
  const gone = ids.filter((id) => !rows.some((r) => r.id === id));
  const [parts, attachments] = await Promise.all([icsPartsFor(rows.map((r) => r.id)), attachmentTexts(rows.map((r) => r.id))]);

  const found = new Map();
  const waiting = [];
  const candidates = [];
  let stored = 0;
  let money = false;
  // A kind the owner rejected for a merchant ("Not a subscription", "Not an event") is not made again.
  const blocks = rows.length ? await loadBlocks(userId) : null;
  let blocked = 0;
  for (const row of rows) {
    const cal = calendarAttachments(row.attachments, { maxBytes: cfg['cards.icsMaxBytes'] });
    const fetched = parts.get(row.id) || [];
    const missing = cal.filter((a) => a.part && !fetched.some((p) => p.attachment_index === a.index));
    if (missing.length) {
      await enqueue(ICS_JOB, { userId, messageId: row.id }, { userId, dedupeKey: `cards.ics:${row.id}`, priority: 8, maxAttempts: 3 });
      waiting.push(row.id);
      continue;
    }
    const detected = detectDeterministic(row, { icsParts: fetched.filter((p) => p.text).map((p) => ({ text: p.text, filename: p.filename })), tz });
    const cards = detected.filter((c) => !isBlocked(c, blocks, row));
    blocked += detected.length - cards.length;
    for (const c of cards) {
      if (await upsertCard(userId, c, { messageDate: row.date })) { stored++; if (c.kind === 'receipt' || c.kind === 'invoice') money = true; }
    }
    found.set(row.id, cards.length);
    // The model reads mail with nothing deterministic, and fills pattern cards missing their figure.
    if (!cards.length || needsFill(cards)) { row.patternCards = cards; candidates.push(row); }
  }

  // Reflex, newest first, rate-limited per job: Records mail in a data bundle, and People/Records/
  // Screener mail whose subject or sender says it is an order, booking, invoice, ticket or delivery.
  const bundles = new Set(Array.isArray(cfg['cards.reflexBundles']) ? cfg['cards.reflexBundles'] : []);
  const maxAge = cfg['cards.reflexMaxAgeDays'] * 86400_000;
  const eligible = candidates
    .filter((r) => reflexEligible(r, { bundles, signalReflex: cfg['cards.signalReflex'] !== false }) && (!maxAge || new Date(now) - new Date(r.date) <= maxAge))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const size = cfg['cards.batchSize'];
  const allowed = cfg['llm.baseUrl'] ? cfg['cards.reflexPerJob'] * size : 0;
  const toAsk = eligible.slice(0, allowed);
  const deferred = eligible.slice(allowed).map((r) => r.id);
  const reflexed = new Set();
  const errored = new Set();
  let partial = null;
  for (let i = 0; i < toAsk.length; i += size) {
    const batch = toAsk.slice(i, i + size);
    // The owner's recent corrections of cards from each sender, shown to the model with its mail.
    const corrections = await feedbackForMessages(userId, batch);
    const view = batch.map((r, k) => ({
      id: `m${k + 1}`, row: r,
      text: messageText(r, { maxChars: cfg['cards.textChars'], stripQuotes: false }),
      attachments: (attachments.get(r.id) || []).slice(0, 2),
    }));
    let res;
    try {
      res = await runPrompt('cards.extract', {
        today: new Date(now).toISOString().slice(0, 10),
        items: view.map((v) => ({
          id: v.id, from: v.row.from_name ? `${v.row.from_name} <${v.row.from_email}>` : v.row.from_email, date: v.row.date ? new Date(v.row.date).toISOString() : '',
          subject: v.row.subject, bundle: v.row.bundle, text: v.text, attachments: v.attachments,
          feedback: corrections.get(v.row.id) || [],
        })),
      }, { userId, feature: 'cards', lane: 'background' });
    } catch (err) {
      if (['budget_exceeded', 'llm_disabled', 'user_required'].includes(err.code)) {
        partial = err.code;
        deferred.push(...toAsk.slice(i).map((r) => r.id));
        break;
      }
      if (err.name === 'PromptOutputError') {
        // Unusable output for this batch: record it, move on.
        await markScan(userId, batch.map((r) => r.id), 'error', { error: err.message.slice(0, 300) });
        batch.forEach((r) => errored.add(r.id));
        continue;
      }
      throw err;
    }
    const provenance = { promptId: res.provenance.promptId, promptVersion: res.provenance.promptVersion, model: res.provenance.model, aiCallId: res.provenance.aiCallId };
    const byId = new Map(view.map((v) => [v.id, v]));
    for (const item of res.data.items || []) {
      const v = byId.get(item.id);
      if (!v) continue;
      let n = 0;
      for (const raw of item.cards || []) {
        const card = verifyModelCard(raw, {
          messageId: v.row.id, text: `${v.row.subject || ''}\n${v.text}`, attachments: v.attachments, provenance,
          layer: (res.provenance.servedTier || (res.provenance.escalated ? 'reasoning' : 'reflex')) === 'reasoning' ? 'reasoning' : 'reflex',
        });
        if (!card) continue;
        if (isBlocked(card, blocks, v.row)) { blocked++; continue; }
        const twin = twinOf(card, v.row.patternCards);
        if (twin) card.dedupeKey = dedupeKey(twin); // fill the pattern card rather than make a second one
        if (await upsertCard(userId, card, { messageDate: v.row.date })) { n++; stored++; if (card.kind === 'receipt' || card.kind === 'invoice') money = true; }
      }
      found.set(v.row.id, (found.get(v.row.id) || 0) + n);
    }
    batch.forEach((r) => reflexed.add(r.id));
  }

  const done = rows.map((r) => r.id).filter((id) => !waiting.includes(id) && !deferred.includes(id) && !errored.has(id));
  await markScan(userId, done, 'done', { found, reflex: reflexed });
  await markScan(userId, waiting, 'waiting');
  await markScan(userId, [...new Set(deferred)], 'deferred', { error: partial });
  if (gone.length) await markScan(userId, gone, 'done');
  if (money) await syncSubscriptions(userId, { cfg, now });
  const note = `${rows.length} messages, ${stored} cards, ${reflexed.size} via reflex, ${waiting.length} waiting for calendar parts, ${deferred.length} deferred${blocked ? `, ${blocked} left out by the owner's feedback` : ''}`;
  return partial || deferred.length ? { status: 'partial', note: `${note}${partial ? ` (${partial})` : ''}` } : { status: 'done', note };
}

/**
 * Recompute subscription cards from the user's receipts and invoices. Derived cards the finder no
 * longer finds are hidden (dismissed_reason 'not_recurring'; they come back if the charges do),
 * except ones the owner confirmed or gave a cadence; the owner's own cards are never touched.
 * Merchants the owner called one-off are never derived.
 */
export async function syncSubscriptions(userId, { cfg = null, now = new Date() } = {}) {
  const config = cfg || await getConfig(userId);
  const { rows } = await query(
    `SELECT c.id, c.kind, c.message_id, c.fields, c.sources, m.date, m.subject, LEFT(m.snippet, 300) AS snippet,
            ARRAY(SELECT DISTINCT k.kind FROM hedwig_cards k
                   WHERE k.user_id = c.user_id AND k.id <> c.id AND k.dismissed_at IS NULL
                     AND (k.message_id = c.message_id OR c.message_id = ANY(k.message_ids))) AS sibling_kinds
       FROM hedwig_cards c LEFT JOIN messages m ON m.id = c.message_id
      WHERE c.user_id = $1 AND c.kind IN ('receipt', 'invoice') AND c.dismissed_at IS NULL`,
    [userId],
  );
  const charges = rows.map((r) => ({
    cardId: r.id,
    kind: r.kind,
    messageId: r.message_id,
    merchant: r.fields.merchant || r.fields.issuer,
    amount: r.fields.total ?? r.fields.amount,
    currency: r.fields.currency || null,
    date: r.fields.date || r.fields.issuedDate || (r.date ? new Date(r.date).toISOString().slice(0, 10) : null),
    orderNumber: r.kind === 'receipt' ? r.fields.orderNumber || null : null,
    siblingKinds: r.sibling_kinds || [],
    subject: r.subject || null,
    snippet: r.snippet || null,
    sources: r.sources,
  }));
  const { oneOff } = await loadBlocks(userId);
  const subs = findSubscriptions(charges, { minCharges: config['cards.subscriptionMinCharges'], now, oneOff });
  const byCard = new Map(charges.map((c) => [c.cardId, c]));
  const kept = [];
  let n = 0;
  for (const s of subs) {
    const last = byCard.get(s.cardIds[s.cardIds.length - 1]) || {};
    const amountSrc = last.sources?.total || last.sources?.amount || { messageId: s.lastMessageId, quote: `${s.amount} ${s.currency || ''}`.trim() };
    const derived = { messageId: s.lastMessageId, quote: `${s.charges} charges from ${s.merchant}, last on ${s.lastCharged}`, via: 'derived', messageIds: s.messageIds };
    const fields = { merchant: s.merchant, amount: s.amount, currency: s.currency, cadence: s.cadence, lastCharged: s.lastCharged, charges: s.charges };
    if (s.nextRenewal) fields.nextRenewal = s.nextRenewal;
    const sources = {
      merchant: last.sources?.merchant || last.sources?.issuer || derived, amount: amountSrc, currency: amountSrc,
      cadence: derived, lastCharged: derived, charges: derived, ...(s.nextRenewal ? { nextRenewal: derived } : {}),
    };
    const res = await upsertCard(userId, { kind: 'subscription', messageId: s.lastMessageId, fields, sources, confidence: 0.8, layer: 'derived' }, {});
    if (res) {
      n++;
      kept.push(res.id);
      // A card this finder hid earlier comes back when the charges show it again; the owner's dismissals stay.
      await query(
        `UPDATE hedwig_cards SET message_ids = (SELECT ARRAY(SELECT DISTINCT unnest(message_ids || $2::uuid[]))),
                dismissed_at = CASE WHEN dismissed_reason = 'not_recurring' THEN NULL ELSE dismissed_at END,
                dismissed_reason = CASE WHEN dismissed_reason = 'not_recurring' THEN NULL ELSE dismissed_reason END
          WHERE id = $1`,
        [res.id, s.messageIds],
      );
    }
  }
  const { rowCount } = await query(
    `UPDATE hedwig_cards c SET dismissed_at = NOW(), dismissed_reason = 'not_recurring', updated_at = NOW()
      WHERE c.user_id = $1 AND c.kind = 'subscription' AND c.layer = 'derived' AND c.dismissed_at IS NULL
        AND NOT (c.id = ANY($2::uuid[]))
        AND NOT (c.user_edited AND c.sources->'cadence'->>'via' = 'user' AND c.fields ? 'cadence')
        AND NOT EXISTS (SELECT 1 FROM hedwig_card_feedback f WHERE f.user_id = c.user_id AND f.card_id = c.id AND f.verdict = 'confirmed')`,
    [userId, kept],
  );
  return { found: n, hidden: rowCount || 0 };
}

// ── Scheduling ──────────────────────────────────────────────────────────────

/** Queue card jobs for sorted mail that has not been scanned under the current detector version. */
export async function scanTick() {
  const { rows: users } = await query(
    `SELECT DISTINCT s.user_id FROM hedwig_sort s
      WHERE s.decided_at > NOW() - INTERVAL '400 days'
        AND NOT EXISTS (SELECT 1 FROM hedwig_cards_scan x WHERE x.message_id = s.message_id AND x.version = $1 AND x.state = 'done')
      LIMIT 1000`,
    [CARDS_VERSION],
  );
  let queued = 0;
  for (const { user_id: userId } of users) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled || !cfg['cards.enabled']) continue;
      const { rows } = await query(
        `SELECT s.message_id FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
           LEFT JOIN hedwig_cards_scan x ON x.message_id = s.message_id
          WHERE s.user_id = $1 AND s.stream <> 'spam' AND NOT m.is_deleted AND NOT s.own
            AND m.date > NOW() - make_interval(days => $2::int)
            AND (x.message_id IS NULL OR x.version <> $3
                 OR (x.state = 'deferred' AND x.scanned_at < NOW() - INTERVAL '1 hour')
                 OR (x.state = 'waiting' AND x.scanned_at < NOW() - INTERVAL '1 day'))
          ORDER BY m.date DESC
          LIMIT $4`,
        [userId, cfg['cards.maxAgeDays'], CARDS_VERSION, cfg['cards.scanBatch']],
      );
      const ids = rows.map((r) => r.message_id);
      if (!ids.length) continue;
      // Held as 'waiting' until the job runs, so the next tick does not queue them again.
      await markScan(userId, ids, 'waiting');
      for (let i = 0; i < ids.length; i += cfg['cards.jobSize']) {
        const chunk = ids.slice(i, i + cfg['cards.jobSize']);
        await enqueue(CARDS_JOB, { userId, messageIds: chunk }, { userId, dedupeKey: `cards:${userId}:${chunk[0]}:${chunk.length}`, priority: 8, maxAttempts: 3 });
        queued++;
      }
    } catch (err) {
      console.warn(`[hedwig] cards scan failed for ${userId}:`, err.message);
    }
  }
  return queued;
}

/** What rebuild() hands the ledger: sorted mail still waiting for a scan, as job payloads. */
export async function pendingPayloads(userId) {
  if (!userId) return [];
  const { rows } = await query(
    `SELECT x.message_id FROM hedwig_cards_scan x WHERE x.user_id = $1 AND x.state IN ('waiting', 'deferred') ORDER BY x.scanned_at LIMIT 200`,
    [userId],
  );
  const ids = rows.map((r) => r.message_id);
  const out = [];
  for (let i = 0; i < ids.length; i += 25) out.push({ userId, messageIds: ids.slice(i, i + 25) });
  return out;
}

// ── Calendar parts (API process: needs the mail engine) ────────────────────

/** API-side job: fetch a message's calendar attachments with BODY.PEEK and keep their text. */
export function makeIcsHandler(imapManager) {
  return async ({ userId, messageId }) => {
    const cfg = await getConfig(userId);
    const { rows } = await query(
      `SELECT m.id, m.uid, m.folder, m.attachments, a.*, m.account_id
         FROM messages m JOIN email_accounts a ON a.id = m.account_id WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false`,
      [messageId, userId],
    );
    const row = rows[0];
    if (!row) return { status: 'done', note: 'message gone' };
    const list = calendarAttachments(row.attachments, { maxBytes: cfg['cards.icsMaxBytes'] }).filter((a) => a.part);
    if (list.length) {
      const account = { ...row, id: row.account_id };
      // Yields to mail sync and provider cooldowns like every other Hedwig IMAP fetch.
      const buffers = await guardedFetch(
        { imapManager, account, kind: ATTACHMENT_JOB, messageId: row.id },
        () => imapManager.fetchMultipleAttachments(account, row.uid, row.folder, list.map((a) => ({ part: a.part, encoding: a.encoding }))),
      );
      for (const a of list) {
        const buf = buffers.get(a.part);
        const error = !buf ? 'attachment part not returned by the server' : buf.length > cfg['cards.icsMaxBytes'] ? 'too large' : null;
        const text = error ? null : buf.toString('utf8').replace(/\0/g, '');
        await query(
          `INSERT INTO hedwig_card_parts (message_id, attachment_index, filename, mime, text, error, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (message_id, attachment_index) DO UPDATE SET filename = EXCLUDED.filename, mime = EXCLUDED.mime,
             text = EXCLUDED.text, error = EXCLUDED.error, fetched_at = NOW()`,
          [messageId, a.index, a.filename, a.mime, text, error],
        );
      }
    }
    await enqueue(CARDS_JOB, { userId, messageIds: [messageId] }, { userId, dedupeKey: `cards:ics:${messageId}`, priority: 7, maxAttempts: 3 });
    return { status: 'done', note: `${list.length} calendar part(s)` };
  };
}
