// Sorting service: what the /sort routes (and other modules) call. Every function takes the user
// id first and scopes every read and write to it.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { HEDWIG_HOOKS, runHedwigHook } from '../hooks.js';
import { validTimezone, startOfLocalDay } from '../insights/time.js';
import { goneSql } from '../triage/store.js';
import { trainUpstreamSpam } from '../triage/spamSync.js';
import { headerMap, senderKeys } from './headers.js';
import { recordCorrection } from './deps.js';
import { writeLog, getLog, markUndone, logSince } from './log.js';
import { setSenderDecision, revertSenderDecision, screenerList, decideFromScreener, streamOf } from './senders.js';
import { loadRules, createRule, updateRule, deleteRule, dryRun, parseGmailFilters, ruleForCorrection, matchingMessageIds } from './rules.js';
import { resortMessages } from './engine.js';
import { listBundles, createBundle, updateBundle, loadBundles } from './bundles.js';
import { cleanReason } from './reflex.js';
import { peopleFilterSql, withWorkRows } from '../work/lists.js';

export const STREAMS = Object.freeze(['people', 'reading', 'records', 'screener', 'spam']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ── Stream lists ────────────────────────────────────────────────────────────

export function encodeCursor(date, id) {
  return Buffer.from(JSON.stringify([date ? new Date(date).toISOString() : null, id])).toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [date, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!isUuid(id) || (date !== null && Number.isNaN(Date.parse(date)))) return null;
    return { date: date || '1970-01-01T00:00:00.000Z', id };
  } catch {
    return null;
  }
}

/**
 * One stream, newest thread first, one item per thread (its latest message in the stream).
 * @returns {{ items: Array, next: string|null }}
 */
export async function streamList(userId, stream, { cursor = null, needsYou = false, limit = 50, bundle = null, held = false } = {}) {
  if (!STREAMS.includes(stream)) throw httpError(400, `stream must be one of ${STREAMS.join(', ')}`);
  const n = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));
  const cur = cursor ? decodeCursor(cursor) : null;
  if (cursor && !cur) throw httpError(400, 'Invalid cursor');
  const cfg = await getConfig(userId);
  const params = [userId];
  const where = ['s.user_id = $1', 'NOT s.own', 'NOT m.is_deleted'];
  if (stream === 'spam') {
    params.push(cfg['spam.suspectedDays']);
    where.push(`(s.stream = 'spam' OR (s.in_spam_folder AND s.spam <> 'rescued')) AND (m.date IS NULL OR m.date > NOW() - make_interval(days => $${params.length}) OR s.stream = 'spam')`);
  } else {
    params.push(stream);
    where.push(`s.stream = $${params.length}`, `NOT ${goneSql('m', 'f')}`);
    if (!held) where.push('NOT s.held');
    if (stream === 'people') where.push(peopleFilterSql('m', 's')); // work: Done and snoozed threads leave People
  }
  if (needsYou) where.push('s.needs_you');
  if (bundle) { params.push(String(bundle)); where.push(`s.bundle = $${params.length}`); }
  let curSql = '';
  if (cur) {
    params.push(cur.date, cur.id);
    curSql = `WHERE (COALESCE(date, 'epoch'::timestamptz), id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(n + 1);
  const { rows } = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (m.account_id, COALESCE(m.thread_key, m.id::text))
              m.id, m.account_id, m.thread_key, m.from_name, m.from_email, m.subject, m.snippet, m.date, m.is_read,
              s.needs_you, s.needs_you_reason, s.reason, s.bundle, s.spam, s.spam_reason, s.layer, s.confidence, s.held, s.labels
         FROM hedwig_sort s
         JOIN messages m ON m.id = s.message_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE ${where.join(' AND ')}
        ORDER BY m.account_id, COALESCE(m.thread_key, m.id::text), m.date DESC NULLS LAST, m.id DESC)
     SELECT * FROM latest ${curSql}
      ORDER BY COALESCE(date, 'epoch'::timestamptz) DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  const out = {
    items: page.map((r) => ({
      threadId: r.thread_key || r.id,
      messageId: r.id,
      from: { name: r.from_name, email: r.from_email },
      subject: r.subject,
      snippet: r.snippet,
      date: r.date,
      needsYou: Boolean(r.needs_you),
      reason: (r.needs_you && r.needs_you_reason) || (stream === 'spam' ? r.spam_reason || r.reason : r.reason),
      bundle: r.bundle,
      accountId: r.account_id,
      unread: !r.is_read,
      spam: r.spam,
      layer: r.layer,
      confidence: r.confidence === null ? null : Number(r.confidence),
      held: Boolean(r.held),
      labels: r.labels || [],
    })),
    next: rows.length > n && last ? encodeCursor(last.date, last.id) : null,
  };
  // work: due reminders as rows on the first page, "Back from snooze" reasons.
  if (stream === 'people') out.items = await withWorkRows(userId, out.items, { first: !cur });
  return out;
}

// ── Screener ────────────────────────────────────────────────────────────────

export const screener = (userId) => screenerList(userId);

export async function decide(userId, body = {}) {
  const { key = null, scope = 'address', decision, all = false } = body;
  if (!key && !all) throw httpError(400, 'key is required (or all: true to accept every proposal)');
  if (key && !decision) throw httpError(400, 'decision is required');
  return decideFromScreener(userId, { key, scope, decision, all: all === true || all === 'true' });
}

// ── Corrections ─────────────────────────────────────────────────────────────

async function loadForCorrection(userId, messageId) {
  const { rows } = await query(
    `SELECT m.id, m.account_id, m.folder, m.subject, m.from_name, m.from_email, m.list_unsubscribe, m.to_addresses, m.cc_addresses,
            s.message_id AS s_id, s.stream, s.proposed_stream, s.bundle, s.needs_you, s.needs_you_reason, s.spam, s.spam_reason,
            s.layer, s.reason, s.confidence, s.prompt_id, s.prompt_version, s.model, s.sender_key, s.sender_scope, s.in_spam_folder
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN hedwig_sort s ON s.message_id = m.id AND s.user_id = a.user_id
      WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId],
  );
  return rows[0] || null;
}

