// Shared pieces of the work module: errors, thread lookup (always through the user's accounts),
// the owner's identity, and the stream-row shape C's lists use so the same component renders ours.
import { query } from '../../services/db.js';
import { userAddresses } from '../pipeline.js';
import { validTimezone, describeNow } from '../insights/time.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const DAY_MS = 86400_000;

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** A thread id from the client: upstream's thread_key (or a message id for a one-message thread). */
export function threadKeyOf(threadId) {
  const key = typeof threadId === 'string' ? threadId.trim() : '';
  if (!key || key.length > 1000) throw httpError(400, 'threadId is required');
  return key;
}

export async function ownerOf(userId) {
  const [addrs, { rows }] = await Promise.all([
    userAddresses([userId]),
    query(
      `SELECT COALESCE((SELECT display_name FROM hedwig_entities WHERE user_id = $1 AND kind = 'self' ORDER BY created_at LIMIT 1),
                       (SELECT display_name FROM users WHERE id = $1),
                       (SELECT username FROM users WHERE id = $1)) AS name`,
      [userId],
    ),
  ]);
  return { name: rows[0]?.name || null, addresses: [...(addrs.get(userId) || new Set())] };
}

export function timeZoneOf(cfg) {
  return validTimezone(cfg?.['insights.timezone']);
}

export function todayLine(cfg, now = new Date()) {
  return describeNow(now, timeZoneOf(cfg));
}

const THREAD_COLUMNS = `m.id, m.account_id, m.folder, m.message_id, m.subject, m.from_name, m.from_email, m.to_addresses,
  m.cc_addresses, m.reply_to, m.date, m.snippet, m.body_text, m.body_html, m.is_read, m.has_attachments, m.attachments,
  m.in_reply_to, m.thread_key, m.list_unsubscribe, m.is_bulk, f.special_use`;

/**
 * Every message of a thread the user owns, oldest first, one row per Message-ID (the INBOX copy
 * preferred), each with `mine` (sent by the user). Matches upstream's GET /mail/thread/:threadId.
 */
export async function loadThreadMessages(userId, threadKey, { addresses = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (COALESCE(m.message_id, m.id::text)) ${THREAD_COLUMNS}
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND NOT m.is_deleted AND m.thread_key = $2
        ORDER BY COALESCE(m.message_id, m.id::text), CASE WHEN m.folder = 'INBOX' THEN 0 ELSE 1 END, m.date ASC
     ) t ORDER BY date ASC NULLS FIRST, id`,
    [userId, threadKey],
  );
  const mine = addresses ? new Set(addresses) : (await userAddresses([userId])).get(userId) || new Set();
  for (const r of rows) r.mine = r.special_use === '\\Sent' || mine.has(String(r.from_email || '').toLowerCase());
  return rows;
}

export function attachmentNames(row) {
  let list = row.attachments;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).map((a) => a?.filename || a?.name).filter(Boolean).slice(0, 10);
}

export const senderLabel = (r) => (r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email || 'unknown');

export function shortDate(date, cfg) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZoneOf(cfg), weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(date));
}

/** A stream row (C's shape) from a message joined with its hedwig_sort row. */
export function streamRow(r, extra = {}) {
  return {
    threadId: r.thread_key || r.id,
    messageId: r.id,
    from: { name: r.from_name || null, email: r.from_email || null },
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    needsYou: Boolean(r.needs_you),
    reason: (r.needs_you && r.needs_you_reason) || r.reason || null,
    bundle: r.bundle || null,
    accountId: r.account_id,
    unread: r.is_read === false,
    ...extra,
  };
}

/**
 * The latest message of each of these threads (one row per thread key), with its sort decision.
 * @returns {Promise<Map<string, object>>}
 */
export async function latestOfThreads(userId, threadKeys) {
  const keys = [...new Set(threadKeys.filter(Boolean))];
  if (!keys.length) return new Map();
  const { rows } = await query(
    `SELECT DISTINCT ON (m.thread_key) m.id, m.account_id, m.thread_key, m.from_name, m.from_email, m.subject, m.snippet, m.date, m.is_read,
            s.needs_you, s.needs_you_reason, s.reason, s.bundle, s.stream
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN hedwig_sort s ON s.message_id = m.id AND s.user_id = a.user_id
      WHERE a.user_id = $1 AND NOT m.is_deleted AND m.thread_key = ANY($2::text[])
      ORDER BY m.thread_key, m.date DESC NULLS LAST, m.id DESC`,
    [userId, keys],
  );
  return new Map(rows.map((r) => [r.thread_key, r]));
}

export function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function parseDate(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw httpError(400, `${name} must be an ISO date`);
  return new Date(t);
}
