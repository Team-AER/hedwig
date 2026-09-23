// One citation convention for everything that answers from mail: `[n]` refers to source n of the
// answer's numbered sources (Ask answers, the agent, briefings and insights). Checks the model's
// citations against what it was shown, and numbers the agent's search results per run.
import { query } from '../../services/db.js';

const CITE_RE = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;
export const NOT_FOUND_RE = /couldn'?t find|could not find|can'?t find|cannot find|no (emails?|messages?|mail) (about|mention|that)|not (mentioned|in your (mail|email))|don'?t see|nothing (relevant )?in your (mail|email)|no information/i;

/** Every number cited in the text, in order of first appearance. Pure. */
export function citedNumbers(text) {
  const out = [];
  for (const m of String(text || '').matchAll(CITE_RE)) {
    for (const s of m[1].split(',')) {
      const n = Number.parseInt(s.trim(), 10);
      if (Number.isFinite(n) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/**
 * Check an answer's citations against its sources. Citations that point at no source are removed
 * from the returned text. An answer that states something without one valid citation is
 * `unsupported`; a plain "I couldn't find it" is `notFound` instead.
 * @param {string} answer
 * @param {number} count number of sources shown to the model ([1]..[count] are valid)
 * @returns {{ answer: string, citations: number[], invalid: number[], unsupported: boolean, notFound: boolean }}
 */
export function checkCitations(answer, count) {
  const text = String(answer || '');
  const cited = citedNumbers(text);
  const valid = cited.filter((n) => n >= 1 && n <= count);
  const invalid = cited.filter((n) => !(n >= 1 && n <= count));
  let cleaned = text;
  if (invalid.length) {
    cleaned = text.replace(CITE_RE, (whole, list) => {
      const keep = list.split(',').map((s) => s.trim()).filter((s) => { const n = Number(s); return n >= 1 && n <= count; });
      return keep.length ? `[${keep.join(', ')}]` : '';
    }).replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }
  const notFound = !valid.length && NOT_FOUND_RE.test(cleaned);
  return {
    answer: cleaned.trim(),
    citations: [...valid].sort((a, b) => a - b),
    invalid: [...invalid].sort((a, b) => a - b),
    unsupported: !valid.length && !notFound && cleaned.trim().length > 0,
    notFound,
  };
}

// ── Agent runs: stable [n] numbers for the messages its search_mail calls return ──────────────
const runs = new Map(); // runId -> { ids: string[], at }
const MAX_RUNS = 500;

/** The numbered messages a run's search_mail results carried, rebuilt from its stored tool messages. Pure. */
export function sourcesFromMessages(messages) {
  const ids = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'tool' || m.name !== 'search_mail' || typeof m.content !== 'string') continue;
    let parsed;
    try { parsed = JSON.parse(m.content); } catch { continue; }
    for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
      if (!r?.id || !Number.isInteger(r.n) || r.n < 1) continue;
      ids[r.n - 1] = r.id;
    }
  }
  return ids;
}

async function registryFor(userId, runId) {
  let reg = runs.get(runId);
  if (!reg) {
    let ids = [];
    try {
      const { rows } = await query('SELECT messages FROM hedwig_agent_runs WHERE id = $1 AND user_id = $2', [runId, userId]);
      ids = sourcesFromMessages(rows[0]?.messages);
    } catch { /* a missing run table only means numbering starts at 1 */ }
    reg = { ids, at: Date.now() };
    runs.set(runId, reg);
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
  }
  reg.at = Date.now();
  return reg;
}

/**
 * Give each result a citation number `n`, stable for the whole run: a message found twice keeps its
 * first number. Without a run (a direct tool call) results are numbered 1..k.
 */
export async function numberResults(userId, runId, results) {
  if (!runId) return results.map((r, i) => ({ n: i + 1, ...r }));
  const reg = await registryFor(userId, runId);
  return results.map((r) => {
    let i = reg.ids.indexOf(r.id);
    if (i < 0) { reg.ids.push(r.id); i = reg.ids.length - 1; }
    return { n: i + 1, ...r };
  });
}

/** The run's numbered sources, `[{ n, id }]`, for resolving its `[n]` citations. */
export async function runSources(userId, runId) {
  if (!runId) return [];
  const reg = await registryFor(userId, runId);
  return reg.ids.map((id, i) => (id ? { n: i + 1, id } : null)).filter(Boolean);
}

export function _resetCitations() { runs.clear(); }
