// hedwig_labels: writing rows and choosing which label a target "has" for a given field.
import { query } from '../../services/db.js';

export const SUITES = Object.freeze(['sort', 'needs_you', 'spam', 'rescue', 'ask', 'extraction', 'topic']);
export const GRADES = Object.freeze(['weak', 'silver', 'gold']);
export const SOURCES = Object.freeze(['behaviour', 'judge', 'question', 'correction', 'generated']);

const GRADE_RANK = { weak: 0, silver: 1, gold: 2 };
// Within a grade: what the user said beats what the models agreed beats what behaviour implies.
const SOURCE_RANK = { question: 4, correction: 4, judge: 2, behaviour: 1, generated: 0 };

/**
 * Upsert labels for one user. A row is keyed by (suite, target, source, evidence.rule), so a rule
 * that fires again refreshes its row. A gold row is never downgraded by a later weaker write.
 * @param {string} userId
 * @param {Array<{ suite, targetId, label, grade, source, evidence? }>} rows
 */
export async function upsertLabels(userId, rows) {
  const valid = rows.filter((r) => r && SUITES.includes(r.suite) && GRADES.includes(r.grade) && SOURCES.includes(r.source) && r.targetId != null && r.label);
  if (!valid.length) return 0;
  // One statement per 500 rows; duplicates inside a statement would make ON CONFLICT fail.
  const seen = new Map();
  for (const r of valid) seen.set(`${r.suite}|${r.targetId}|${r.source}|${r.evidence?.rule || ''}`, r);
  const list = [...seen.values()];
  let n = 0;
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const { rowCount } = await query(
      `INSERT INTO hedwig_labels (user_id, suite, target_id, label, grade, source, evidence)
       SELECT $1, x.suite, x.target_id, x.label, x.grade, x.source, x.evidence
         FROM UNNEST($2::text[], $3::text[], $4::jsonb[], $5::text[], $6::text[], $7::jsonb[])
              AS x(suite, target_id, label, grade, source, evidence)
       ON CONFLICT (user_id, suite, target_id, source, (COALESCE(evidence->>'rule', '')))
       DO UPDATE SET label = CASE WHEN hedwig_labels.grade = 'gold' AND EXCLUDED.grade <> 'gold' THEN hedwig_labels.label ELSE EXCLUDED.label END,
                     grade = CASE WHEN hedwig_labels.grade = 'gold' THEN 'gold' ELSE EXCLUDED.grade END,
                     evidence = EXCLUDED.evidence`,
      [userId, part.map((r) => r.suite), part.map((r) => String(r.targetId)), part.map((r) => JSON.stringify(r.label)),
        part.map((r) => r.grade), part.map((r) => r.source), part.map((r) => JSON.stringify(r.evidence || {}))],
    );
    n += rowCount || 0;
  }
  return n;
}

/** Order two label rows: higher grade, then more trusted source, then newer. */
export function compareLabels(a, b) {
  return (GRADE_RANK[b.grade] - GRADE_RANK[a.grade])
    || ((SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0))
    || (new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

/**
 * For each target, the best label row that says something about `field` (label[field] defined).
 * Rows are { target_id, label, grade, source, created_at, evidence }.
 * @returns {Map<string, { value, grade, source, row, conflict: boolean }>}
 */
export function resolveTargetLabels(rows, field) {
  const byTarget = new Map();
  for (const r of rows) {
    const label = typeof r.label === 'string' ? JSON.parse(r.label) : r.label;
    if (!label || label[field] === undefined || label[field] === null) continue;
    if (!byTarget.has(r.target_id)) byTarget.set(r.target_id, []);
    byTarget.get(r.target_id).push({ ...r, label });
  }
  const out = new Map();
  for (const [target, list] of byTarget) {
    list.sort(compareLabels);
    const best = list[0];
    // A conflict is a disagreement among rows of the best row's grade.
    const conflict = list.some((r) => r.grade === best.grade && JSON.stringify(r.label[field]) !== JSON.stringify(best.label[field]));
    out.set(target, { value: best.label[field], grade: best.grade, source: best.source, row: best, conflict });
  }
  return out;
}

/** Label rows for a user (or everyone) and suite(s). */
export async function loadLabels({ userId = null, suites, minGrade = 'weak' } = {}) {
  const grades = GRADES.slice(GRADES.indexOf(minGrade));
  const { rows } = await query(
    `SELECT id, user_id, suite, target_id, label, grade, source, evidence, created_at FROM hedwig_labels
      WHERE ($1::uuid IS NULL OR user_id = $1) AND suite = ANY($2::text[]) AND grade = ANY($3::text[])
      ORDER BY created_at DESC`,
    [userId, suites, grades],
  );
  return rows;
}

/** Counts for the admin page. */
export async function labelStats() {
  const [{ rows: labels }, { rows: questions }, { rows: runs }] = await Promise.all([
    query(`SELECT suite, grade, source, COUNT(*)::int AS n, MAX(created_at) AS latest FROM hedwig_labels GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`),
    query(`SELECT COUNT(*) FILTER (WHERE answered_at IS NULL AND dropped_at IS NULL)::int AS open,
                  COUNT(*) FILTER (WHERE answered_at IS NULL AND dropped_at IS NULL AND asked_at IS NOT NULL)::int AS asked,
                  COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered,
                  COUNT(*) FILTER (WHERE drop_reason = 'skipped')::int AS skipped,
                  COUNT(*) FILTER (WHERE dropped_at IS NOT NULL AND COALESCE(drop_reason, '') <> 'skipped')::int AS dropped
             FROM hedwig_questions`),
    query(`SELECT DISTINCT ON (suite) suite, id, accepted, started_at, finished_at FROM hedwig_eval_runs ORDER BY suite, started_at DESC`),
  ]);
  const bySuite = {};
  for (const r of labels) {
    const s = (bySuite[r.suite] ||= { total: 0, weak: 0, silver: 0, gold: 0, sources: {} });
    s.total += r.n;
    s[r.grade] += r.n;
    s.sources[r.source] = (s.sources[r.source] || 0) + r.n;
  }
  return { suites: bySuite, questions: questions[0] || {}, lastRuns: runs };
}
