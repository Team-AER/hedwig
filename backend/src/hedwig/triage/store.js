// SQL shared by the triage step, schedules, jobs and the service. Every query that reads or writes
// per-user data takes the user id and filters on it; nothing here trusts a message id on its own.
import { query } from '../../services/db.js';
import { deadlineLabel } from './signals.js';

/** SQL: message `m` (with folder `f`) was sent by the user. `p` is a text[] of the user's addresses. */
// Null-safe on purpose: most folders have no special_use, and NOT (NULL OR false) would drop them.
export const outgoingSql = (m, f, p) => `(COALESCE(${f}.special_use, '') = '\\Sent' OR COALESCE(lower(${m}.from_email) = ANY(${p}::text[]), false))`;

/** SQL: message `m` (with folder `f`) has left the inbox: deleted, archived, trashed or junked. */
export const goneSql = (m, f) => `(${m}.is_deleted OR COALESCE(${f}.special_use, '') IN ('\\Archive','\\Trash','\\Junk','\\All')
  OR COALESCE(${m}.folder, '') ~* '(^|/)(archive|archives|trash|bin|deleted items|deleted messages|junk|junk e-?mail|spam)$')`;

const GONE_FOLDER_RE = /(^|\/)(archive|archives|trash|bin|deleted items|deleted messages|junk|junk e-?mail|spam)$/i;
const GONE_SPECIAL = new Set(['\\Archive', '\\Trash', '\\Junk', '\\All']);

/** JS twin of goneSql for rows already in memory. */
export function isGone(row) {
  return Boolean(row.is_deleted) || GONE_SPECIAL.has(row.special_use) || GONE_FOLDER_RE.test(String(row.folder || ''));
}

/** Columns for the MessageLite shape; needs `messages m JOIN email_accounts a`. */
export const MESSAGE_LITE = `m.id, m.account_id, json_build_object('id', a.id, 'name', a.name, 'color', a.color) AS account,
  m.folder, m.subject, m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.thread_key`;

export const TRIAGE_COLUMNS = `t.category, t.override_category, t.priority, t.needs_you, t.confidence, t.stage, t.reason_label,
  t.reasons, t.overridden, t.decided_at, t.deadline_at, t.resolved_at`;

export function messageLite(r) {
  return {
    id: r.id,
    account_id: r.account_id,
    account: r.account || null,
    folder: r.folder,
    subject: r.subject,
    from_name: r.from_name,
    from_email: r.from_email,
    date: r.date,
    snippet: r.snippet,
    is_read: r.is_read,
    is_starred: r.is_starred,
    has_attachments: r.has_attachments,
    thread_key: r.thread_key,
  };
}

/** TriageInfo from a hedwig_triage row. Deadline chips are recomputed so "3 d" does not go stale. */
export function toTriageInfo(t, now = new Date()) {
  if (!t) return null;
  const category = (t.overridden && t.override_category) || t.category;
  let label = t.reason_label || null;
  if (t.deadline_at && label && label.startsWith('Deadline')) label = deadlineLabel(t.deadline_at, now);
  const reasons = (Array.isArray(t.reasons) ? t.reasons : []).map((r) => ({
    label: String(r.label || ''),
    weight: Number(r.weight) || 0,
    direction: r.direction === 'against' ? 'against' : 'for',
  }));
  return {
    category,
    priority: Number(t.priority) || 0,
    needs_you: t.overridden ? category === 'needs_you' : Boolean(t.needs_you),
    confidence: t.confidence === null || t.confidence === undefined ? null : Number(t.confidence),
    stage: Number(t.stage) || 1,
    reason_label: label,
    reasons,
    overridden: Boolean(t.overridden),
    decided_at: t.decided_at,
  };
}

export async function loadSenderStats(userId, emails) {
  const list = [...new Set(emails.filter(Boolean).map((e) => e.toLowerCase()))];
  if (!list.length) return new Map();
  const { rows } = await query(
    'SELECT * FROM hedwig_sender_stats WHERE user_id = $1 AND sender_email = ANY($2::text[])',
    [userId, list],
  );
  return new Map(rows.map((r) => [r.sender_email, r]));
}

export async function loadRules(userId) {
  const { rows } = await query('SELECT id, kind, value, category FROM hedwig_triage_rules WHERE user_id = $1', [userId]);
  return rows;
}

export async function loadModel(userId) {
  const { rows } = await query('SELECT version, model, metrics, samples, trained_at FROM hedwig_triage_models WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

/**
 * Other messages in the threads of `rows`, keyed `${account_id}|${thread_key}`, with a flag for
 * the user's own messages and a short text for money comparisons.
 */
export async function loadThreads(userId, rows, addresses) {
  const unique = new Map(rows.filter((r) => r.thread_key).map((r) => [`${r.account_id}|${r.thread_key}`, [r.account_id, r.thread_key]]));
  const keys = [...unique.values()];
  if (!keys.length) return new Map();
  const { rows: found } = await query(
    `SELECT m.id, m.account_id, m.thread_key, m.from_email, m.date,
            ${outgoingSql('m', 'f', '$4')} AS outgoing,
            LEFT(COALESCE(NULLIF(m.body_text, ''), m.snippet, ''), 2000) AS text
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       JOIN UNNEST($2::uuid[], $3::text[]) AS k(account_id, thread_key)
         ON k.account_id = m.account_id AND k.thread_key = m.thread_key
      WHERE a.user_id = $1 AND NOT m.is_deleted
      ORDER BY m.date DESC NULLS LAST
      LIMIT 2000`,
    [userId, keys.map((k) => k[0]), keys.map((k) => k[1]), [...addresses]],
  );
  const map = new Map();
  for (const r of found) {
    const key = `${r.account_id}|${r.thread_key}`;
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (list.length < 50) list.push(r);
  }
  return map;
}

/** Addresses per user (same source as the pipeline). */
export { userAddresses } from '../pipeline.js';
