// Behaviour labels: what the user did with their mail, turned into weak and silver labels, hourly.
//
// Signals and where they come from (all upstream columns, read after the fact):
//   reply              an outgoing message with In-Reply-To = the message (silver) or in the same
//                      thread (weak) within labels.replyWithinHours → needs_you=true, stream=people
//   archived unread    a row in an Archive folder that is unread, or was moved there in a bulk
//                      action (≥ labels.bulkArchiveMin rows relocated in the same second = "skipped",
//                      whatever the \Seen flag says). A move re-inserts the row, so its synced_at is
//                      the move time; rows present since the folder's first sync are plain state.
//                      ≥ labels.archiveUnreadMin from one sender → needs_you=false (weak)
//   engaged            messages.read_changed_at is stamped when the user opens (marks read) a
//                      message here. The gap to their next read is the dwell proxy: between
//                      labels.readEngagedSec and 15 min → engaged (weak). Reads stamped in the same
//                      second (mark-all-read, bulk read) are never engaged. Clients may also post an
//                      exact dwell time to POST /labels/dwell.
//   spam moves         spam_training_log (manual mark spam / not spam) and messages.spam_user_override
//                      → strong spam label (silver); "not spam" on mail in a spam folder → rescue
//   sent to            the user has written to the sender → stream=people (silver from 2 sends)
//   unsubscribe        messages.unsubscribed_at on any message from the sender → not people (silver)
// Gmail archives into All Mail, which is not synced, so Gmail archives are invisible here.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { getState, setState } from '../state.js';
import { outgoingSql, userAddresses } from '../triage/store.js';
import { upsertLabels } from './store.js';

