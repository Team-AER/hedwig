// Learning loop: behaviour → implicit labels → nightly per-user retrain. Explicit overrides are
// written by the service and weigh more (labels.EXPLICIT_WEIGHT).
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { deriveImplicitLabel, feedbackToSamples } from './labels.js';
import { trainWithHoldout } from './model.js';
import { outgoingSql, isGone, userAddresses } from './store.js';
import { behaviourDeltas, addBehaviour } from './senderStats.js';

// Behaviour older than this is not relabelled: a reply a month later says little about triage.
const IMPLICIT_WINDOW_DAYS = 30; // default for config triage.implicitWindowDays
const MAX_FEEDBACK_ROWS = 20000;

/** Count opened/starred/archived-unread into sender stats for messages now old enough. */
export async function behaviourSweep() {
  const cfg = await getConfig();
  const hours = String(cfg['triage.implicitAfterHours']);
  const { rows: marked } = await query(
    `WITH due AS (
       SELECT l.message_id FROM hedwig_triage_sender_log l JOIN messages m ON m.id = l.message_id
        WHERE l.kind = 'in' AND l.behaviour_at IS NULL AND m.date < NOW() - ($1 || ' hours')::interval
        LIMIT 5000 FOR UPDATE OF l SKIP LOCKED)
     UPDATE hedwig_triage_sender_log l SET behaviour_at = NOW() FROM due
      WHERE l.message_id = due.message_id
      RETURNING l.message_id, l.user_id, l.sender_email`,
    [hours],
  );
  if (!marked.length) return 0;
  const { rows: msgs } = await query(
    `SELECT m.id, m.is_read, m.is_starred, m.is_deleted, m.folder, f.special_use
       FROM messages m LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.id = ANY($1::uuid[])`,
    [marked.map((r) => r.message_id)],
  );
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const byUser = new Map();
  for (const l of marked) {
    const m = byId.get(l.message_id);
    if (!m) continue;
    if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
    byUser.get(l.user_id).push({ ...m, stat_email: l.sender_email });
  }
  for (const [userId, list] of byUser) await addBehaviour(userId, behaviourDeltas(list));
  return marked.length;
}

/** Derive implicit labels for one user's triaged messages that are old enough. */
export async function implicitFeedbackForUser(userId, addresses, { hours } = {}) {
  const cfg = await getConfig(userId);
  const afterHours = hours ?? cfg['triage.implicitAfterHours'];
  const windowDays = cfg['triage.implicitWindowDays'] ?? IMPLICIT_WINDOW_DAYS;
  const { rows } = await query(
    `SELECT t.message_id, t.features, m.is_read, m.is_starred, m.is_deleted, m.folder, f.special_use,
            fb.label AS implicit_label,
            EXISTS (
              SELECT 1 FROM messages o LEFT JOIN folders ofo ON ofo.account_id = o.account_id AND ofo.path = o.folder
               WHERE o.account_id = m.account_id AND o.id <> m.id AND NOT o.is_deleted AND o.date > m.date
                 AND ((m.thread_id IS NOT NULL AND o.thread_key = m.thread_key) OR (m.message_id IS NOT NULL AND o.in_reply_to = m.message_id))
                 AND ${outgoingSql('o', 'ofo', '$2')}
            ) AS replied
       FROM hedwig_triage t
       JOIN messages m ON m.id = t.message_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       LEFT JOIN hedwig_triage_feedback fb ON fb.message_id = t.message_id AND fb.source = 'implicit'
      WHERE t.user_id = $1 AND t.category <> 'waiting_on' AND NOT t.overridden
        AND m.date < NOW() - ($3 || ' hours')::interval
        AND m.date > NOW() - ($4 || ' days')::interval
        AND (fb.id IS NULL OR fb.label <> 'needs_you')
        AND NOT EXISTS (SELECT 1 FROM hedwig_triage_feedback e WHERE e.message_id = t.message_id AND e.source = 'explicit')
      LIMIT 2000`,
    [userId, [...addresses], String(afterHours), String(windowDays)],
  );
  const inserts = [];
  const upgrades = [];
  for (const r of rows) {
    const label = deriveImplicitLabel({
      replied: r.replied, starred: r.is_starred, opened: r.is_read, archived: isGone(r) && !r.is_deleted, deleted: r.is_deleted,
    });
    if (!label) continue;
    if (r.implicit_label) {
      if (label === 'needs_you') upgrades.push(r.message_id);
    } else {
      inserts.push({ id: r.message_id, label, features: r.features || {} });
    }
  }
  if (inserts.length) {
    await query(
      `INSERT INTO hedwig_triage_feedback (user_id, message_id, label, source, features)
       SELECT $1, id, label, 'implicit', features FROM UNNEST($2::uuid[], $3::text[], $4::jsonb[]) AS x(id, label, features)
       ON CONFLICT (message_id) WHERE source = 'implicit' DO NOTHING`,
      [userId, inserts.map((i) => i.id), inserts.map((i) => i.label), inserts.map((i) => JSON.stringify(i.features))],
    );
  }
  if (upgrades.length) {
    await query(
      `UPDATE hedwig_triage_feedback SET label = 'needs_you', created_at = NOW()
        WHERE user_id = $1 AND source = 'implicit' AND message_id = ANY($2::uuid[])`,
      [userId, upgrades],
    );
  }
  return { labelled: inserts.length, upgraded: upgrades.length };
}

