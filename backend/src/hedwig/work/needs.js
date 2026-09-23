// Needs You reasons work derives from the mail itself, next to sorting's own needs_you (hedwig_sort,
// set by the Reflex model when someone asks something):
//   reply_overdue  a person wrote to the owner directly, it is the thread's latest message, it sits in
//                  People, and it has waited work.replyOverdueDays ("Waiting 4 days for your reply")
//   deadline       an open commitment the owner owes is due within work.deadlineSoonDays ("Due Fri: …")
// Derived by the sweep over the last work.needsDays of mail (and for new mail within minutes); the
// owner's reply resolves reply_overdue at once (pipeline step); lapsed reasons resolve on the next pass.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { addressesOf } from '../text.js';
import { isPersonRow } from './summaries.js';
import { ownerOf, clampInt, timeZoneOf, DAY_MS } from './util.js';

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Is a thread's latest message overdue for a reply? Pure. Returns { days } or null. */
export function overdue(row, { ownerAddresses, now = new Date(), days = 2 }) {
  if (!row?.date || row.mine || !isPersonRow(row)) return null;
  if (row.stream && row.stream !== 'people') return null;
  const mine = new Set(ownerAddresses.map((a) => a.toLowerCase()));
  if (!addressesOf(row.to_addresses).some((a) => mine.has(a.email))) return null; // cc or a list: not to you directly
  const waited = Math.floor((now.getTime() - new Date(row.date).getTime()) / DAY_MS);
  return waited >= days ? { days: waited } : null;
}

export function overdueReason(days) {
  return `Waiting ${days} day${days === 1 ? '' : 's'} for your reply`;
}

export function deadlineReason(what, dueAt, tz) {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(dueAt));
  return clip(`Due ${day}: ${what}`, 120);
}

/** Recompute one user's derived reasons. @returns {{ open: number, added: number, resolved: number }} */
export async function deriveNeeds(userId, { now = new Date() } = {}) {
  const cfg = await getConfig(userId);
  if (!cfg.enabled || cfg['work.enabled'] === false) return { open: 0, added: 0, resolved: 0 };
  const owner = await ownerOf(userId);
  const mine = new Set(owner.addresses);
  const windowDays = clampInt(cfg['work.needsDays'], 30, 1, 365);
  const overdueDays = clampInt(cfg['work.replyOverdueDays'], 2, 1, 60);
  const soonDays = clampInt(cfg['work.deadlineSoonDays'], 3, 0, 60);
  const tz = timeZoneOf(cfg);

  const { rows: latest } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (m.thread_key) m.id, m.thread_key, m.from_name, m.from_email, m.to_addresses, m.date, m.is_bulk,
              m.list_unsubscribe, f.special_use, s.stream, COALESCE(s.own, false) AS own
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         LEFT JOIN hedwig_sort s ON s.message_id = m.id
        WHERE a.user_id = $1 AND NOT m.is_deleted AND m.thread_key IS NOT NULL
          AND m.date > $2::timestamptz - make_interval(days => $3::int)
          AND COALESCE(f.special_use, '') NOT IN ('\\Junk', '\\Trash', '\\Drafts')
          AND m.folder !~* '(^|/)(spam|junk|bulk|trash|bin|deleted items|drafts?)$'
        ORDER BY m.thread_key, m.date DESC NULLS LAST, m.id DESC) t
      WHERE t.date <= $2::timestamptz - make_interval(days => $4::int)`,
    [userId, now, windowDays, overdueDays],
  );
  const want = [];
  for (const r of latest) {
    r.mine = r.special_use === '\\Sent' || mine.has(String(r.from_email || '').toLowerCase());
    if (!r.stream) continue; // not sorted yet
    const o = overdue(r, { ownerAddresses: owner.addresses, now, days: overdueDays });
    if (o) want.push({ threadKey: r.thread_key, messageId: r.id, kind: 'reply_overdue', reason: overdueReason(o.days), dueAt: null });
  }
  const { rows: due } = await query(
    `SELECT DISTINCT ON (COALESCE(k.thread_key, m.thread_key)) COALESCE(k.thread_key, m.thread_key) AS thread_key, k.source_message_id, k.what, k.due_at
       FROM hedwig_commitments k LEFT JOIN messages m ON m.id = k.source_message_id
      WHERE k.user_id = $1 AND k.status = 'open' AND k.direction = 'i_owe' AND k.due_at IS NOT NULL
        AND k.due_at BETWEEN $2::timestamptz - INTERVAL '1 day' AND $2::timestamptz + make_interval(days => $3::int)
        AND COALESCE(k.thread_key, m.thread_key) IS NOT NULL
      ORDER BY COALESCE(k.thread_key, m.thread_key), k.due_at`,
    [userId, now, soonDays],
  );
  for (const d of due) want.push({ threadKey: d.thread_key, messageId: d.source_message_id, kind: 'deadline', reason: deadlineReason(d.what, d.due_at, tz), dueAt: d.due_at });

  let added = 0;
  for (const w of want) {
    const res = await query(
      `INSERT INTO hedwig_work_needs (user_id, thread_key, message_id, kind, reason, due_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, thread_key, kind) WHERE resolved_at IS NULL
       DO UPDATE SET message_id = EXCLUDED.message_id, reason = EXCLUDED.reason, due_at = EXCLUDED.due_at, derived_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [userId, w.threadKey, w.messageId, w.kind, w.reason, w.dueAt],
    );
    if (res.rows[0]?.inserted) added++;
  }
  const keep = want.map((w) => `${w.kind}|${w.threadKey}`);
  const { rowCount: resolved } = await query(
    `UPDATE hedwig_work_needs SET resolved_at = NOW(), resolved_reason = 'lapsed'
      WHERE user_id = $1 AND resolved_at IS NULL AND NOT ((kind || '|' || thread_key) = ANY($2::text[]))`,
    [userId, keep],
  );
  return { open: want.length, added, resolved: resolved || 0 };
}

