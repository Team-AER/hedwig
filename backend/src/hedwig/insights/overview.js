// GET /insights/overview: mail statistics for one user over the last N days. Pure SQL over upstream
// tables plus Hedwig's derived ones; no model calls.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { ADDRS_CTE, userMessagesCte } from './scope.js';
import { responseSamples, summarizeResponseTimes } from './stats.js';
import { validTimezone } from './time.js';

export const MAX_DAYS = 365;

export function clampDays(days, fallback = 30) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_DAYS, n);
}

const SINCE = "NOW() - make_interval(days => $2::int)";

async function volume(userId, days, tz) {
  const { rows } = await query(
    `WITH ${ADDRS_CTE}, ${userMessagesCte(SINCE)},
     days AS (
       SELECT generate_series((NOW() AT TIME ZONE $3)::date - ($2::int - 1), (NOW() AT TIME ZONE $3)::date, INTERVAL '1 day')::date AS day
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COUNT(um.id) FILTER (WHERE NOT um.outgoing)::int AS received,
            COUNT(um.id) FILTER (WHERE um.outgoing)::int AS sent
       FROM days d
       LEFT JOIN um ON (um.date AT TIME ZONE $3)::date = d.day
      GROUP BY d.day ORDER BY d.day`,
    [userId, days, tz],
  );
  return rows;
}

async function byAccount(userId, days) {
  const { rows } = await query(
    `WITH ${ADDRS_CTE}, ${userMessagesCte(SINCE)}
     SELECT a.id, a.name, a.color, a.email_address,
            COUNT(um.id) FILTER (WHERE NOT um.outgoing)::int AS received,
            COUNT(um.id) FILTER (WHERE um.outgoing)::int AS sent
       FROM email_accounts a
       LEFT JOIN um ON um.account_id = a.id
      WHERE a.user_id = $1
      GROUP BY a.id ORDER BY a.sort_order NULLS LAST, a.created_at`,
    [userId, days],
  );
  return rows.map((r) => ({ account: { id: r.id, name: r.name, color: r.color, email: r.email_address }, received: r.received, sent: r.sent }));
}

async function topSenders(userId, days, limit = 10) {
  // Opened/replied rates prefer Hedwig's per-sender behaviour counters (lifetime, maintained by
  // triage); a sender with no counters yet falls back to what the window itself shows.
  const { rows } = await query(
    `WITH ${ADDRS_CTE}, ${userMessagesCte(SINCE)},
     inc AS (SELECT * FROM um WHERE NOT outgoing AND from_email IS NOT NULL AND from_email <> ''),
     replied AS (
       SELECT DISTINCT i.id FROM inc i
         JOIN um o ON o.outgoing AND o.account_id = i.account_id AND o.thread_key = i.thread_key AND o.date > i.date
     )
     SELECT i.from_email AS email,
            (ARRAY_AGG(i.from_name ORDER BY i.date DESC) FILTER (WHERE i.from_name IS NOT NULL AND i.from_name <> ''))[1] AS name,
            COUNT(*)::int AS count,
            AVG(CASE WHEN i.is_read THEN 1 ELSE 0 END)::float AS window_opened,
            AVG(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END)::float AS window_replied,
            MAX(s.received) AS s_received, MAX(s.opened) AS s_opened, MAX(s.replied) AS s_replied
       FROM inc i
       LEFT JOIN replied r ON r.id = i.id
       LEFT JOIN hedwig_sender_stats s ON s.user_id = $1 AND s.sender_email = i.from_email
      GROUP BY i.from_email
      ORDER BY COUNT(*) DESC, MAX(i.date) DESC
      LIMIT $3`,
    [userId, days, limit],
  );
  const rate = (v) => (v == null ? null : Math.round(Math.min(1, Math.max(0, v)) * 100) / 100);
  return rows.map((r) => {
    const hasStats = Number(r.s_received) > 0;
    return {
      email: r.email,
      name: r.name || null,
      count: r.count,
      opened_rate: rate(hasStats ? Number(r.s_opened) / Number(r.s_received) : r.window_opened),
      replied_rate: rate(hasStats ? Number(r.s_replied) / Number(r.s_received) : r.window_replied),
    };
  });
}

/**
 * Reply-latency rows: every message in a thread the user wrote into during the window, reaching
 * `lookbackDays` further back so a reply early in the window is measured against its prompt.
 */