async function triageUsers() {
  const { rows } = await query('SELECT DISTINCT user_id FROM hedwig_triage');
  return rows.map((r) => r.user_id);
}

export async function implicitFeedbackSweep() {
  await behaviourSweep();
  const users = await triageUsers();
  const addrs = await userAddresses(users);
  for (const userId of users) {
    const cfg = await getConfig(userId);
    if (!cfg['features.triage']) continue;
    try {
      await implicitFeedbackForUser(userId, addrs.get(userId) || new Set(), { hours: cfg['triage.implicitAfterHours'] });
    } catch (err) {
      console.warn(`[hedwig] implicit triage feedback failed for user ${userId}:`, err.message);
    }
  }
}

/**
 * Retrain one user's model from their feedback. Metrics come from a time-ordered holdout (the
 * newest fifth of the labels), then the stored model is trained on everything.
 */
export async function retrainUser(userId) {
  const cfg = await getConfig(userId);
  const { rows } = await query(
    `SELECT message_id, label, source, features, created_at FROM hedwig_triage_feedback
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '365 days'
      ORDER BY created_at DESC LIMIT ${MAX_FEEDBACK_ROWS}`,
    [userId],
  );
  const samples = feedbackToSamples(rows);
  const positives = samples.filter((s) => s.label === 1).length;
  const negatives = samples.length - positives;
  if (!positives || !negatives) {
    return {
      ok: false,
      samples: samples.length,
      metrics: { holdout: null, samples: samples.length, positives, negatives, reason: 'Need at least one needs-you and one not-needed example' },
    };
  }
  const { model, metrics } = trainWithHoldout(samples, { seed: 1, threshold: cfg['triage.needsYouThreshold'] });
  metrics.minSamples = cfg['triage.minSamples'];
  metrics.active = samples.length >= cfg['triage.minSamples'];
  metrics.explicit = samples.filter((s) => s.source === 'explicit').length;
  await query(
    `INSERT INTO hedwig_triage_models (user_id, version, model, metrics, samples, trained_at)
     VALUES ($1, 1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET version = hedwig_triage_models.version + 1, model = EXCLUDED.model,
            metrics = EXCLUDED.metrics, samples = EXCLUDED.samples, trained_at = NOW()`,
    [userId, JSON.stringify(model), JSON.stringify(metrics), samples.length],
  );
  return { ok: true, samples: samples.length, metrics };
}

/** Nightly retrain: users whose retrain hour has passed today and who have enough labels. */
export async function retrainDue(now = new Date()) {
  const { rows } = await query(
    `SELECT fb.user_id, COUNT(*)::int AS n, MAX(fb.created_at) AS last_feedback, tm.trained_at
       FROM hedwig_triage_feedback fb LEFT JOIN hedwig_triage_models tm ON tm.user_id = fb.user_id
      GROUP BY fb.user_id, tm.trained_at`,
  );
  let trained = 0;
  for (const r of rows) {
    const cfg = await getConfig(r.user_id);
    if (!cfg['features.triage'] || r.n < cfg['triage.minSamples']) continue;
    const due = new Date(now);
    due.setHours(cfg['triage.retrainHour'], 0, 0, 0);
    if (now < due) continue;
    if (r.trained_at && new Date(r.trained_at) >= due) continue;
    if (r.trained_at && r.last_feedback && new Date(r.last_feedback) <= new Date(r.trained_at)) continue;
    try {
      await retrainUser(r.user_id);
      trained++;
    } catch (err) {
      console.warn(`[hedwig] triage retrain failed for user ${r.user_id}:`, err.message);
    }
  }
  return trained;
}