const HOUR = 3600_000;
const ENGAGED_MAX_SEC = 15 * 60;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Keep one row per message (copies of one Message-ID in several folders count once). */
function oncePerMessage(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = r.mid || r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const label = (suite, row, value, grade, evidence) => ({
  suite, targetId: String(row.id), label: value, grade, source: 'behaviour', evidence: { mid: row.mid || null, ...evidence },
});

/** Replied within the window → needs you, and a person. In-Reply-To is strong; same thread is weak. */
export function replyLabels(rows, { withinHours = 24 } = {}) {
  const out = [];
  for (const r of oncePerMessage(rows)) {
    if (!r.replied_at) continue;
    const hours = (new Date(r.replied_at) - new Date(r.date)) / HOUR;
    if (!(hours >= 0 && hours <= withinHours)) continue;
    const grade = r.direct ? 'silver' : 'weak';
    const evidence = { rule: 'reply', repliedAt: iso(r.replied_at), receivedAt: iso(r.date), hours: Math.round(hours * 10) / 10, direct: Boolean(r.direct) };
    out.push(label('needs_you', r, { needs_you: true }, grade, evidence));
    out.push(label('sort', r, { stream: 'people' }, grade, evidence));
  }
  return out;
}

/**
 * Archived without reading, repeatedly, from one sender → not needs you. Bulk-archived rows count
 * as skipped (unread) even when the archive marked them read.
 * rows: { id, mid, sender, date, is_read, moved_later, same_second, replied }
 */
export function archiveUnreadLabels(rows, { min = 3, bulkMin = 5 } = {}) {
  const bySender = new Map();
  for (const r of oncePerMessage(rows)) {
    if (!r.sender || r.replied) continue;
    const bulk = Boolean(r.moved_later) && Number(r.same_second) >= bulkMin;
    if (r.is_read && !bulk) continue;
    if (!bySender.has(r.sender)) bySender.set(r.sender, []);
    bySender.get(r.sender).push({ ...r, bulk });
  }
  const out = [];
  for (const [sender, list] of bySender) {
    if (list.length < min) continue;
    const dates = list.map((r) => new Date(r.date).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
    for (const r of list) {
      out.push(label('needs_you', r, { needs_you: false }, 'weak', {
        rule: 'archive_unread', sender, count: list.length, skipped: r.bulk,
        first: day(dates[0]), last: day(dates[dates.length - 1]),
      }));
    }
  }
  return out;
}

/**
 * Dwell proxy from read timestamps. reads: every read event of the user (inbound and outgoing),
 * { id, mid, read_at, outgoing, skipped }. The last read before a gap of `minSec`..15 min is engaged.
 */
export function engagedLabels(reads, { minSec = 30, maxSec = ENGAGED_MAX_SEC } = {}) {
  const sorted = reads.filter((r) => r.read_at).map((r) => ({ ...r, t: new Date(r.read_at).getTime() })).sort((a, b) => a.t - b.t);
  const perSecond = new Map();
  for (const r of sorted) {
    const s = Math.floor(r.t / 1000);
    perSecond.set(s, (perSecond.get(s) || 0) + 1);
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < sorted.length - 1; i++) {
    const r = sorted[i];
    if (r.outgoing || r.skipped || perSecond.get(Math.floor(r.t / 1000)) > 1) continue;
    const gap = (sorted[i + 1].t - r.t) / 1000;
    if (gap < minSec || gap > maxSec) continue;
    const key = r.mid || r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label('sort', r, { engaged: true }, 'weak', { rule: 'engaged', seconds: Math.round(gap), readAt: iso(r.read_at), proxy: 'read_gap' }));
  }
  return out;
}

/** Explicit spam / not-spam marks → strong spam labels; "not spam" out of a spam folder → rescue. */
export function spamLabels(marks) {
  const out = [];
  const latest = new Map();
  for (const m of marks) {
    const key = m.mid || m.id;
    const prev = latest.get(key);
    if (!prev || new Date(m.at) > new Date(prev.at)) latest.set(key, m);
  }
  for (const m of latest.values()) {
    const spam = m.label === 'spam';
    const evidence = { rule: m.rule || 'spam_move', mark: m.label, at: iso(m.at), fromFolder: m.folder || null };
    out.push(label('spam', m, { spam }, 'silver', evidence));
    if (m.in_spam_folder) out.push(label('rescue', m, { rescue: !spam }, 'silver', evidence));
  }
  return out;
}

/** The user has written to this sender → their mail is from a person. */
export function sentToLabels(rows) {
  const out = [];
  for (const r of oncePerMessage(rows)) {
    if (!r.sent_count) continue;
    out.push(label('sort', r, { stream: 'people' }, r.sent_count >= 2 ? 'silver' : 'weak', {
      rule: 'sent_to', sender: r.sender, sentCount: r.sent_count, lastSent: day(r.last_sent),
    }));
  }
  return out;
}

/** Unsubscribed from the sender → not people. */
export function unsubscribeLabels(rows) {
  return oncePerMessage(rows).filter((r) => r.unsubscribed_at).map((r) => label('sort', r, { notStream: 'people' }, 'silver', {
    rule: 'unsubscribe', sender: r.sender, at: iso(r.unsubscribed_at),
  }));
}

/** Every behaviour rule over one user's fetched signals. Pure. */
export function deriveBehaviourLabels(signals, cfg = {}) {
  return [
    ...replyLabels(signals.replies || [], { withinHours: cfg.replyWithinHours ?? 24 }),
    ...archiveUnreadLabels(signals.archived || [], { min: cfg.archiveUnreadMin ?? 3, bulkMin: cfg.bulkArchiveMin ?? 5 }),
    ...engagedLabels(signals.reads || [], { minSec: cfg.readEngagedSec ?? 30 }),
    ...spamLabels(signals.spamMarks || []),
    ...sentToLabels(signals.sentTo || []),
    ...unsubscribeLabels(signals.unsubscribed || []),
  ];
}

// ── Signals (SQL) ─────────────────────────────────────────────────────────────

const JUNK_RE = `'(^|[/.])(spam|junk|junk e-?mail|bulk mail)$'`;
const ARCHIVE_RE = `'(^|[/.])(archive|archives)$'`;
const NOT_BIN = `COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Drafts') AND m.folder !~* '(^|[/.])(trash|bin|deleted items|deleted messages|drafts)$'`;

async function fetchReplies(userId, addrs, days, hours) {
  const { rows } = await query(
    `SELECT m.id, m.message_id AS mid, lower(m.from_email) AS sender, m.date, r.date AS replied_at, r.direct
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       JOIN LATERAL (
         SELECT o.date, (m.message_id IS NOT NULL AND o.in_reply_to = m.message_id) AS direct
           FROM messages o LEFT JOIN folders ofo ON ofo.account_id = o.account_id AND ofo.path = o.folder
          WHERE o.account_id = m.account_id AND o.id <> m.id AND NOT o.is_deleted
            AND o.date > m.date AND o.date <= m.date + make_interval(hours => $4::int)
            AND ((m.message_id IS NOT NULL AND o.in_reply_to = m.message_id) OR (m.thread_key IS NOT NULL AND o.thread_key = m.thread_key))
            AND ${outgoingSql('o', 'ofo', '$2')}
          ORDER BY 2 DESC, o.date LIMIT 1) r ON true
      WHERE NOT m.is_deleted AND m.date > NOW() - make_interval(days => $3::int)
        AND NOT ${outgoingSql('m', 'f', '$2')} AND ${NOT_BIN}`,
    [userId, addrs, days, hours],
  );
  return rows;
}

async function fetchArchived(userId, addrs, days) {
  const { rows } = await query(
    `WITH arch AS (
       SELECT m.id, m.message_id AS mid, m.account_id, m.folder, lower(m.from_email) AS sender, m.date, m.is_read, m.synced_at, m.thread_key
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE NOT m.is_deleted
          AND (COALESCE(f.special_use, '') = '\\Archive' OR m.folder ~* ${ARCHIVE_RE})
          AND (m.date > NOW() - make_interval(days => $3::int) OR m.synced_at > NOW() - make_interval(days => $3::int))
          AND NOT ${outgoingSql('m', 'f', '$2')}),
     first_sync AS (
       SELECT x.account_id, x.folder, MIN(x.synced_at) AS at FROM messages x
        WHERE (x.account_id, x.folder) IN (SELECT DISTINCT account_id, folder FROM arch) GROUP BY 1, 2)
     SELECT arch.id, arch.mid, arch.sender, arch.date, arch.is_read,
            (arch.synced_at > fs.at + INTERVAL '10 minutes') AS moved_later,
            COUNT(*) OVER (PARTITION BY arch.account_id, date_trunc('second', arch.synced_at))::int AS same_second,
            EXISTS (SELECT 1 FROM messages o WHERE o.account_id = arch.account_id AND o.in_reply_to = arch.mid AND lower(o.from_email) = ANY($2::text[])) AS replied
       FROM arch JOIN first_sync fs ON fs.account_id = arch.account_id AND fs.folder = arch.folder`,
    [userId, addrs, days],
  );
  return rows;
}

async function fetchReads(userId, addrs, days) {
  const { rows } = await query(
    `SELECT m.id, m.message_id AS mid, m.read_changed_at AS read_at, ${outgoingSql('m', 'f', '$2')} AS outgoing
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.is_read AND NOT m.is_deleted AND m.read_changed_at > NOW() - make_interval(days => $3::int)
      ORDER BY m.read_changed_at`,
    [userId, addrs, days],
  );
  return rows;
}

async function fetchSpamMarks(userId, days) {
  const { rows } = await query(
    `SELECT DISTINCT ON (l.id) l.label, l.folder, l.created_at AS at, m.id, m.message_id AS mid,
            (l.folder ~* ${JUNK_RE} OR EXISTS (SELECT 1 FROM folders jf WHERE jf.account_id = l.account_id AND jf.path = l.folder AND jf.special_use = '\\Junk')) AS in_spam_folder,
            'spam_move' AS rule
       FROM spam_training_log l
       JOIN messages m ON m.account_id = l.account_id AND m.message_id = l.message_id_header
      WHERE l.user_id = $1 AND l.source = 'manual' AND l.created_at > NOW() - make_interval(days => $2::int)
        AND NOT m.is_deleted
      ORDER BY l.id, m.date DESC
     `,
    [userId, days],
  );
  const { rows: overrides } = await query(
    `SELECT m.spam_user_override AS label, m.folder, COALESCE(m.spam_analyzed_at, m.synced_at) AS at, m.id, m.message_id AS mid,
            (COALESCE(f.special_use, '') = '\\Junk' OR m.folder ~* ${JUNK_RE}) AS in_spam_folder, 'spam_override' AS rule
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.spam_user_override IS NOT NULL AND NOT m.is_deleted AND m.date > NOW() - make_interval(days => $2::int)`,
    [userId, days],
  );
  // A training-log mark and an override on the same message agree by construction; keep the log's.
  const logged = new Set(rows.map((r) => r.mid || r.id));
  return [...rows, ...overrides.filter((r) => !logged.has(r.mid || r.id))];
}

async function fetchSentTo(userId, addrs, days) {
  const { rows } = await query(
    `WITH sent AS (
       SELECT lower(COALESCE(t->>'address', t->>'email', t #>> '{}')) AS addr, COUNT(DISTINCT COALESCE(m.message_id, m.id::text))::int AS n, MAX(m.date) AS last_sent
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(m.to_addresses, '[]'::jsonb) || COALESCE(m.cc_addresses, '[]'::jsonb)) t
        WHERE ${outgoingSql('m', 'f', '$2')} AND NOT m.is_deleted AND m.date > NOW() - INTERVAL '365 days'
        GROUP BY 1)
     SELECT m.id, m.message_id AS mid, lower(m.from_email) AS sender, m.date, s.n AS sent_count, s.last_sent
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       JOIN sent s ON s.addr = lower(m.from_email)
      WHERE NOT m.is_deleted AND m.date > NOW() - make_interval(days => $3::int)
        AND NOT ${outgoingSql('m', 'f', '$2')} AND ${NOT_BIN}
        AND NOT (COALESCE(m.is_bulk, false) OR m.list_unsubscribe IS NOT NULL)
        AND lower(m.from_email) <> ALL($2::text[])`,
    [userId, addrs, days],
  );
  return rows;
}

async function fetchUnsubscribed(userId, days) {
  const { rows } = await query(
    `WITH unsub AS (
       SELECT lower(m.from_email) AS sender, MAX(m.unsubscribed_at) AS at
         FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
        WHERE m.unsubscribed_at IS NOT NULL AND m.from_email IS NOT NULL GROUP BY 1)
     SELECT m.id, m.message_id AS mid, u.sender, m.date, u.at AS unsubscribed_at
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
       JOIN unsub u ON u.sender = lower(m.from_email)
      WHERE NOT m.is_deleted AND m.date > NOW() - make_interval(days => $2::int)`,
    [userId, days],
  );
  return rows;
}

/** Fetch one user's signals and write their behaviour labels. */
export async function behaviourForUser(userId, addresses, cfg) {
  const addrs = [...(addresses || [])];
  const days = cfg['labels.windowDays'];
  const [replies, archived, reads, spamMarks, sentTo, unsubscribed] = await Promise.all([
    fetchReplies(userId, addrs, days, cfg['labels.replyWithinHours']),
    fetchArchived(userId, addrs, days),
    fetchReads(userId, addrs, days),
    fetchSpamMarks(userId, days),
    fetchSentTo(userId, addrs, days),
    fetchUnsubscribed(userId, days),
  ]);
  // A bulk-archived message was skipped, not read: it never counts as engaged.
  const skipped = new Set(archived.filter((r) => r.moved_later && r.same_second >= cfg['labels.bulkArchiveMin']).map((r) => r.id));
  const labels = deriveBehaviourLabels(
    { replies, archived, reads: reads.map((r) => ({ ...r, skipped: skipped.has(r.id) })), spamMarks, sentTo, unsubscribed },
    {
      replyWithinHours: cfg['labels.replyWithinHours'],
      archiveUnreadMin: cfg['labels.archiveUnreadMin'],
      bulkArchiveMin: cfg['labels.bulkArchiveMin'],
      readEngagedSec: cfg['labels.readEngagedSec'],
    },
  );
  await upsertLabels(userId, labels);
  return labels.length;
}

/** Record an exact dwell time a client measured. Engaged only above labels.readEngagedSec. */
export async function recordDwell(userId, messageId, ms) {
  const cfg = await getConfig(userId);
  const { rows } = await query(
    `SELECT m.id, m.message_id AS mid FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1 WHERE m.id = $2`,
    [userId, messageId],
  );
  if (!rows[0]) return null;
  const seconds = Math.round(Number(ms) / 1000);
  if (!(seconds >= cfg['labels.readEngagedSec'])) return { engaged: false, seconds };
  await upsertLabels(userId, [label('sort', rows[0], { engaged: true }, 'weak', { rule: 'engaged', seconds, proxy: 'client_dwell', at: new Date().toISOString() })]);
  return { engaged: true, seconds };
}

async function labelUsers() {
  const { rows } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  return rows.map((r) => r.user_id);
}

/** The schedule tick: runs every few minutes, sweeps at most every labels.behaviourEverySec. */
export async function behaviourTick(now = Date.now()) {
  const sys = await getConfig();
  if (!sys.enabled) return 0;
  const last = await getState('labels.behaviour', null);
  if (last?.at && now - Date.parse(last.at) < sys['labels.behaviourEverySec'] * 1000) return 0;
  await setState('labels.behaviour', { at: new Date(now).toISOString() });
  const users = await labelUsers();
  const addrs = await userAddresses(users);
  let total = 0;
  for (const userId of users) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled) continue;
      total += await behaviourForUser(userId, addrs.get(userId) || new Set(), cfg);
    } catch (err) {
      console.warn(`[hedwig] behaviour labels failed for user ${userId}:`, err.message);
    }
  }
  return total;
}
