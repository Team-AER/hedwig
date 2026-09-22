// Items leave the lists on their own: needs-you when the user replies in the thread or archives or
// deletes the message; waiting-on when anyone writes in the thread after the user. The pipeline
// step resolves immediately for the messages it sees; the 15-minute sweep catches everything else
// (sent copies that sync late, archives done in another client). Waiting-on detection lives here too.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { messageText } from '../text.js';
import { outgoingSql, goneSql } from './store.js';
import { waitingOnDecision } from './labels.js';

// How far back an unanswered question still counts as something the user is waiting on.
export const WAITING_MAX_DAYS = 60; // default for config triage.waitingOnMaxDays

const EFFECTIVE = "COALESCE(CASE WHEN t.overridden THEN t.override_category END, t.category)";

/** The user's new outgoing messages resolve needs-you (and older waiting-on) items they answer. */
export async function resolveByOutgoing(userId, rows) {
  const list = rows.filter((r) => r.date);
  if (!list.length) return 0;
  const { rowCount } = await query(
    `UPDATE hedwig_triage t SET resolved_at = x.at
       FROM messages m
       JOIN UNNEST($2::uuid[], $3::text[], $4::text[], $5::timestamptz[]) AS x(account_id, thread_key, reply_to, at)
         ON x.account_id = m.account_id
        AND (m.thread_key = x.thread_key OR (x.reply_to IS NOT NULL AND m.message_id = x.reply_to))
      WHERE t.message_id = m.id AND t.user_id = $1 AND t.resolved_at IS NULL
        AND m.date <= x.at
        AND ${EFFECTIVE} IN ('needs_you', 'waiting_on')
        AND NOT (${EFFECTIVE} = 'waiting_on' AND m.date = x.at)`,
    [userId, list.map((r) => r.account_id), list.map((r) => r.thread_key), list.map((r) => r.in_reply_to || null), list.map((r) => r.date)],
  );
  return rowCount || 0;
}

/** Incoming mail answers the user's waiting-on items in the same thread. */
export async function resolveWaitingByIncoming(userId, rows) {
  const list = rows.filter((r) => r.date);
  if (!list.length) return 0;
  const { rowCount } = await query(
    `UPDATE hedwig_triage t SET resolved_at = NOW()
       FROM messages m
       JOIN UNNEST($2::uuid[], $3::text[], $4::text[], $5::timestamptz[]) AS x(account_id, thread_key, reply_to, at)
         ON x.account_id = m.account_id
        AND (m.thread_key = x.thread_key OR (x.reply_to IS NOT NULL AND m.message_id = x.reply_to))
      WHERE t.message_id = m.id AND t.user_id = $1 AND t.resolved_at IS NULL
        AND m.date < x.at AND ${EFFECTIVE} = 'waiting_on'`,
    [userId, list.map((r) => r.account_id), list.map((r) => r.thread_key), list.map((r) => r.in_reply_to || null), list.map((r) => r.date)],
  );
  return rowCount || 0;
}

/** Full resolution pass for one user. */
export async function sweepResolution(userId, addresses) {
  const addrs = [...addresses];
  const gone = await query(
    `UPDATE hedwig_triage t SET resolved_at = NOW()
       FROM messages m LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE t.message_id = m.id AND t.user_id = $1 AND t.resolved_at IS NULL AND ${goneSql('m', 'f')}`,
    [userId],
  );
  const replied = await query(
    `UPDATE hedwig_triage t SET resolved_at = r.at
       FROM messages m, LATERAL (
         SELECT MIN(o.date) AS at FROM messages o
           LEFT JOIN folders ofo ON ofo.account_id = o.account_id AND ofo.path = o.folder
          WHERE o.account_id = m.account_id AND o.id <> m.id AND NOT o.is_deleted AND o.date > m.date
            AND ((m.thread_id IS NOT NULL AND o.thread_key = m.thread_key) OR (m.message_id IS NOT NULL AND o.in_reply_to = m.message_id))
            AND ${outgoingSql('o', 'ofo', '$2')}
       ) r
      WHERE t.message_id = m.id AND t.user_id = $1 AND t.resolved_at IS NULL
        AND ${EFFECTIVE} = 'needs_you' AND r.at IS NOT NULL`,
    [userId, addrs],
  );
  const answered = await query(
    `UPDATE hedwig_triage t SET resolved_at = NOW()
       FROM messages m
      WHERE t.message_id = m.id AND t.user_id = $1 AND t.resolved_at IS NULL AND ${EFFECTIVE} = 'waiting_on'
        AND EXISTS (
          SELECT 1 FROM messages r
           WHERE r.account_id = m.account_id AND r.id <> m.id AND NOT r.is_deleted AND r.date > m.date
             AND ((m.thread_id IS NOT NULL AND r.thread_key = m.thread_key) OR (m.message_id IS NOT NULL AND r.in_reply_to = m.message_id)))`,
    [userId],
  );
  return { gone: gone.rowCount || 0, replied: replied.rowCount || 0, answered: answered.rowCount || 0 };
}