export async function responseRows(userId, days, lookbackDays = 30) {
  const { rows } = await query(
    `WITH ${ADDRS_CTE}, ${userMessagesCte("NOW() - make_interval(days => $2::int + $3::int)")},
     replied_threads AS (
       SELECT DISTINCT account_id, thread_key FROM um
        WHERE outgoing AND date >= NOW() - make_interval(days => $2::int) AND thread_key IS NOT NULL
     )
     SELECT um.account_id || '|' || um.thread_key AS thread, um.date, um.outgoing
       FROM um JOIN replied_threads t ON t.account_id = um.account_id AND t.thread_key = um.thread_key
      WHERE um.outgoing OR NOT um.bulk`,
    [userId, days, lookbackDays],
  );
  return rows;
}

export async function responseTime(userId, days, tz) {
  const since = Date.now() - days * 86400_000;
  const samples = responseSamples(await responseRows(userId, days)).filter((s) => s.at.getTime() >= since);
  const { median_hours, p90_hours, weekly, samples: n } = summarizeResponseTimes(samples, tz);
  return { median_hours, p90_hours, samples: n, weekly: weekly.map(({ week, median_hours: m }) => ({ week, median_hours: m })) };
}

export async function oweCounts(userId, minConfidence = 0) {
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE direction = 'i_owe')::int AS i_owe,
            COUNT(*) FILTER (WHERE direction = 'they_owe')::int AS they_owe,
            COUNT(*) FILTER (WHERE due_at < NOW())::int AS overdue,
            COUNT(*) FILTER (WHERE direction = 'i_owe' AND due_at < NOW())::int AS i_owe_overdue
       FROM hedwig_commitments
      WHERE user_id = $1 AND status = 'open' AND (user_edited OR confidence IS NULL OR confidence >= $2)`,
    [userId, minConfidence],
  );
  const r = rows[0] || {};
  return { i_owe: r.i_owe || 0, they_owe: r.they_owe || 0, overdue: r.overdue || 0, i_owe_overdue: r.i_owe_overdue || 0 };
}

async function triageCounts(userId, days) {
  // needs_you and waiting_on are what is open now; digest and spam count the window's mail.
  const { rows } = await query(
    `SELECT COUNT(*) FILTER (WHERE t.needs_you AND t.resolved_at IS NULL)::int AS needs_you,
            COUNT(*) FILTER (WHERE COALESCE(t.override_category, t.category) = 'waiting_on' AND t.resolved_at IS NULL)::int AS waiting_on,
            COUNT(*) FILTER (WHERE COALESCE(t.override_category, t.category) = 'digest' AND m.date >= NOW() - make_interval(days => $2::int))::int AS digest,
            COUNT(*) FILTER (WHERE COALESCE(t.override_category, t.category) = 'spam' AND m.date >= NOW() - make_interval(days => $2::int))::int AS spam
       FROM hedwig_triage t
       JOIN messages m ON m.id = t.message_id AND m.is_deleted = false
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
      WHERE t.user_id = $1`,
    [userId, days],
  );
  const r = rows[0] || {};
  return { needs_you: r.needs_you || 0, waiting_on: r.waiting_on || 0, digest: r.digest || 0, spam: r.spam || 0 };
}

async function aiUsage(userId, days) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS calls, COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens
       FROM hedwig_ai_calls WHERE user_id = $1 AND created_at >= NOW() - make_interval(days => $2::int)`,
    [userId, days],
  );
  const r = rows[0] || {};
  return { calls: r.calls || 0, prompt_tokens: Number(r.prompt_tokens || 0), completion_tokens: Number(r.completion_tokens || 0) };
}

/** The `/insights/overview` payload. */
export async function overview(userId, { days } = {}) {
  const d = clampDays(days);
  const cfg = await getConfig(userId);
  const tz = validTimezone(cfg['insights.timezone']);
  const [vol, accounts, senders, rt, owe, triage, ai] = await Promise.all([
    volume(userId, d, tz),
    byAccount(userId, d),
    topSenders(userId, d),
    responseTime(userId, d, tz),
    oweCounts(userId, cfg['context.extractMinConfidence']),
    triageCounts(userId, d),
    aiUsage(userId, d),
  ]);
  return {
    days: d,
    timezone: tz,
    volume: vol,
    byAccount: accounts,
    topSenders: senders,
    responseTime: rt,
    owe: { i_owe: owe.i_owe, they_owe: owe.they_owe, overdue: owe.overdue },
    triage,
    ai,
  };
}
