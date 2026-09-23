// Eval metric maths. Pure functions, no I/O. Ratios are 0..1; gates compare in points (×100).

const round = (x, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const ratio = (a, b) => (b > 0 ? a / b : null);

/** Fraction of relevant ids found in the first k of `ranked` (0 when nothing is relevant). */
export function recallAtK(ranked, relevant, k = 10) {
  const rel = new Set(relevant);
  if (!rel.size) return null;
  const top = new Set(ranked.slice(0, k));
  let hit = 0;
  for (const r of rel) if (top.has(r)) hit++;
  return hit / rel.size;
}

/** 1 / rank of the first relevant id, 0 when none is ranked. */
export function reciprocalRank(ranked, relevant) {
  const rel = new Set(relevant);
  for (let i = 0; i < ranked.length; i++) if (rel.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

export function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Unique ids in rank order (chunks of one message collapse to its best rank). */
export function uniqueInOrder(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) if (id != null && !seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/**
 * Binary classification metrics. pairs: [{ truth: bool, pred: bool }] (pred null = no prediction,
 * counted as coverage loss, not as an error).
 */
export function binaryMetrics(pairs) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0; let missing = 0;
  for (const { truth, pred } of pairs) {
    if (pred === null || pred === undefined) { missing++; continue; }
    if (truth && pred) tp++;
    else if (!truth && pred) fp++;
    else if (truth && !pred) fn++;
    else tn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const n = tp + fp + fn + tn;
  return {
    n, tp, fp, fn, tn, missing,
    precision: round(precision), recall: round(recall), f1: round(f1),
    fpr: round(ratio(fp, fp + tn)), accuracy: round(ratio(tp + tn, n)),
    coverage: round(ratio(n, n + missing)),
  };
}

/** Multi-class metrics. pairs: [{ truth, pred }]; `notTruth` rows ({ not: 'people' }) only count as right or wrong. */
export function multiclassMetrics(pairs, classes = null) {
  const scored = pairs.filter((p) => p.pred != null);
  const labels = classes || [...new Set(scored.flatMap((p) => [p.truth, p.pred]).filter((x) => typeof x === 'string'))].sort();
  const perClass = {};
  const f1s = [];
  for (const c of labels) {
    const m = binaryMetrics(scored.filter((p) => typeof p.truth === 'string').map((p) => ({ truth: p.truth === c, pred: p.pred === c })));
    perClass[c] = { precision: m.precision, recall: m.recall, f1: m.f1, support: m.tp + m.fn };
    if (m.tp + m.fn > 0 && m.f1 !== null) f1s.push(m.f1);
    else if (m.tp + m.fn > 0) f1s.push(0);
  }
  let right = 0;
  for (const p of scored) {
    if (typeof p.truth === 'string' ? p.pred === p.truth : p.pred !== p.truth?.not) right++;
  }
  return {
    n: scored.length,
    missing: pairs.length - scored.length,
    accuracy: round(ratio(right, scored.length)),
    macroF1: round(mean(f1s)),
    perClass,
  };
}

// Metrics where lower is better; everything else numeric in 0..1 is higher-is-better.
export const LOWER_IS_BETTER = new Set(['fpr', 'wrongRepeat', 'fakeNotFound']);
// Metrics that are counts or sizes, never gated.
const NOT_GATED = new Set(['n', 'tp', 'fp', 'fn', 'tn', 'missing', 'coverage', 'support', 'items']);

/** Flatten nested metrics to dotted keys with numeric values. */
export function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else if (Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** Per-metric change from the previous run, in points for ratios. */
export function diffMetrics(curr, prev) {
  const a = flatten(curr);
  const b = flatten(prev);
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (!(k in b)) continue;
    const leaf = k.split('.').pop();
    out[k] = NOT_GATED.has(leaf) ? v - b[k] : round((v - b[k]) * 100, 2);
  }
  return out;
}

/**
 * Gates: no gold metric down more than `gatePoints`; the spam false-positive rate (silver or gold)
 * never up. No previous accepted run = baseline, accepted.
 * metrics: { silver: {...}, gold: {...} }
 * @returns {{ pass: boolean, failures: string[] }}
 */
export function checkGates(suite, curr, prev, { gatePoints = 2 } = {}) {
  if (!prev) return { pass: true, failures: [], baseline: true };
  const failures = [];
  const g = flatten(curr.gold);
  const pg = flatten(prev.gold);
  for (const [k, v] of Object.entries(g)) {
    const leaf = k.split('.').pop();
    if (NOT_GATED.has(leaf) || !(k in pg)) continue;
    const delta = (v - pg[k]) * 100;
    if (LOWER_IS_BETTER.has(leaf) ? delta > gatePoints : -delta > gatePoints) {
      failures.push(`gold ${k} ${LOWER_IS_BETTER.has(leaf) ? 'up' : 'down'} ${Math.abs(round(delta, 2))} points (limit ${gatePoints})`);
    }
  }
  if (suite === 'spam' || suite === 'rescue') {
    for (const grade of ['silver', 'gold']) {
      const now = curr[grade]?.fpr;
      const before = prev[grade]?.fpr;
      if (Number.isFinite(now) && Number.isFinite(before) && now > before + 1e-9) {
        failures.push(`${grade} false-positive rate up ${round((now - before) * 100, 2)} points (must never rise)`);
      }
    }
  }
  return { pass: failures.length === 0, failures, baseline: false };
}
