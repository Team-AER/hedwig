// Sender decisions (hedwig_senders) and the Screener. A sender with no decision has its recent mail
// held in the Screener with a proposal; the user decides, or auto-screen decides confident ones.
// "Always in": anyone the user has written to (seeded from history, then kept up from new sent
// mail), their contacts, and replies to the user's own threads (handled per message by headers.js).
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { getState, setState } from '../state.js';
import { addressesOf } from '../text.js';
import { outgoingSql } from '../triage/store.js';
import { runSortPrompt } from './deps.js';
import { writeLog } from './log.js';
import { historyLine } from './reflex.js';

export const DECISIONS = Object.freeze(['people', 'reading', 'records', 'block']);
export const SCOPES = Object.freeze(['address', 'domain', 'list']);
const SOURCE_RANK = { user: 3, rule: 2, import: 1, auto: 0 };
const EMAIL_RE = /^[^\s@<>]{1,200}@[^\s@<>]{1,200}\.[^\s@<>]{1,63}$/;
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export const streamOf = (decision) => (decision === 'block' ? 'spam' : decision);
export const decisionKey = (scope, key) => `${scope}|${key}`;

export function validKey(scope, key) {
  const k = String(key || '').trim().toLowerCase();
  if (scope === 'address') return EMAIL_RE.test(k) ? k : null;
  if (scope === 'domain') return DOMAIN_RE.test(k) ? k : null;
  if (scope === 'list') return k && k.length <= 200 && !/\s/.test(k) ? k : null;
  return null;
}

/** Active decisions for the given keys, as Map('scope|key' → row). */
export async function loadDecisions(userId, keysList) {
  const tuples = new Map();
  for (const k of keysList) {
    if (k.address) tuples.set(decisionKey('address', k.address), ['address', k.address]);
    if (k.list) tuples.set(decisionKey('list', k.list), ['list', k.list]);
    if (k.domain) tuples.set(decisionKey('domain', k.domain), ['domain', k.domain]);
  }
  if (!tuples.size) return new Map();
  const vals = [...tuples.values()];
  const { rows } = await query(
    `SELECT s.* FROM hedwig_senders s JOIN UNNEST($2::text[], $3::text[]) AS k(scope, key) ON k.scope = s.scope AND k.key = s.key
      WHERE s.user_id = $1 AND s.undone_at IS NULL`,
    [userId, vals.map((v) => v[0]), vals.map((v) => v[1])],
  );
  return new Map(rows.map((r) => [decisionKey(r.scope, r.key), r]));
}

/** The decision that applies to a message: address, then list, then domain. */
export function pickDecision(keys, decisions) {
  for (const [scope, key] of [['address', keys.address], ['list', keys.list], ['domain', keys.domain]]) {
    if (!key) continue;
    const d = decisions.get(decisionKey(scope, key));
    if (d) return d;
  }
  return null;
}

async function activeDecision(userId, scope, key) {
  const { rows } = await query('SELECT * FROM hedwig_senders WHERE user_id = $1 AND scope = $2 AND key = $3 AND undone_at IS NULL', [userId, scope, key]);
  return rows[0] || null;
}

function matchSql(scope, param) {
  if (scope === 'address') return `lower(m.from_email) = ${param}`;
  if (scope === 'domain') return `(split_part(lower(m.from_email), '@', 2) = ${param} OR split_part(lower(m.from_email), '@', 2) LIKE '%.' || ${param})`;
  return `(s.sender_scope = 'list' AND s.sender_key = ${param})`;
}

/**
 * Move a sender's mail to where a decision puts it. Default: only mail held in the Screener;
 * `all`: every message from the sender that the user has not corrected by hand.
 * @returns {Promise<string[]>} message ids that moved
 */