const ALWAYS = new Set(['sender', 'list', 'kind']);

/**
 * The user corrects one message. Writes hedwig_corrections, hedwig_sort_log and, with `always`,
 * a rule (plus a sender decision for 'sender' / 'list').
 */
export async function correct(userId, body = {}) {
  const { messageId, stream, bundle, needsYou, spam, always = null, note = null } = body;
  if (!isUuid(messageId)) throw httpError(400, 'messageId must be a message id');
  if (stream !== undefined && !['people', 'reading', 'records', 'spam'].includes(stream)) throw httpError(400, 'stream must be people, reading, records or spam');
  if (spam !== undefined && !['clean', 'suspected', 'phishing'].includes(spam)) throw httpError(400, 'spam must be clean, suspected or phishing');
  if (needsYou !== undefined && typeof needsYou !== 'boolean') throw httpError(400, 'needsYou must be true or false');
  if (always !== null && always !== undefined && !ALWAYS.has(always)) throw httpError(400, "always must be 'sender', 'list', 'kind' or null");
  if (stream === undefined && bundle === undefined && needsYou === undefined && spam === undefined) throw httpError(400, 'nothing to correct');
  const row = await loadForCorrection(userId, messageId);
  if (!row) throw httpError(404, 'Message not found');
  let bundleKey = bundle === undefined ? undefined : (bundle ? String(bundle) : null);
  if (bundleKey) {
    const bundles = await loadBundles(userId);
    if (!bundles.some((b) => b.key === bundleKey)) throw httpError(400, `unknown bundle "${bundleKey}"`);
  }
  const before = {
    stream: row.stream || null, bundle: row.bundle || null, needsYou: Boolean(row.needs_you), spam: row.spam || 'clean',
    layer: row.layer || null, reason: row.reason || null, confidence: row.confidence ?? null,
    from: row.from_email, subject: row.subject,
  };
  const after = { ...before };
  if (stream !== undefined) after.stream = stream;
  if (bundleKey !== undefined) {
    after.bundle = bundleKey;
    if (bundleKey && stream === undefined && !['reading', 'records'].includes(after.stream)) {
      after.stream = (await loadBundles(userId)).find((b) => b.key === bundleKey)?.stream || 'records';
    }
  }
  if (needsYou !== undefined) after.needsYou = needsYou;
  if (spam !== undefined) after.spam = spam;
  if (after.stream === 'spam' && after.spam === 'clean' && spam === undefined) after.spam = 'suspected';
  if (after.spam === 'clean' && before.stream === 'spam' && stream === undefined) after.stream = row.proposed_stream || 'people';
  if (after.spam !== 'clean' && spam !== undefined && stream === undefined) after.stream = 'spam';
  if (!['reading', 'records'].includes(after.stream)) after.bundle = null;
  if (after.stream === 'spam') after.needsYou = false;
  if (after.spam === 'clean' && row.in_spam_folder) after.spam = 'rescued';

  const what = [];
  if (after.stream !== before.stream) what.push(`moved to ${cap(after.stream)}`);
  if (after.bundle !== before.bundle && after.bundle) what.push(`bundled as ${after.bundle}`);
  if (after.needsYou !== before.needsYou) what.push(after.needsYou ? 'marked as needing you' : 'marked as not needing you');
  if (after.spam !== before.spam) what.push(after.spam === 'clean' || after.spam === 'rescued' ? 'marked not spam' : `marked ${after.spam}`);
  const reason = cleanReason(`You ${what.join(', ') || 'confirmed this'}`);

  const keys = senderKeys(row, headerMap(row));
  // "Everything from this list" needs a List-Id; without one it would quietly become a domain rule.
  if (always === 'list' && !keys.list) throw httpError(400, 'This message did not come from a mailing list; choose the sender or the kind instead');
  const screenKey = keys.list ? { key: keys.list, scope: 'list' } : keys.address ? { key: keys.address, scope: 'address' } : { key: null, scope: null };
  await query(
    `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, proposed_stream, bundle, held, needs_you, needs_you_reason, spam, spam_reason,
                              confidence, layer, reason, signals, sender_key, sender_scope, in_spam_folder, decided_at, body_seen)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, 1, 'user', $11, $12, $13, $14, $15, NOW(), false)
     ON CONFLICT (message_id) DO UPDATE SET stream = EXCLUDED.stream, proposed_stream = COALESCE(EXCLUDED.proposed_stream, hedwig_sort.proposed_stream),
       bundle = EXCLUDED.bundle, held = false, needs_you = EXCLUDED.needs_you,
       needs_you_reason = CASE WHEN EXCLUDED.needs_you THEN COALESCE(hedwig_sort.needs_you_reason, EXCLUDED.needs_you_reason) ELSE NULL END,
       spam = EXCLUDED.spam, spam_reason = EXCLUDED.spam_reason, confidence = 1, layer = 'user', reason = EXCLUDED.reason,
       signals = jsonb_build_array(jsonb_build_object('name', 'user', 'label', EXCLUDED.reason, 'weight', 1)) || hedwig_sort.signals,
       decided_at = NOW()
     WHERE hedwig_sort.user_id = EXCLUDED.user_id`,
    [messageId, userId, row.account_id, after.stream || 'people', ['people', 'reading', 'records'].includes(after.stream) ? after.stream : null,
      after.bundle, Boolean(after.needsYou), after.needsYou ? 'You marked this as needing you' : null, after.spam,
      after.spam !== before.spam ? reason : row.spam_reason || null, reason,
      JSON.stringify([{ name: 'user', label: reason, weight: 1 }]), screenKey.key, screenKey.scope, Boolean(row.in_spam_folder)],
  );

  const kind = after.spam !== before.spam ? 'spam' : 'sort';
  const correction = await recordCorrection({
    userId, kind, targetId: messageId, before, after, note: note ? String(note).slice(0, 500) : null,
    promptId: row.prompt_id || null, promptVersion: row.prompt_version || null,
  });

  let rule = null;
  let senderDecision = null;
  const resorted = new Set();
  if (always) {
    const body2 = ruleForCorrection({ always, row, keys, after: { stream: after.stream, bundle: after.bundle }, before });
    if (body2) rule = await createRule(userId, body2, { source: 'correction', correctionId: correction?.id ?? null });
    const target = always === 'sender' && keys.address ? { key: keys.address, scope: 'address' } : always === 'list' && keys.list ? { key: keys.list, scope: 'list' } : null;
    if (target && after.stream) {
      const decision = after.stream === 'spam' ? 'block' : after.stream;
      const res = await setSenderDecision(userId, { ...target, decision, source: 'user', confidence: 1, messageId, log: false, all: true });
      for (const id of res.moved) resorted.add(id);
      senderDecision = res.decision ? { id: res.decision.id, previous: res.previous ? { decision: res.previous.decision, source: res.previous.source, confidence: res.previous.confidence, reason: res.previous.reason } : null, ...target, decision } : null;
    }
    // "Always" means the mail already here too: re-sort what the new rule matches (never the
    // messages the user corrected by hand).
    if (rule) {
      const ids = await matchingMessageIds(rule, userId, { limit: 1000 });
      if (ids.length) await resortMessages(userId, ids, { allowReflex: false });
      for (const id of ids) resorted.add(id);
    }
  }

  const spamChanged = (before.spam === 'clean' || before.spam === 'rescued') !== (after.spam === 'clean' || after.spam === 'rescued');
  if (spamChanged) {
    await trainUpstreamSpam(userId, messageId, after.spam === 'clean' || after.spam === 'rescued' ? 'ham' : 'spam')
      .catch((err) => console.warn(`[hedwig] sort: upstream spam training failed for ${messageId}:`, err.message));
  }

  const log = await writeLog(userId, {
    messageId, action: 'correct', from: before,
    to: { ...after, always, ruleId: rule?.id || null, correctionId: correction?.id ?? null, senderDecision, resorted: [...resorted].filter((x) => x !== messageId).slice(0, 500) },
    by: 'user',
  });
  runHedwigHook(HEDWIG_HOOKS.afterSort, { userId, messageId, sort: { stream: after.stream, bundle: after.bundle, needsYou: after.needsYou, spam: after.spam, layer: 'user', reason, confidence: 1 } }).catch(() => {});
  return { sort: { ...after, layer: 'user', reason }, correctionId: correction?.id ?? null, ruleId: rule?.id || null, rule, logId: log.id };
}

