// Triage service: the functions routes, agent tools and other modules use. Every function takes
// the user id first and scopes every read and write to it.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { usedToday } from '../llm.js';
import { HEDWIG_HOOKS, runHedwigHook } from '../hooks.js';
import { domainOf } from '../text.js';
import { CATEGORIES } from './signals.js';
import { MESSAGE_LITE, TRIAGE_COLUMNS, messageLite, toTriageInfo } from './store.js';
import { retrainUser } from './learning.js';
import { trainUpstreamSpam } from './spamSync.js';

export { CATEGORIES };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>]{1,200}@[^\s@<>]{1,200}\.[^\s@<>]{1,63}$/;
const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EFFECTIVE = 'COALESCE(CASE WHEN t.overridden THEN t.override_category END, t.category)';

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
}

/**
 * One triage list plus per-category counts of unresolved items.
 * @param {string} userId
 * @param {{ view?: string, accountId?: string, limit?: number, before?: string }} opts
 */
export async function listTriage(userId, { view = 'needs_you', accountId = null, limit = 50, before = null } = {}) {
  if (!CATEGORIES.includes(view)) throw httpError(400, `view must be one of ${CATEGORIES.join(', ')}`);
  if (accountId && !isUuid(accountId)) throw httpError(400, 'Invalid account id');
  let beforeDate = null;
  if (before) {
    const t = Date.parse(before);
    if (!Number.isFinite(t)) throw httpError(400, 'before must be an ISO date');
    beforeDate = new Date(t).toISOString();
  }
  const n = clampInt(limit, 50, 1, 200);
  const order = view === 'needs_you' || view === 'waiting_on' ? 't.priority DESC, m.date DESC' : 'm.date DESC';
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT ${MESSAGE_LITE}, ${TRIAGE_COLUMNS}, th.count AS thread_count, th.participants
         FROM hedwig_triage t
         JOIN messages m ON m.id = t.message_id
         JOIN email_accounts a ON a.id = m.account_id AND a.user_id = t.user_id
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT COALESCE(y.message_id, y.id::text))::int AS count,
                  (SELECT COALESCE(json_agg(json_build_object('name', p.name, 'email', p.email)), '[]'::json)
                     FROM (SELECT DISTINCT ON (lower(x.from_email)) x.from_name AS name, lower(x.from_email) AS email
                             FROM messages x
                            WHERE x.account_id = m.account_id AND x.thread_key = m.thread_key AND NOT x.is_deleted AND x.from_email IS NOT NULL
                            ORDER BY lower(x.from_email), x.date DESC
                            LIMIT 6) p) AS participants
             FROM messages y
            WHERE y.account_id = m.account_id AND y.thread_key = m.thread_key AND NOT y.is_deleted
         ) th ON true
        WHERE t.user_id = $1 AND ${EFFECTIVE} = $2 AND t.resolved_at IS NULL AND NOT m.is_deleted
          AND ($3::uuid IS NULL OR m.account_id = $3)
          AND ($4::timestamptz IS NULL OR m.date < $4)
        ORDER BY ${order}
        LIMIT $5`,
      [userId, view, accountId || null, beforeDate, n],
    ),
    query(
      `SELECT ${EFFECTIVE} AS category, COUNT(*)::int AS n
         FROM hedwig_triage t JOIN messages m ON m.id = t.message_id
        WHERE t.user_id = $1 AND t.resolved_at IS NULL AND NOT m.is_deleted
          AND ($2::uuid IS NULL OR m.account_id = $2)
        GROUP BY 1`,
      [userId, accountId || null],
    ),
  ]);
  const counts = emptyCounts();
  for (const r of countRows) if (r.category in counts) counts[r.category] = r.n;
  const now = new Date();
  return {
    items: rows.map((r) => ({
      message: messageLite(r),
      triage: toTriageInfo(r, now),
      thread: { count: r.thread_count || 1, participants: r.participants || [] },
    })),
    counts,
  };
}

/** The triage decision for one message plus what the user usually does with its sender. */
export async function getTriage(userId, messageId) {
  if (!isUuid(messageId)) throw httpError(400, 'Invalid message id');
  const { rows } = await query(
    `SELECT ${TRIAGE_COLUMNS}, lower(m.from_email) AS from_email
       FROM hedwig_triage t
       JOIN messages m ON m.id = t.message_id
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = t.user_id
      WHERE t.message_id = $1 AND t.user_id = $2`,
    [messageId, userId],
  );
  if (!rows.length) return null;
  const { rows: stats } = await query(
    'SELECT received, opened, replied, archived_unread FROM hedwig_sender_stats WHERE user_id = $1 AND sender_email = $2',
    [userId, rows[0].from_email || ''],
  );
  const s = stats[0] || {};
  return {
    triage: toTriageInfo(rows[0]),
    sender: {
      received: Number(s.received || 0),
      opened: Number(s.opened || 0),
      replied: Number(s.replied || 0),
      archived_unread: Number(s.archived_unread || 0),
    },
  };
}

const CATEGORY_WORDS = { needs_you: 'Needs you', waiting_on: 'Waiting on', digest: 'Digest', notifications: 'Notifications', everything: 'Everything', spam: 'Spam' };

/**
 * The user moves a message to another list. Recorded as an explicit label (the strongest training
 * signal), mirrored into upstream's spam model when it crosses the spam line, and optionally pushed
 * to the provider's Junk folder.
 * @param {{ category: string, reason?: string }} patch
 * @param {{ pushJunk?: boolean }} [opts]  false for callers that must not move mail (agent tools)
 */
export async function overrideTriage(userId, messageId, patch = {}, { pushJunk = true } = {}) {
  if (!isUuid(messageId)) throw httpError(400, 'Invalid message id');
  const category = patch?.category;
  if (!CATEGORIES.includes(category)) throw httpError(400, `category must be one of ${CATEGORIES.join(', ')}`);
  const reason = typeof patch.reason === 'string' ? patch.reason.trim().slice(0, 200) : '';

  const { rows: msgs } = await query(
    `SELECT m.id, m.account_id, t.message_id AS triaged, t.features, ${EFFECTIVE} AS previous
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN hedwig_triage t ON t.message_id = m.id AND t.user_id = a.user_id
      WHERE m.id = $1 AND a.user_id = $2`,
    [messageId, userId],
  );
  const msg = msgs[0];
  if (!msg) throw httpError(404, 'Message not found');

  const userReason = { label: `You moved this to ${CATEGORY_WORDS[category]}${reason ? `: ${reason}` : ''}`, weight: 1, direction: category === 'needs_you' ? 'for' : 'against' };
  const { rows } = await query(
    `INSERT INTO hedwig_triage (message_id, user_id, account_id, category, priority, needs_you, confidence, stage, reasons,
                               reason_label, decided_at, overridden, override_category, override_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'needs_you' THEN 1 ELSE 0 END, $4 = 'needs_you', 1, 1, $5, 'You set this', NOW(), true, $4, NOW())
     ON CONFLICT (message_id) DO UPDATE SET
       overridden = true, override_category = $4, override_at = NOW(),
       needs_you = $4 = 'needs_you', reason_label = 'You set this',
       reasons = $5::jsonb || COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(hedwig_triage.reasons) x
                                         WHERE x->>'label' NOT LIKE 'You moved this to %'), '[]'::jsonb),
       resolved_at = CASE WHEN $4 IN ('needs_you', 'waiting_on') THEN NULL ELSE hedwig_triage.resolved_at END
     WHERE hedwig_triage.user_id = EXCLUDED.user_id
     RETURNING *`,
    [messageId, userId, msg.account_id, category, JSON.stringify([userReason])],
  );
  const stored = rows[0];
  if (!stored) throw httpError(404, 'Message not found');

  await query(
    `INSERT INTO hedwig_triage_feedback (user_id, message_id, label, source, features) VALUES ($1, $2, $3, 'explicit', $4)`,
    [userId, messageId, category, JSON.stringify(msg.features || {})],
  );

  const wasSpam = msg.previous === 'spam';
  const isSpam = category === 'spam';
  if (wasSpam !== isSpam) {
    try {
      await trainUpstreamSpam(userId, messageId, isSpam ? 'spam' : 'ham');
    } catch (err) {
      console.warn(`[hedwig] upstream spam training failed for user ${userId}:`, err.message);
    }
  }
  if (isSpam && pushJunk) {
    const cfg = await getConfig(userId);
    if (cfg['triage.pushJunkToProvider']) {
      await enqueue('triage.pushJunk', { messageId }, { userId, dedupeKey: `triage.junk:${messageId}`, priority: 3, maxAttempts: 3 });
    }
  }
  const info = toTriageInfo(stored);
  runHedwigHook(HEDWIG_HOOKS.afterTriage, { userId, messageId, triage: info }).catch(() => {});
  return info;
}

/** Mark an item handled so it leaves its list. */
export async function resolveTriage(userId, messageId) {
  if (!isUuid(messageId)) throw httpError(400, 'Invalid message id');
  const { rowCount } = await query(
    'UPDATE hedwig_triage SET resolved_at = COALESCE(resolved_at, NOW()) WHERE message_id = $1 AND user_id = $2',
    [messageId, userId],
  );
  if (!rowCount) throw httpError(404, 'Message not triaged');
  return { ok: true };
}

export async function triageStats(userId) {
  const [precision, open, corrections, stages, samples, model, beyond, calls] = await Promise.all([
    // Of the needs-you calls made in the last 7 days that have a verdict from the user (explicit
    // or behavioural), the share the user agreed with.
    query(
      `SELECT COUNT(*)::int AS judged, COUNT(*) FILTER (WHERE v.label = 'needs_you')::int AS agreed
         FROM hedwig_triage t
         JOIN LATERAL (
           SELECT label FROM hedwig_triage_feedback fb
            WHERE fb.message_id = t.message_id AND fb.user_id = t.user_id
            ORDER BY (fb.source = 'explicit') DESC, fb.created_at DESC LIMIT 1) v ON true
        WHERE t.user_id = $1 AND t.category = 'needs_you' AND t.decided_at > NOW() - INTERVAL '7 days'`,
      [userId],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM hedwig_triage t JOIN messages m ON m.id = t.message_id
        WHERE t.user_id = $1 AND t.resolved_at IS NULL AND NOT m.is_deleted AND ${EFFECTIVE} = 'needs_you'`,
      [userId],
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM hedwig_triage_feedback WHERE user_id = $1 AND source = 'explicit' AND created_at > NOW() - INTERVAL '30 days'`,
      [userId],
    ),
    query(
      `SELECT stage, COUNT(*)::int AS n FROM hedwig_triage WHERE user_id = $1 AND decided_at > NOW() - INTERVAL '30 days' GROUP BY stage`,
      [userId],
    ),
    query(`SELECT COUNT(DISTINCT COALESCE(message_id::text, id::text))::int AS n FROM hedwig_triage_feedback WHERE user_id = $1`, [userId]),
    query('SELECT samples, trained_at FROM hedwig_triage_models WHERE user_id = $1', [userId]),
    // Spam Hedwig caught that upstream's filter and the provider did not.
    query(
      `SELECT COUNT(*)::int AS n FROM hedwig_triage t JOIN messages m ON m.id = t.message_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE t.user_id = $1 AND t.category = 'spam' AND NOT t.overridden
          AND COALESCE(m.spam_verdict, '') <> 'spam' AND COALESCE(m.spam_user_override, '') <> 'spam'
          AND t.decided_at > NOW() - INTERVAL '30 days'`,
      [userId],
    ),
    usedToday(userId, 'triage').catch(() => 0),
  ]);
  const p = precision.rows[0] || { judged: 0, agreed: 0 };
  const stageCounts = { 1: 0, 2: 0, 3: 0 };
  for (const r of stages.rows) stageCounts[r.stage] = r.n;
  return {
    needsYouPrecision7d: p.judged ? Math.round((p.agreed / p.judged) * 1000) / 1000 : null,
    needsYouOpen: open.rows[0]?.n || 0,
    corrections30d: corrections.rows[0]?.n || 0,
    modelCallsToday: calls,
    stageCounts,
    samples: samples.rows[0]?.n || 0,
    trainedAt: model.rows[0]?.trained_at || null,
    spamBeyondProvider: beyond.rows[0]?.n || 0,
  };
}

/** Most recent decisions, for the "how is triage doing" view. */
export async function listDecisions(userId, { limit = 50 } = {}) {
  const n = clampInt(limit, 50, 1, 200);
  const { rows } = await query(
    `SELECT ${MESSAGE_LITE}, ${TRIAGE_COLUMNS}
       FROM hedwig_triage t
       JOIN messages m ON m.id = t.message_id
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = t.user_id
      WHERE t.user_id = $1
      ORDER BY t.decided_at DESC
      LIMIT $2`,
    [userId, n],
  );
  const now = new Date();
  return rows.map((r) => ({ message: messageLite(r), triage: toTriageInfo(r, now) }));
}

function ruleTarget({ sender, domain }) {
  const s = typeof sender === 'string' ? sender.trim().toLowerCase() : '';
  const d = typeof domain === 'string' ? domain.trim().toLowerCase().replace(/^@/, '') : '';
  if (s) {
    if (!EMAIL_RE.test(s)) throw httpError(400, 'sender must be an email address');
    return { kind: 'sender', value: s, domain: domainOf(s) };
  }
  if (d) {
    if (!DOMAIN_RE.test(d)) throw httpError(400, 'domain must be a domain name');
    return { kind: 'domain', value: d, domain: d };
  }
  throw httpError(400, 'sender or domain is required');
}

const MATCH_SQL = `(CASE WHEN $2 = 'sender' THEN lower(m.from_email) = $3
                         ELSE split_part(lower(m.from_email), '@', 2) = $3 OR split_part(lower(m.from_email), '@', 2) LIKE '%.' || $3 END)`;

/**
 * "Always treat mail from X as Y". Preview counts what would move and lists other senders at the
 * same domain; apply stores the rule (honoured by stage 1 for new mail) and overrides the
 * messages already triaged.
 */
export async function senderRule(userId, { sender, domain, category, preview = false } = {}) {
  if (!CATEGORIES.includes(category) || category === 'waiting_on') {
    throw httpError(400, 'category must be one of needs_you, digest, notifications, everything, spam');
  }
  const target = ruleTarget({ sender, domain });
  const params = [userId, target.kind, target.value, category];
  const where = `t.user_id = $1 AND ${MATCH_SQL} AND ${EFFECTIVE} <> $4 AND t.category <> 'waiting_on'`;

  if (preview) {
    const [count, sample, siblings] = await Promise.all([
      query(`SELECT COUNT(*)::int AS n FROM hedwig_triage t JOIN messages m ON m.id = t.message_id WHERE ${where}`, params),
      query(
        `SELECT ${MESSAGE_LITE} FROM hedwig_triage t
           JOIN messages m ON m.id = t.message_id
           JOIN email_accounts a ON a.id = m.account_id AND a.user_id = t.user_id
          WHERE ${where} ORDER BY m.date DESC LIMIT 5`,
        params,
      ),
      query(
        `SELECT sender_email FROM hedwig_sender_stats
          WHERE user_id = $1 AND domain = $2 AND sender_email <> $3
          ORDER BY received DESC, sender_email LIMIT 20`,
        [userId, target.domain, target.kind === 'sender' ? target.value : ''],
      ),
    ]);
    return {
      affected: count.rows[0]?.n || 0,
      siblings: siblings.rows.map((r) => r.sender_email),
      sample: sample.rows.map(messageLite),
    };
  }

  await query(
    `INSERT INTO hedwig_triage_rules (user_id, kind, value, category) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind, value) DO UPDATE SET category = EXCLUDED.category, updated_at = NOW()`,
    params,
  );
  const reason = JSON.stringify([{ label: `Your rule: mail from ${target.value} → ${CATEGORY_WORDS[category]}`, weight: 1, direction: category === 'needs_you' ? 'for' : 'against' }]);
  const { rowCount } = await query(
    `UPDATE hedwig_triage t SET overridden = true, override_category = $4, override_at = NOW(),
            needs_you = $4 = 'needs_you', reason_label = 'Your rule',
            reasons = $5::jsonb || COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(t.reasons) x
                                             WHERE x->>'label' NOT LIKE 'Your rule:%'), '[]'::jsonb),
            resolved_at = CASE WHEN $4 = 'needs_you' THEN NULL ELSE t.resolved_at END
       FROM messages m
      WHERE m.id = t.message_id AND ${where}`,
    [...params, reason],
  );
  return { applied: rowCount || 0 };
}

export async function listRules(userId) {
  const { rows } = await query('SELECT id, kind, value, category, created_at FROM hedwig_triage_rules WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return rows;
}

export async function retrain(userId) {
  return retrainUser(userId);
}