export async function applyDecisionToMessages(userId, { scope, key, decision, reason = null, confidence = 1 }, { all = false } = {}) {
  const stream = streamOf(decision);
  const { rows } = await query(
    `UPDATE hedwig_sort s SET
        stream = $3,
        proposed_stream = CASE WHEN $3 = 'spam' THEN s.proposed_stream ELSE $3 END,
        bundle = CASE WHEN $3 IN ('reading','records') THEN s.bundle ELSE NULL END,
        needs_you = CASE WHEN $3 = 'spam' THEN false ELSE s.needs_you END,
        held = $3 IN ('reading','records') AND EXISTS (
          SELECT 1 FROM hedwig_bundles b WHERE b.user_id = s.user_id AND b.key = s.bundle AND b.enabled AND b.schedule->>'mode' IN ('daily','weekly')),
        layer = 'rule', reason = COALESCE($4, s.reason), confidence = $5, decided_at = NOW()
       FROM messages m
      WHERE m.id = s.message_id AND s.user_id = $1 AND NOT s.own AND s.layer <> 'user'
        AND ${all ? 'TRUE' : "s.stream = 'screener'"}
        AND ${matchSql(scope, '$2')}
      RETURNING s.message_id`,
    [userId, key, stream, reason, confidence],
  );
  return rows.map((r) => r.message_id);
}

/**
 * Record a sender decision. A user decision is never replaced by an automatic one. The previous
 * decision (if any) is stamped undone and kept so the log entry can restore it.
 * @returns {Promise<{ decision: object|null, previous: object|null, moved: string[], log: object|null, skipped?: string }>}
 */
