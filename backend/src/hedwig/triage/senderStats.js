// Pipeline step `senderStats` (order 15, backfill): per (user, sender) counts of mail received and
// replied to. Received is counted when an incoming message is first seen; replied is credited when
// one of the user's outgoing messages answers a sender. hedwig_triage_sender_log makes both
// idempotent, so re-running a batch never double counts. Opened/starred/archived counts are added
// once a message is old enough for its fate to mean something (here for history, otherwise by the
// hourly behaviour sweep in learning.js).
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { domainOf } from '../text.js';
import { outgoingSql, isGone } from './store.js';

/** Aggregate behaviour increments per sender from message rows. Exported for the sweep and tests. */
export function behaviourDeltas(rows) {
  const out = new Map();
  for (const r of rows) {
    // stat_email is the sender a log row was counted under; messages.sender_email is the Sender: header.
    const email = String(r.stat_email || r.from_email || '').toLowerCase();
    if (!email) continue;
    const d = out.get(email) || { opened: 0, starred: 0, archived_unread: 0, deleted_unread: 0 };
    if (r.is_read) d.opened++;
    if (r.is_starred) d.starred++;
    if (!r.is_read && r.is_deleted) d.deleted_unread++;
    else if (!r.is_read && isGone(r)) d.archived_unread++;
    out.set(email, d);
  }
  return out;
}

export async function addBehaviour(userId, deltas) {
  if (!deltas.size) return;
  const emails = [...deltas.keys()];
  const col = (k) => emails.map((e) => deltas.get(e)[k]);
  await query(
    `INSERT INTO hedwig_sender_stats (user_id, sender_email, domain, opened, starred, archived_unread, deleted_unread)
     SELECT $1, e, d, o, s, au, du FROM UNNEST($2::text[], $3::text[], $4::int[], $5::int[], $6::int[], $7::int[]) AS x(e, d, o, s, au, du)
     ON CONFLICT (user_id, sender_email) DO UPDATE SET
       opened = hedwig_sender_stats.opened + EXCLUDED.opened,
       starred = hedwig_sender_stats.starred + EXCLUDED.starred,
       archived_unread = hedwig_sender_stats.archived_unread + EXCLUDED.archived_unread,
       deleted_unread = hedwig_sender_stats.deleted_unread + EXCLUDED.deleted_unread,
       domain = COALESCE(hedwig_sender_stats.domain, EXCLUDED.domain),
       updated_at = NOW()`,
    [userId, emails, emails.map(domainOf), col('opened'), col('starred'), col('archived_unread'), col('deleted_unread')],
  );
}