// ── Today and undo ──────────────────────────────────────────────────────────

function logText(e) {
  const to = e.to || {};
  const subject = e.subject ? `“${e.subject}”` : 'a message';
  switch (e.action) {
    case 'screen': return `Screened ${to.key} into ${cap(to.decision)}`;
    case 'decide': return `You put ${to.key} in ${cap(to.decision)}`;
    case 'block': return `You blocked ${to.key}`;
    case 'correct': return `You corrected ${subject}${to.stream ? ` → ${cap(to.stream)}` : ''}`;
    case 'rescue': return `Rescued ${subject} from spam`;
    case 'spam_move': return `Moved ${subject} to Junk`;
    case 'deliver': return `Delivered ${to.count} in ${to.name || to.bundle}`;
    default: return e.action;
  }
}

const UNDOABLE = new Set(['screen', 'decide', 'block', 'correct', 'rescue', 'spam_move']);

export async function today(userId, { now = new Date() } = {}) {
  const cfg = await getConfig(userId);
  const since = startOfLocalDay(now, validTimezone(cfg['insights.timezone']));
  const [entries, bundled] = await Promise.all([
    logSince(userId, since),
    query('SELECT COUNT(*)::int AS n FROM hedwig_sort WHERE user_id = $1 AND bundle IS NOT NULL AND NOT own AND decided_at >= $2', [userId, since]),
  ]);
  const live = entries.filter((e) => !e.undone_at);
  return {
    since,
    screened: live.filter((e) => e.action === 'screen').length,
    bundled: bundled.rows[0].n,
    rescued: live.filter((e) => e.action === 'rescue').length,
    blocked: live.filter((e) => e.action === 'block' || (e.action === 'screen' && e.to?.decision === 'block')).length,
    entries: entries.map((e) => ({
      id: Number(e.id), action: e.action, messageId: e.message_id, subject: e.subject || null,
      from: e.from_email ? { name: e.from_name, email: e.from_email } : null,
      before: e.from, after: e.to, by: e.by, undone: Boolean(e.undone_at), undoable: UNDOABLE.has(e.action) && !e.undone_at,
      text: logText(e), createdAt: e.created_at,
    })),
  };
}

