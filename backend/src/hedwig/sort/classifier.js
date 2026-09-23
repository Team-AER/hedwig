// Layer 2: the classifier. Reuses triage's per-user logistic regression (triage/model.js) and
// feature builder (triage/features.js) unchanged, and adds sorting heads trained with the same
// code: one-vs-rest stream heads (people / reading / records) and a spam head. Until a user has
// enough labels the heads are inactive and a prior from sender history and headers stands in.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { buildFeatures } from '../triage/features.js';
import { predict, contributions, trainWithHoldout } from '../triage/model.js';
import { describeFeature } from '../triage/features.js';
import { SORT_ENGINE_VERSION, engineStamp } from './version.js';

export const STREAM_HEADS = Object.freeze(['people', 'reading', 'records']);
export const HEADS = Object.freeze([...STREAM_HEADS, 'spam']);
const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

/** Feature map for sorting: triage's features plus header-layer facts. */
export function sortFeatures({ row, s1, sender = null, header = null }) {
  const f = buildFeatures({ row, s1, sender, thread: null });
  if (header) {
    if (header.list) f['sx:list'] = 1;
    if (header.auto) f['sx:auto'] = 1;
    if (header.calendar) f['sx:calendar'] = 1;
    if (header.spamFolder) f['sx:spamFolder'] = 1;
    if (header.replyToOwn) f['sx:replyToOwn'] = 1;
    if (header.kind) f[`sx:kind:${header.kind}`] = 1;
    if (header.auth?.dmarc) f[`sx:dmarc:${header.auth.dmarc}`] = 1;
  }
  return f;
}

/**
 * Cold-start prior from sender history, triage's stage-1 read and the header layer.
 * @returns {{ stream, confidence, reason, signals: Array }}
 */
export function priorStream({ s1, sender = null, header = null }) {
  const signals = [];
  const received = Number(sender?.received || 0);
  const replied = Number(sender?.replied || 0);
  const ignored = Number(sender?.archived_unread || 0) + Number(sender?.deleted_unread || 0);
  const replyRate = received ? replied / received : 0;
  if (received >= 2 && replyRate >= 0.3) {
    signals.push({ name: 'replyRate', label: `You replied to ${replied} of ${received} messages from them`, weight: round(replyRate) });
    return { stream: 'people', confidence: round(Math.min(0.92, 0.7 + replyRate / 2)), reason: 'You often reply to them', signals };
  }
  if (header?.prior) {
    let conf = header.prior.confidence;
    if (received >= 4 && ignored / received >= 0.6 && header.prior.stream !== 'people') {
      conf = Math.min(0.9, conf + 0.1);
      signals.push({ name: 'ignored', label: `You left ${ignored} of ${received} from them unread`, weight: 0.3 });
    }
    return { stream: header.prior.stream, bundle: header.prior.bundle || null, confidence: round(conf), reason: header.prior.reason, signals };
  }
  if (s1?.senderKind === 'person' && !s1?.flags?.bulk && !s1?.flags?.notification) {
    const direct = s1.flags?.to || s1.flags?.ccOnly;
    return { stream: 'people', confidence: direct ? 0.62 : 0.5, reason: direct ? 'A person writing to you' : 'A person, though not to you directly', signals };
  }
  return { stream: 'records', confidence: 0.4, reason: 'Looks automated', signals };
}

// A stream head needs this many examples on each side before it may decide anything: production's
// first heads had 2 Reading examples out of 460 and still claimed 0.92.
export const HEAD_MIN_CLASS = 10;

/**
 * Heads are active when trained under this engine version on enough samples, with enough
 * positive and negative examples per stream head. Heads trained on an older engine's decisions
 * (e.g. imported sender decisions that put newsletters in People) are ignored until they retrain.
 */
export function headsActive(models, minSamples) {
  return STREAM_HEADS.every((h) => {
    const m = models?.[h];
    if (!m?.model?.weights || Number(m.samples) < minSamples) return false;
    const metrics = m.metrics || {};
    if (metrics.engine !== SORT_ENGINE_VERSION) return false;
    const pos = Number(metrics.positives ?? m.model.positives ?? 0);
    const neg = Number(metrics.negatives ?? m.model.negatives ?? 0);
    return pos >= HEAD_MIN_CLASS && neg >= HEAD_MIN_CLASS;
  });
}

/** Heads stored under another engine version (they need a retrain before they count). */
export function headsStale(models) {
  return Object.values(models || {}).some((m) => m?.metrics?.engine !== SORT_ENGINE_VERSION);
}

/**
 * Stream and spam probabilities from the heads.
 * @returns {{ stream, confidence, probs: Record<string, number>, spam: number|null, signals: Array }}
 */