export async function setSenderDecision(userId, { key, scope, decision, source = 'user', confidence = null, reason = null, messageId = null, all = false, log = true }) {
  if (!SCOPES.includes(scope)) throw httpError(400, `scope must be one of ${SCOPES.join(', ')}`);
  if (!DECISIONS.includes(decision)) throw httpError(400, `decision must be one of ${DECISIONS.join(', ')}`);
  const k = validKey(scope, key);
  if (!k) throw httpError(400, `Invalid ${scope} key`);
  const current = await activeDecision(userId, scope, k);
  if (current && SOURCE_RANK[current.source] > SOURCE_RANK[source]) return { decision: current, previous: null, moved: [], log: null, skipped: `${current.source} decision stands` };
  let row = current;
  if (!current || current.decision !== decision || current.source !== source) {
    if (current) await query('UPDATE hedwig_senders SET undone_at = NOW() WHERE id = $1 AND undone_at IS NULL', [current.id]);
    const conf = confidence === null || confidence === undefined ? (source === 'user' ? 1 : null) : Math.max(0, Math.min(1, Number(confidence)));
    const { rows } = await query(
      `INSERT INTO hedwig_senders (user_id, key, scope, decision, source, confidence, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, scope, key) WHERE undone_at IS NULL DO UPDATE SET
         decision = EXCLUDED.decision, source = EXCLUDED.source, confidence = EXCLUDED.confidence, reason = EXCLUDED.reason, decided_at = NOW()
       RETURNING *`,
      [userId, k, scope, decision, source, conf, reason ? String(reason).slice(0, 200) : null],
    );
    row = rows[0];
  }
  const label = source === 'user' ? (decision === 'block' ? 'You blocked this sender' : `You put this sender in ${cap(decision)}`) : reason || `Screened into ${cap(decision)}`;
  const moved = await applyDecisionToMessages(userId, { scope, key: k, decision, reason: label, confidence: row.confidence ?? 1 }, { all });
  await query('DELETE FROM hedwig_sender_proposals WHERE user_id = $1 AND scope = $2 AND key = $3', [userId, scope, k]);
  let entry = null;
  if (log && (source !== 'import' || moved.length)) {
    const action = source === 'user' ? (decision === 'block' ? 'block' : 'decide') : 'screen';
    // The message that triggered the decision is part of what it moved even when it has no
    // hedwig_sort row yet (auto-screen decides before the triggering message is stored), so undo
    // sends it back to the Screener with the rest.
    const affected = messageId && !moved.includes(messageId) ? [messageId, ...moved] : moved;
    entry = await writeLog(userId, {
      messageId,
      action,
      from: current ? { decision: current.decision, source: current.source, confidence: current.confidence, reason: current.reason, decisionId: current.id } : null,
      to: { key: k, scope, decision, source, confidence: row.confidence, reason: row.reason, decisionId: row.id, messageIds: affected.slice(0, 500) },
      by: source === 'user' ? 'user' : source === 'rule' ? 'rule' : 'auto',
    });
  }
  return { decision: row, previous: current, moved, log: entry };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Undo a sender decision from its log entry: restore the previous one, or send mail back to the Screener. */
export async function revertSenderDecision(userId, entry) {
  const to = entry.to || {};
  const from = entry.from;
  if (to.decisionId) await query('UPDATE hedwig_senders SET undone_at = NOW() WHERE id = $1 AND user_id = $2 AND undone_at IS NULL', [to.decisionId, userId]);
  if (from?.decision) {
    const { rows } = await query(
      `INSERT INTO hedwig_senders (user_id, key, scope, decision, source, confidence, reason) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, scope, key) WHERE undone_at IS NULL DO NOTHING RETURNING *`,
      [userId, to.key, to.scope, from.decision, from.source || 'user', from.confidence ?? null, from.reason || null],
    );
    if (rows[0]) await applyDecisionToMessages(userId, { scope: to.scope, key: to.key, decision: from.decision, reason: from.reason, confidence: from.confidence ?? 1 }, { all: true });
    return { restored: from.decision };
  }
  const ids = Array.isArray(to.messageIds) ? to.messageIds : [];
  if (ids.length) {
    await query(
      `UPDATE hedwig_sort SET proposed_stream = CASE WHEN stream IN ('people','reading','records') THEN stream ELSE proposed_stream END,
              stream = 'screener', held = false, reason = 'Waiting for you to screen this sender', decided_at = NOW()
        WHERE user_id = $1 AND message_id = ANY($2::uuid[]) AND layer <> 'user'`,
      [userId, ids],
    );
  }
  return { restored: 'screener', messages: ids.length };
}

// ── Always in ───────────────────────────────────────────────────────────────

function recipientsOf(rows, userAddresses) {
  const out = new Map();
  for (const r of rows) {
    for (const a of [...addressesOf(r.to_addresses), ...addressesOf(r.cc_addresses)]) {
      if (!a.email || userAddresses.has(a.email)) continue;
      out.set(a.email, (out.get(a.email) || 0) + 1);
    }
  }
  return out;
}

async function bulkPeople(userId, emails, { source, confidence, reason }) {
  const list = [...new Set(emails)].filter((e) => EMAIL_RE.test(e));
  if (!list.length) return 0;
  const { rowCount } = await query(
    `INSERT INTO hedwig_senders (user_id, key, scope, decision, source, confidence, reason)
     SELECT $1, e, 'address', 'people', $3, $4, $5 FROM UNNEST($2::text[]) AS e
     ON CONFLICT (user_id, scope, key) WHERE undone_at IS NULL DO NOTHING`,
    [userId, list, source, confidence, reason],
  );
  return rowCount || 0;
}

/**
 * First run for an account: everyone the user has written to becomes People (source import), and
 * so does everyone in their contacts (once per user).
 */
export async function ensureSeeded(userId, accountIds, userAddresses) {
  let seeded = 0;
  for (const accountId of accountIds) {
    const key = `sort.seeded:${accountId}`;
    if ((await getState(key, null))?.at) continue;
    const { rows } = await query(
      `SELECT DISTINCT lower(COALESCE(r->>'address', r->>'email', r #>> '{}')) AS email
         FROM messages m
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(m.to_addresses) = 'array' THEN m.to_addresses ELSE '[]'::jsonb END
           || CASE WHEN jsonb_typeof(m.cc_addresses) = 'array' THEN m.cc_addresses ELSE '[]'::jsonb END) AS r
        WHERE m.account_id = $1 AND NOT m.is_deleted AND ${outgoingSql('m', 'f', '$2')}
        LIMIT 20000`,
      [accountId, [...userAddresses]],
    );
    const emails = rows.map((r) => r.email).filter((e) => e && !userAddresses.has(e));
    seeded += await bulkPeople(userId, emails, { source: 'import', confidence: 0.95, reason: 'You have written to them' });
    await setState(key, { at: new Date().toISOString(), count: emails.length });
  }
  const ckey = `sort.contactsSeeded:${userId}`;
  if (!(await getState(ckey, null))?.at) {
    let emails = [];
    try {
      const { rows } = await query(
        `SELECT DISTINCT lower(e) AS email FROM (
           SELECT primary_email AS e FROM contacts WHERE user_id = $1 AND primary_email IS NOT NULL
           UNION ALL
           SELECT x->>'value' FROM contacts c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.emails) = 'array' THEN c.emails ELSE '[]'::jsonb END) x
            WHERE c.user_id = $1) q WHERE e IS NOT NULL`,
        [userId],
      );
      emails = rows.map((r) => r.email).filter((e) => e && !userAddresses.has(e));
    } catch (err) {
      console.warn(`[hedwig] sort: could not read contacts for ${userId}:`, err.message);
    }
    seeded += await bulkPeople(userId, emails, { source: 'import', confidence: 0.95, reason: 'In your contacts' });
    await setState(ckey, { at: new Date().toISOString(), count: emails.length });
  }
  return seeded;
}

/**
 * New outgoing mail: its recipients are People. Automatic and imported decisions that said
 * otherwise are replaced; the user's own decisions are left alone. Held mail from them is released.
 */
export async function recordWrittenTo(userId, outgoingRows, userAddresses) {
  const recips = recipientsOf(outgoingRows, userAddresses);
  if (!recips.size) return 0;
  const decisions = await loadDecisions(userId, [...recips.keys()].map((address) => ({ address })));
  let changed = 0;
  for (const email of recips.keys()) {
    if (!EMAIL_RE.test(email)) continue;
    const d = decisions.get(decisionKey('address', email));
    if (d && (d.source === 'user' || d.decision === 'people')) continue;
    const res = await setSenderDecision(userId, { key: email, scope: 'address', decision: 'people', source: 'auto', confidence: 1, reason: 'You wrote to them', log: Boolean(d) });
    if (!res.skipped) changed++;
  }
  return changed;
}

// ── Screener ────────────────────────────────────────────────────────────────

/** Senders with mail held in the Screener (and rescued spam from undecided senders). */
export async function screenerSenders(userId, { limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT s.sender_key AS key, s.sender_scope AS scope, COUNT(*)::int AS count, MAX(m.date) AS last_date,
            (array_agg(m.id ORDER BY m.date DESC NULLS LAST))[1] AS last_message_id,
            (array_agg(m.from_name ORDER BY m.date DESC NULLS LAST))[1] AS display,
            (array_agg(lower(m.from_email) ORDER BY m.date DESC NULLS LAST))[1] AS address,
            (array_agg(m.subject ORDER BY m.date DESC NULLS LAST))[1:3] AS subjects,
            bool_or(s.in_spam_folder) AS in_spam,
            mode() WITHIN GROUP (ORDER BY s.proposed_stream) AS layer_proposal,
            AVG(s.confidence)::real AS layer_confidence,
            (array_agg(s.reason ORDER BY s.confidence DESC NULLS LAST))[1] AS layer_reason,
            p.proposed, p.confidence AS p_confidence, p.reason AS p_reason, p.source AS p_source
       FROM hedwig_sort s
       JOIN messages m ON m.id = s.message_id
       LEFT JOIN hedwig_sender_proposals p ON p.user_id = s.user_id AND p.scope = s.sender_scope AND p.key = s.sender_key
      WHERE s.user_id = $1 AND s.stream = 'screener' AND NOT m.is_deleted AND s.sender_key IS NOT NULL
      GROUP BY s.sender_key, s.sender_scope, p.proposed, p.confidence, p.reason, p.source
      ORDER BY MAX(m.date) DESC NULLS LAST
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function screenerList(userId) {
  const rows = await screenerSenders(userId);
  return {
    senders: rows.map((r) => ({
      key: r.key,
      scope: r.scope,
      display: r.display || r.address,
      address: r.address,
      count: r.count,
      proposed: r.proposed || r.layer_proposal || 'records',
      confidence: r.p_confidence ?? r.layer_confidence ?? null,
      reason: r.p_reason || r.layer_reason || null,
      proposalSource: r.proposed ? r.p_source : 'layers',
      inSpam: Boolean(r.in_spam),
      lastMessageId: r.last_message_id,
      lastDate: r.last_date,
      subjects: (r.subjects || []).filter(Boolean),
    })),
  };
}

/**
 * Screener decision from the UI. `all: true` with no key accepts every current proposal; with a
 * key it also re-sorts the sender's older, already-sorted mail.
 */
export async function decideFromScreener(userId, { key, scope, decision, all = false }) {
  if (!key && all) {
    const { senders } = await screenerList(userId);
    const out = [];
    for (const s of senders) out.push(await setSenderDecision(userId, { key: s.key, scope: s.scope, decision: s.proposed, source: 'user', confidence: 1 }));
    return { decided: out.length, moved: out.reduce((n, r) => n + r.moved.length, 0), logIds: out.map((r) => r.log?.id).filter(Boolean) };
  }
  const res = await setSenderDecision(userId, { key, scope: scope || 'address', decision, source: 'user', confidence: 1, all: Boolean(all) });
  return { decided: 1, moved: res.moved.length, decision: res.decision, logId: res.log?.id || null };
}

async function statsFor(userId, emails) {
  if (!emails.length) return new Map();
  const { rows } = await query('SELECT * FROM hedwig_sender_stats WHERE user_id = $1 AND sender_email = ANY($2::text[])', [userId, emails]);
  return new Map(rows.map((r) => [r.sender_email, r]));
}

/**
 * Refresh proposals for held senders: aggregate the message layers, ask sort.screener about the
 * unsure ones (when a model is available) and auto-screen the confident ones when allowed.
 */
export async function refreshProposals(userId, { useModel = true, user = null } = {}) {
  const cfg = await getConfig(userId);
  const rows = await screenerSenders(userId, { limit: 100 });
  if (!rows.length) return { proposed: 0, screened: 0 };
  const stats = await statsFor(userId, rows.map((r) => r.address).filter(Boolean));
  const unsure = [];
  let screened = 0;
  for (const r of rows) {
    const conf = r.p_confidence ?? r.layer_confidence ?? 0;
    const proposed = r.proposed || r.layer_proposal;
    // Auto-screen never blocks: blocking is always the user's call.
    if (proposed && proposed !== 'block' && cfg['sort.autoScreen'] && conf >= cfg['sort.autoScreenAbove'] && !r.in_spam) {
      const res = await setSenderDecision(userId, { key: r.key, scope: r.scope, decision: proposed, source: 'auto', confidence: conf, reason: r.p_reason || r.layer_reason });
      if (!res.skipped) screened++;
      continue;
    }
    if (r.p_source !== 'screener') unsure.push(r);
  }
  let proposedCount = 0;
  if (useModel && unsure.length) {
    const senders = unsure.slice(0, 20).map((r) => ({
      key: r.key, scope: r.scope, display: r.display, count: r.count, inSpam: r.in_spam,
      history: historyLine(stats.get(r.address)),
      layers: r.layer_proposal ? `${r.layer_proposal} (${Math.round((r.layer_confidence || 0) * 100)}%): ${r.layer_reason || ''}` : null,
      subjects: (r.subjects || []).filter(Boolean).slice(0, 3),
    }));
    try {
      const { data, provenance } = await runSortPrompt('sort.screener', { user, senders }, { userId, lane: 'background' });
      const byKey = new Map(unsure.map((r) => [r.key, r]));
      for (const s of data?.senders || []) {
        const r = byKey.get(String(s.key || '').toLowerCase()) || byKey.get(s.key);
        if (!r || !DECISIONS.includes(s.proposed)) continue;
        const conf = Math.max(0, Math.min(1, Number(s.confidence) > 1 ? Number(s.confidence) / 100 : Number(s.confidence) || 0));
        const reason = String(s.reason || '').replace(/\s+/g, ' ').trim().slice(0, 90) || null;
        await query(
          `INSERT INTO hedwig_sender_proposals (user_id, key, scope, proposed, confidence, reason, source, prompt_version, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'screener', $7, NOW())
           ON CONFLICT (user_id, scope, key) DO UPDATE SET proposed = EXCLUDED.proposed, confidence = EXCLUDED.confidence,
             reason = EXCLUDED.reason, source = EXCLUDED.source, prompt_version = EXCLUDED.prompt_version, updated_at = NOW()`,
          [userId, r.key, r.scope, s.proposed, conf, reason, provenance?.promptVersion || null],
        );
        proposedCount++;
        if (cfg['sort.autoScreen'] && conf >= cfg['sort.autoScreenAbove'] && !r.in_spam && s.proposed !== 'block') {
          const res = await setSenderDecision(userId, { key: r.key, scope: r.scope, decision: s.proposed, source: 'auto', confidence: conf, reason });
          if (!res.skipped) screened++;
        }
      }
    } catch (err) {
      if (err?.code !== 'llm_disabled' && err?.code !== 'budget_exceeded') console.warn(`[hedwig] sort: screener proposals failed for ${userId}:`, err.message);
    }
  }
  return { proposed: proposedCount, screened };
}