/**
 * Find the user's outgoing messages that asked something, are the last word in their thread and
 * are at least triage.waitingOnDays old; upsert them as waiting-on.
 */
export async function scanWaitingOn(userId, addresses, { now = new Date(), waitingDays } = {}) {
  const cfg = await getConfig(userId);
  const days = waitingDays ?? cfg['triage.waitingOnDays'];
  const maxDays = cfg['triage.waitingOnMaxDays'] ?? WAITING_MAX_DAYS;
  const { rows } = await query(
    `SELECT DISTINCT ON (m.account_id, COALESCE(m.message_id, m.id::text))
            m.id, m.account_id, m.subject, m.from_email, m.to_addresses, m.cc_addresses, m.date,
            m.body_text, m.body_html, m.snippet, m.thread_key
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE a.user_id = $1 AND NOT m.is_deleted
        AND ${outgoingSql('m', 'f', '$2')}
        AND (f.special_use IS NULL OR f.special_use NOT IN ('\\Drafts', '\\Trash', '\\Junk', '\\All'))
        AND m.folder !~* '(^|/)(drafts?|trash|bin|junk|spam)$'
        AND m.date <= $3::timestamptz - ($4 || ' days')::interval
        AND m.date >= $3::timestamptz - ($5 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM messages r
           WHERE r.account_id = m.account_id AND r.id <> m.id AND NOT r.is_deleted AND r.date > m.date
             AND ((m.thread_id IS NOT NULL AND r.thread_key = m.thread_key) OR (m.message_id IS NOT NULL AND r.in_reply_to = m.message_id)))
        AND NOT EXISTS (
          SELECT 1 FROM hedwig_triage t WHERE t.message_id = m.id AND (t.overridden OR t.resolved_at IS NOT NULL OR t.category <> 'waiting_on'))
      ORDER BY m.account_id, COALESCE(m.message_id, m.id::text), m.date DESC
      LIMIT 500`,
    [userId, [...addresses], now.toISOString(), String(days), String(maxDays)],
  );
  let upserted = 0;
  for (const row of rows) {
    const decision = waitingOnDecision({ row, text: messageText(row, { maxChars: 3000 }), userAddresses: addresses, now, waitingDays: days });
    if (!decision) continue;
    await query(
      `INSERT INTO hedwig_triage (message_id, user_id, account_id, category, priority, needs_you, confidence, stage, reasons, reason_label, decided_at)
       VALUES ($1, $2, $3, 'waiting_on', $4, false, 0.8, 1, $5, $6, NOW())
       ON CONFLICT (message_id) DO UPDATE SET priority = EXCLUDED.priority, reasons = EXCLUDED.reasons,
              reason_label = EXCLUDED.reason_label
        WHERE hedwig_triage.user_id = EXCLUDED.user_id AND hedwig_triage.category = 'waiting_on'
          AND NOT hedwig_triage.overridden AND hedwig_triage.resolved_at IS NULL`,
      [row.id, userId, row.account_id, decision.priority, JSON.stringify(decision.reasons), decision.reasonLabel],
    );
    upserted++;
  }
  return upserted;
}