async function countIncoming(userId, rows, { behaviourBefore }) {
  const { rows: fresh } = await query(
    `INSERT INTO hedwig_triage_sender_log (message_id, user_id, kind, sender_email, behaviour_at)
     SELECT id, $1, 'in', s, CASE WHEN b THEN NOW() END FROM UNNEST($2::uuid[], $3::text[], $4::bool[]) AS x(id, s, b)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [userId, rows.map((r) => r.id), rows.map((r) => r.from_email.toLowerCase()),
      rows.map((r) => Boolean(r.date) && new Date(r.date) < behaviourBefore)],
  );
  const freshIds = new Set(fresh.map((r) => r.message_id));
  const counted = rows.filter((r) => freshIds.has(r.id));
  if (!counted.length) return 0;
  const agg = new Map();
  for (const r of counted) {
    const email = r.from_email.toLowerCase();
    const a = agg.get(email) || { received: 0, last: null };
    a.received++;
    if (r.date && (!a.last || new Date(r.date) > a.last)) a.last = new Date(r.date);
    agg.set(email, a);
  }
  const emails = [...agg.keys()];
  await query(
    `INSERT INTO hedwig_sender_stats (user_id, sender_email, domain, received, last_received)
     SELECT $1, e, d, n, l FROM UNNEST($2::text[], $3::text[], $4::int[], $5::timestamptz[]) AS x(e, d, n, l)
     ON CONFLICT (user_id, sender_email) DO UPDATE SET
       received = hedwig_sender_stats.received + EXCLUDED.received,
       domain = COALESCE(hedwig_sender_stats.domain, EXCLUDED.domain),
       last_received = GREATEST(hedwig_sender_stats.last_received, EXCLUDED.last_received),
       updated_at = NOW()`,
    [userId, emails, emails.map(domainOf), emails.map((e) => agg.get(e).received), emails.map((e) => agg.get(e).last)],
  );
  const old = counted.filter((r) => r.date && new Date(r.date) < behaviourBefore);
  await addBehaviour(userId, behaviourDeltas(old));
  return counted.length;
}

/**
 * Credit the senders an outgoing message answers: the message named by In-Reply-To, plus every
 * incoming message in the thread since the user last wrote there.
 */
async function creditReplies(userId, rows, addresses) {
  const { rows: fresh } = await query(
    `INSERT INTO hedwig_triage_sender_log (message_id, user_id, kind, sender_email)
     SELECT id, $1, 'out', NULL FROM UNNEST($2::uuid[]) AS x(id)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [userId, rows.map((r) => r.id)],
  );
  if (!fresh.length) return 0;
  const { rows: credits } = await query(
    `SELECT o.id AS out_id, o.date AS replied_at, lower(p.from_email) AS sender
       FROM messages o
       JOIN email_accounts oa ON oa.id = o.account_id AND oa.user_id = $1
       JOIN messages p ON p.account_id = o.account_id AND p.id <> o.id AND NOT p.is_deleted
       LEFT JOIN folders pf ON pf.account_id = p.account_id AND pf.path = p.folder
      WHERE o.id = ANY($2::uuid[])
        AND p.from_email IS NOT NULL
        AND NOT ${outgoingSql('p', 'pf', '$3')}
        AND (
          (o.in_reply_to IS NOT NULL AND p.message_id = o.in_reply_to)
          OR (o.thread_id IS NOT NULL AND p.thread_key = o.thread_key AND p.date < o.date
              AND p.date > COALESCE((
                SELECT MAX(x.date) FROM messages x
                  LEFT JOIN folders xf ON xf.account_id = x.account_id AND xf.path = x.folder
                 WHERE x.account_id = o.account_id AND x.thread_key = o.thread_key AND x.date < o.date
                   AND x.id <> o.id AND NOT x.is_deleted AND ${outgoingSql('x', 'xf', '$3')}
              ), '-infinity'::timestamptz))
        )`,
    [userId, fresh.map((r) => r.message_id), [...addresses]],
  );
  const agg = new Map(); // sender -> { outs: Set, last }
  for (const c of credits) {
    if (!c.sender || addresses.has(c.sender)) continue;
    const a = agg.get(c.sender) || { outs: new Set(), last: null };
    a.outs.add(c.out_id);
    if (c.replied_at && (!a.last || new Date(c.replied_at) > a.last)) a.last = new Date(c.replied_at);
    agg.set(c.sender, a);
  }
  if (!agg.size) return 0;
  const emails = [...agg.keys()];
  await query(
    `INSERT INTO hedwig_sender_stats (user_id, sender_email, domain, replied, last_replied)
     SELECT $1, e, d, n, l FROM UNNEST($2::text[], $3::text[], $4::int[], $5::timestamptz[]) AS x(e, d, n, l)
     ON CONFLICT (user_id, sender_email) DO UPDATE SET
       replied = hedwig_sender_stats.replied + EXCLUDED.replied,
       domain = COALESCE(hedwig_sender_stats.domain, EXCLUDED.domain),
       last_replied = GREATEST(hedwig_sender_stats.last_replied, EXCLUDED.last_replied),
       updated_at = NOW()`,
    [userId, emails, emails.map(domainOf), emails.map((e) => agg.get(e).outs.size), emails.map((e) => agg.get(e).last)],
  );
  return emails.length;
}

export async function runSenderStats(rows) {
  const cfg = await getConfig();
  const behaviourBefore = new Date(Date.now() - cfg['triage.implicitAfterHours'] * 3600_000);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  for (const [userId, list] of byUser) {
    const addresses = list[0].user_addresses || new Set();
    const incoming = list.filter((r) => !r.is_outgoing && r.from_email && /@/.test(r.from_email));
    const outgoing = list.filter((r) => r.is_outgoing);
    if (incoming.length) await countIncoming(userId, incoming, { behaviourBefore });
    if (outgoing.length) await creditReplies(userId, outgoing, addresses);
  }
}