/** The sweep: every user with an enabled account. */
export async function deriveAllNeeds() {
  const { rows } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  let open = 0;
  for (const { user_id: userId } of rows) {
    try { open += (await deriveNeeds(userId)).open; } catch (err) { console.warn(`[hedwig] work: needs-you derivation failed for ${userId}:`, err.message); }
  }
  return open;
}

/** The owner wrote in these threads: their reply settles "waiting for your reply". */
export async function resolveReplied(userId, threadKeys) {
  const keys = [...new Set(threadKeys.filter(Boolean))];
  if (!keys.length) return 0;
  const { rowCount } = await query(
    `UPDATE hedwig_work_needs SET resolved_at = NOW(), resolved_reason = 'replied'
      WHERE user_id = $1 AND resolved_at IS NULL AND kind = 'reply_overdue' AND thread_key = ANY($2::text[])`,
    [userId, keys],
  );
  return rowCount || 0;
}

/** Open derived reasons for these threads: Map threadKey → { kind, reason, dueAt } (a deadline wins). */
export async function needsFor(userId, threadKeys) {
  const keys = [...new Set((threadKeys || []).filter(Boolean))];
  if (!keys.length) return new Map();
  const { rows } = await query(
    `SELECT thread_key, kind, reason, due_at FROM hedwig_work_needs
      WHERE user_id = $1 AND resolved_at IS NULL AND thread_key = ANY($2::text[])
      ORDER BY CASE kind WHEN 'deadline' THEN 0 ELSE 1 END`,
    [userId, keys],
  );
  const out = new Map();
  for (const r of rows) if (!out.has(r.thread_key)) out.set(r.thread_key, { kind: r.kind, reason: r.reason, dueAt: r.due_at });
  return out;
}

/**
 * SQL for C's needsYou=1 filter, so derived reasons join the Needs you list:
 *   where.push(`(s.needs_you OR ${workNeedsYouSql('m', 's')})`)
 * then call withWorkRows(..., { derivedNeedsYou: true }) so the rows carry needsYou and the reason.
 */
export function workNeedsYouSql(m = 'm', s = 's') {
  return `EXISTS (SELECT 1 FROM hedwig_work_needs wn WHERE wn.user_id = ${s}.user_id AND wn.thread_key = ${m}.thread_key AND wn.resolved_at IS NULL)`;
}