export async function undo(userId, { logId } = {}) {
  const id = Number.parseInt(logId, 10);
  if (!Number.isFinite(id)) throw httpError(400, 'logId is required');
  const entry = await getLog(userId, id);
  if (!entry) throw httpError(404, 'Log entry not found');
  if (entry.undone_at) throw httpError(409, 'Already undone');
  if (!UNDOABLE.has(entry.action)) throw httpError(400, `A ${entry.action} entry cannot be undone`);
  const from = entry.from || {};
  const to = entry.to || {};
  let result = {};
  switch (entry.action) {
    case 'screen':
    case 'decide':
    case 'block':
      result = await revertSenderDecision(userId, entry);
      break;
    case 'correct': {
      await query(
        `UPDATE hedwig_sort SET stream = $3, bundle = $4, needs_you = $5, spam = $6, layer = COALESCE($7, 'classifier'), reason = $8,
                confidence = $9, held = false, decided_at = NOW()
          WHERE message_id = $1 AND user_id = $2`,
        [entry.message_id, userId, from.stream || 'people', from.bundle || null, Boolean(from.needsYou), from.spam || 'clean',
          from.layer === 'user' ? 'user' : from.layer, from.reason || null, from.confidence ?? null],
      );
      if (to.ruleId) await query('DELETE FROM hedwig_rules WHERE id = $1 AND user_id = $2', [to.ruleId, userId]);
      if (to.senderDecision?.id) {
        await revertSenderDecision(userId, {
          to: { key: to.senderDecision.key, scope: to.senderDecision.scope, decisionId: to.senderDecision.id, messageIds: [] },
          from: to.senderDecision.previous,
        });
      }
      // Mail the "always" moved goes back through the layers without the rule or decision.
      const others = Array.isArray(to.resorted) ? to.resorted : [];
      if (others.length) await resortMessages(userId, others);
      result = { restored: from.stream, resorted: others.length };
      break;
    }
    case 'rescue':
      await query(
        `UPDATE hedwig_sort SET spam = 'suspected', stream = 'spam', bundle = NULL, reason = 'Your provider filed this as spam', decided_at = NOW()
          WHERE message_id = $1 AND user_id = $2 AND layer <> 'user'`,
        [entry.message_id, userId],
      );
      result = { restored: 'spam' };
      break;
    case 'spam_move':
      await enqueue('sort.spamMove', { messageId: entry.message_id, to: 'restore', folder: from.folder || 'INBOX' },
        { userId, dedupeKey: `sort.spamMove.restore:${entry.message_id}`, maxAttempts: 3 });
      result = { restoring: from.folder || 'INBOX' };
      break;
    default:
      break;
  }
  await markUndone(userId, id);
  return { undone: true, logId: id, ...result };
}