export function predictHeads(models, features) {
  const raw = {};
  for (const h of STREAM_HEADS) raw[h] = models?.[h]?.model ? predict(models[h].model, features) : 0;
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const probs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, round(v / sum)]));
  const stream = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  const top = contributions(models[stream].model, features).filter((c) => c.contribution > 0.2).slice(0, 3);
  const signals = top.map((c) => ({ name: `learned:${c.name}`, label: `Learned: ${describeFeature(c.name)}`, weight: round(c.contribution) }));
  const spam = models?.spam?.model ? round(predict(models.spam.model, features)) : null;
  return { stream, confidence: probs[stream], probs, spam, signals };
}

export async function loadHeads(userId) {
  const { rows } = await query('SELECT head, version, model, metrics, samples, trained_at FROM hedwig_sort_models WHERE user_id = $1', [userId]);
  return Object.fromEntries(rows.map((r) => [r.head, r]));
}

const LABEL_WEIGHT = { user: 3, rule: 1.5, reflex: 0.7, reasoning: 0.9 };

/**
 * The server spam folder alone is a weak label: a spam-folder row teaches the spam head only when
 * something independent judged it (the user, a model, a phishing verdict, a rescue). Otherwise the
 * head learns "newsletter ⇒ spam" from whatever the provider's Bulk folder happens to hold.
 */
export function spamLabelOf(r) {
  if (r.spam === 'rescued') return 0;
  const judged = ['user', 'reflex', 'reasoning'].includes(r.layer) || r.spam === 'phishing';
  if (r.in_spam_folder && !judged) return null;
  return r.spam === 'suspected' || r.spam === 'phishing' || r.stream === 'spam' ? 1 : 0;
}

/** Turn stored decisions into training samples per head. Exported for tests. */
export function samplesFromDecisions(rows) {
  const out = Object.fromEntries(HEADS.map((h) => [h, []]));
  for (const r of rows) {
    const features = r.features && typeof r.features === 'object' ? r.features : null;
    if (!features) continue;
    const w = LABEL_WEIGHT[r.layer] || 0.5;
    const t = r.decided_at ? new Date(r.decided_at).getTime() : 0;
    const stream = r.stream === 'screener' ? r.proposed_stream : r.stream;
    if (STREAM_HEADS.includes(stream)) {
      for (const h of STREAM_HEADS) out[h].push({ features, label: stream === h ? 1 : 0, weight: w, t });
    }
    const spam = spamLabelOf(r);
    if (spam !== null) out.spam.push({ features, label: spam, weight: r.spam === 'rescued' ? 2 : w, t });
  }
  return out;
}

/** Retrain one user's sorting heads. */
export async function trainHeads(userId) {
  const cfg = await getConfig(userId);
  const { rows } = await query(
    `SELECT features, stream, proposed_stream, spam, layer, confidence, decided_at, in_spam_folder FROM hedwig_sort
      WHERE user_id = $1 AND features IS NOT NULL AND NOT own
        AND (layer = 'user' OR (layer IN ('reflex','reasoning') AND confidence >= 0.8)
             OR (layer = 'rule' AND engine_version = $2))
      ORDER BY decided_at DESC LIMIT 20000`,
    [userId, engineStamp()],
  );
  const byHead = samplesFromDecisions(rows);
  const trained = {};
  for (const head of HEADS) {
    const samples = byHead[head];
    const pos = samples.filter((s) => s.label === 1).length;
    if (samples.length < cfg['sort.classifierMinSamples'] || !pos || pos === samples.length) {
      trained[head] = { ok: false, samples: samples.length, positives: pos };
      // A head an older engine trained is not kept when this engine cannot train it.
      await query(
        `DELETE FROM hedwig_sort_models WHERE user_id = $1 AND head = $2 AND (metrics->>'engine') IS DISTINCT FROM $3`,
        [userId, head, SORT_ENGINE_VERSION],
      );
      continue;
    }
    const trainedOn = trainWithHoldout(samples, { seed: 1 });
    const model = trainedOn.model;
    const metrics = { ...trainedOn.metrics, engine: SORT_ENGINE_VERSION };
    await query(
      `INSERT INTO hedwig_sort_models (user_id, head, version, model, metrics, samples, trained_at)
       VALUES ($1, $2, 1, $3, $4, $5, NOW())
       ON CONFLICT (user_id, head) DO UPDATE SET version = hedwig_sort_models.version + 1, model = EXCLUDED.model,
              metrics = EXCLUDED.metrics, samples = EXCLUDED.samples, trained_at = NOW()`,
      [userId, head, JSON.stringify(model), JSON.stringify(metrics), samples.length],
    );
    trained[head] = { ok: true, samples: samples.length, positives: pos, holdout: metrics.holdout };
  }
  return trained;
}
