// Stage 2: per-user logistic regression over hashed sparse features, trained with SGD, L2
// regularisation and class weighting. Pure JavaScript, deterministic for a given seed, and small
// enough to store as JSON in hedwig_triage_models (only non-zero weights are kept).
import { hashIndex } from './features.js';

export const MODEL_FORMAT = 1;
export const DEFAULT_BITS = 18;

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

function vectorise(features, bits) {
  const idx = [];
  const val = [];
  const seen = new Map();
  for (const [name, value] of Object.entries(features || {})) {
    if (name === 'bias') continue; // the model has its own unregularised intercept
    const v = Number(value);
    if (!v || !Number.isFinite(v)) continue;
    const i = hashIndex(name, bits);
    if (seen.has(i)) { val[seen.get(i)] += v; continue; }
    seen.set(i, idx.length);
    idx.push(i);
    val.push(v);
  }
  return { idx, val };
}

/**
 * Train a model.
 * @param {Array<{features: Record<string, number>, label: 0|1, weight?: number}>} samples
 * @param {{ bits?: number, epochs?: number, lr?: number, l2?: number, seed?: number }} [opts]
 */
export function train(samples, { bits = DEFAULT_BITS, epochs = 30, lr = 0.2, l2 = 1e-3, seed = 1 } = {}) {
  const data = samples.filter((s) => s && (s.label === 0 || s.label === 1)).map((s) => ({ ...vectorise(s.features, bits), y: s.label, w: Number(s.weight) > 0 ? Number(s.weight) : 1 }));
  const n = data.length;
  const pos = data.filter((d) => d.y === 1).length;
  const neg = n - pos;
  // Balance the classes so a mailbox that is 95% "not needed" does not learn to say no to everything.
  const cw = [neg ? n / (2 * neg) : 1, pos ? n / (2 * pos) : 1];
  const w = new Float64Array(1 << bits);
  let b = pos && neg ? Math.log(pos / neg) : 0;
  const rand = mulberry32(seed);
  const order = data.map((_, i) => i);
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const rate = lr / Math.sqrt(1 + epoch);
    for (const k of order) {
      const d = data[k];
      let z = b;
      for (let q = 0; q < d.idx.length; q++) z += w[d.idx[q]] * d.val[q];
      const g = (sigmoid(z) - d.y) * cw[d.y] * d.w;
      for (let q = 0; q < d.idx.length; q++) {
        const i = d.idx[q];
        w[i] -= rate * (g * d.val[q] + l2 * w[i]);
      }
      b -= rate * g;
    }
  }
  const weights = {};
  for (let i = 0; i < w.length; i++) {
    if (Math.abs(w[i]) > 1e-6) weights[i] = Math.round(w[i] * 1e5) / 1e5;
  }
  return { format: MODEL_FORMAT, bits, bias: Math.round(b * 1e5) / 1e5, weights, samples: n, positives: pos, negatives: neg };
}

export function score(model, features) {
  if (!model?.weights) return 0;
  const { idx, val } = vectorise(features, model.bits || DEFAULT_BITS);
  let z = Number(model.bias) || 0;
  for (let q = 0; q < idx.length; q++) z += (Number(model.weights[idx[q]]) || 0) * val[q];
  return z;
}

/** Probability that a message needs the user. */
export function predict(model, features) {
  return sigmoid(score(model, features));
}

/** Per-feature contributions to the log-odds, strongest first. */
export function contributions(model, features) {
  if (!model?.weights) return [];
  const bits = model.bits || DEFAULT_BITS;
  const out = [];
  for (const [name, value] of Object.entries(features || {})) {
    if (name === 'bias') continue;
    const v = Number(value);
    if (!v || !Number.isFinite(v)) continue;
    const c = (Number(model.weights[hashIndex(name, bits)]) || 0) * v;
    if (c !== 0) out.push({ name, contribution: c });
  }
  return out.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

export function evaluate(model, samples, threshold = 0.5) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  for (const s of samples) {
    const yhat = predict(model, s.features) >= threshold ? 1 : 0;
    if (yhat && s.label) tp++; else if (yhat) fp++; else if (s.label) fn++; else tn++;
  }
  const n = tp + fp + fn + tn;
  const r = (x) => Math.round(x * 1000) / 1000;
  return {
    n, tp, fp, fn, tn,
    precision: tp + fp ? r(tp / (tp + fp)) : null,
    recall: tp + fn ? r(tp / (tp + fn)) : null,
    accuracy: n ? r((tp + tn) / n) : null,
  };
}

/**
 * Train with a time-ordered holdout (the newest fifth), report metrics on it, then train the final
 * model on everything. Samples need `t` (a timestamp) for the ordering.
 */
export function trainWithHoldout(samples, opts = {}) {
  const sorted = [...samples].sort((a, b) => (a.t || 0) - (b.t || 0));
  const threshold = opts.threshold ?? 0.5;
  let holdout = null;
  if (sorted.length >= 10) {
    const cut = Math.floor(sorted.length * 0.8);
    const head = sorted.slice(0, cut);
    const tail = sorted.slice(cut);
    if (head.some((s) => s.label === 1) && head.some((s) => s.label === 0)) {
      holdout = evaluate(train(head, opts), tail, threshold);
    }
  }
  const model = train(sorted, opts);
  return {
    model,
    metrics: { holdout, samples: model.samples, positives: model.positives, negatives: model.negatives, threshold },
  };
}