// ── Bundles and rules ───────────────────────────────────────────────────────

export const bundles = (userId) => listBundles(userId);
export const addBundle = (userId, body = {}) => createBundle(userId, body);
export async function changeBundle(userId, id, body = {}) {
  if (!isUuid(id)) throw httpError(400, 'Invalid bundle id');
  return { bundle: await updateBundle(userId, id, body) };
}

export async function rules(userId) {
  return { rules: await loadRules(userId, { enabledOnly: false }), max: (await getConfig(userId))['rules.maxPerUser'] };
}
export async function addRule(userId, body = {}) {
  return { rule: await createRule(userId, body, { source: 'user' }) };
}
export async function changeRule(userId, id, body = {}) {
  if (!isUuid(id)) throw httpError(400, 'Invalid rule id');
  return { rule: await updateRule(userId, id, body) };
}
export async function removeRule(userId, id) {
  if (!isUuid(id)) throw httpError(400, 'Invalid rule id');
  return deleteRule(userId, id);
}

/** Dry-run a saved rule (optionally with edits in the body) against history. */
export async function dryRunRule(userId, id, body = {}) {
  let rule;
  if (id === 'draft') rule = body;
  else {
    if (!isUuid(id)) throw httpError(400, 'Invalid rule id');
    const { rows } = await query('SELECT * FROM hedwig_rules WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!rows[0]) throw httpError(404, 'Rule not found');
    rule = { ...rows[0], ...(body?.conditions ? { conditions: body.conditions } : {}), ...(body?.actions ? { actions: body.actions } : {}) };
  }
  return dryRun(rule, userId, { limit: body?.limit });
}

/** Gmail filter XML import (from/to/subject/label only). `preview: true` parses without saving. */
export async function importGmail(userId, { xml, preview = false } = {}) {
  if (!xml || typeof xml !== 'string') throw httpError(400, 'xml is required');
  if (xml.length > 2_000_000) throw httpError(413, 'Filter file too large');
  const parsed = parseGmailFilters(xml);
  if (preview) return parsed;
  const created = [];
  for (const r of parsed.rules) created.push(await createRule(userId, r, { source: 'import' }));
  return { created: created.length, rules: created, skipped: parsed.skipped };
}

// ── Why ─────────────────────────────────────────────────────────────────────

export async function why(userId, messageId) {
  if (!isUuid(messageId)) throw httpError(400, 'Invalid message id');
  const { rows } = await query(
    `SELECT s.*, r.name AS rule_name, r.conditions AS rule_conditions, r.actions AS rule_actions
       FROM hedwig_sort s LEFT JOIN hedwig_rules r ON r.id = s.rule_id AND r.user_id = s.user_id
      WHERE s.message_id = $1 AND s.user_id = $2`,
    [messageId, userId],
  );
  const s = rows[0];
  if (!s) throw httpError(404, 'Message not sorted yet');
  const { rows: sd } = s.sender_key
    ? await query('SELECT key, scope, decision, source, confidence, reason, decided_at FROM hedwig_senders WHERE user_id = $1 AND scope = $2 AND key = $3 AND undone_at IS NULL', [userId, s.sender_scope, s.sender_key])
    : { rows: [] };
  return {
    layer: s.layer,
    reason: s.reason,
    confidence: s.confidence === null ? null : Number(s.confidence),
    signals: s.signals || [],
    ...(s.rule_id ? { rule: { id: s.rule_id, name: s.rule_name, conditions: s.rule_conditions, actions: s.rule_actions } } : {}),
    promptId: s.prompt_id,
    promptVersion: s.prompt_version,
    model: s.model,
    stream: s.stream,
    proposedStream: s.proposed_stream,
    bundle: s.bundle,
    held: s.held,
    needsYou: s.needs_you,
    needsYouReason: s.needs_you_reason,
    spam: s.spam,
    spamReason: s.spam_reason,
    labels: s.labels || [],
    senderDecision: sd[0] || null,
    decidedAt: s.decided_at,
    bodySeen: s.body_seen,
  };
}

export { streamOf };
