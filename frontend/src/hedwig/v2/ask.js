// Ask on the v2 backend (POST /context/ask, stream G): the answer state and how its events fold
// into it, and saved answers from GET /context/ask/history and /context/ask/:id read into the same
// state, so a past answer shows with its citations instead of being asked again. Pure.
//
// Events: { type: 'sources', sources: [{ n, message }], askLogId, coverage }, { type: 'delta', text }…,
// { type: 'done', answer, citations, unsupported, notFound, invalidCitations, askLogId, coverage,
// model, lighterModel }, { type: 'error', error }.
import { citedNumbers } from '../views/helpers.js';

export const ASK2_INITIAL = Object.freeze({
  status: 'idle', id: null, question: '', sources: [], answer: '', citations: [], unsupported: false, notFound: false,
  invalidCitations: [], error: null, followUpOf: null, feedback: null, saved: false, createdAt: null, provenance: null, coverage: null,
  searches: [], steps: [], startedAt: null, finishedAt: null,
});

/**
 * Which model wrote an answer: { model, lighter, tier } from the done event or a saved answer.
 * ask2 sends `model` and `lighterModel` (true when the Tier 2 fallback answered); `fellBack` and a
 * nested `provenance` are read too. null when none of them is there.
 */
export function answerProvenance(src) {
  if (!src || typeof src !== 'object') return null;
  const p = src.provenance && typeof src.provenance === 'object' ? src.provenance : {};
  const model = src.model ?? p.model ?? null;
  const flag = [src.lighterModel, p.lighterModel, src.fellBack, p.fellBack].find((v) => typeof v === 'boolean');
  const lighter = typeof flag === 'boolean' ? flag : null;
  const tier = src.tier ?? p.tier ?? null;
  if (model == null && lighter == null && tier == null) return null;
  return { model, lighter, tier };
}

/** The index coverage an answer could see ({ share, indexed, total, complete }), or null. */
export function coverageOf(src) {
  const c = src?.coverage;
  if (!c || typeof c !== 'object' || typeof c.share !== 'number' || !Number.isFinite(c.share)) return null;
  return { share: Math.max(0, Math.min(1, c.share)), indexed: c.indexed ?? null, total: c.total ?? null, complete: c.complete === true };
}

/** "62%" while the index is still filling; null when it is complete or unknown. */
export function coverageGap(coverage) {
  if (!coverage || coverage.complete || !(coverage.share < 1)) return null;
  return `${Math.floor(coverage.share * 100)}%`;
}

/** A new question being asked (a follow-up names the answer it follows). */
export function askStarted(question, { followUpOf = null, now = Date.now() } = {}) {
  return { ...ASK2_INITIAL, status: 'streaming', question, followUpOf, startedAt: now };
}

// ── Progress ─────────────────────────────────────────────────────────────────
// Ask's work as steps for the pane (AskProgress.jsx), in the order they happen:
//   { id, kind: 'plan'|'search'|'review'|'read'|'write', status: 'running'|'done'|'stopped',
//     text?, round?, found?, enough?, searches?, count? }
function upsertStep(steps, step) {
  const list = steps || [];
  const i = list.findIndex((x) => x.id === step.id);
  if (i < 0) return [...list, step];
  const next = list.slice();
  next[i] = { ...list[i], ...step };
  return next;
}

function settleSteps(steps, status = 'done') {
  return (steps || []).map((x) => (x.status === 'running' ? { ...x, status } : x));
}

const stepStatus = (s) => (s === 'running' ? 'running' : 'done');

export function reduceAsk2(state, event) {
  if (!event || typeof event !== 'object') return state;
  switch (event.type) {
    case 'plan':
      return { ...state, status: 'streaming', steps: upsertStep(state.steps, { id: 'plan', kind: 'plan', status: stepStatus(event.status), ...(event.text ? { text: event.text } : {}) }) };
    case 'search': {
      // Ask searching, and searching again with its own words: { text, round, status, found }.
      if (typeof event.text !== 'string' || !event.text) return state;
      const round = Number(event.round) || 0;
      const status = stepStatus(event.status);
      const step = { id: `search:${round}:${event.text}`, kind: 'search', status, text: event.text, round, ...(status === 'done' ? { found: Number(event.found) || 0 } : {}) };
      return {
        ...state,
        status: 'streaming',
        steps: upsertStep(state.steps, step),
        searches: status === 'done' ? [...(state.searches || []), { text: event.text, found: Number(event.found) || 0, round }] : (state.searches || []),
      };
    }
    case 'review': {
      const round = Number(event.round) || 0;
      const step = { id: `review:${round}`, kind: 'review', status: stepStatus(event.status), round };
      if (event.status === 'done') Object.assign(step, { enough: event.enough !== false, searches: Array.isArray(event.searches) ? event.searches : [] });
      return { ...state, status: 'streaming', steps: upsertStep(state.steps, step) };
    }
    case 'sources': {
      const sources = Array.isArray(event.sources) ? event.sources : [];
      return {
        ...state, status: 'streaming', id: event.askLogId || state.id, sources, coverage: coverageOf(event) || state.coverage,
        steps: sources.length ? upsertStep(settleSteps(state.steps), { id: 'read', kind: 'read', status: 'running', count: sources.length }) : settleSteps(state.steps),
      };
    }
    case 'delta': {
      const steps = (state.steps || []).some((x) => x.id === 'write')
        ? state.steps
        : upsertStep(settleSteps(state.steps), { id: 'write', kind: 'write', status: 'running' });
      return { ...state, status: 'streaming', answer: state.answer + (event.text || ''), steps };
    }
    case 'done':
      return {
        ...state,
        status: 'done',
        steps: settleSteps(state.steps),
        finishedAt: Number.isFinite(event.at) ? event.at : Date.now(),
        id: event.askLogId || state.id,
        answer: typeof event.answer === 'string' && event.answer ? event.answer : state.answer,
        citations: Array.isArray(event.citations) ? event.citations : citedNumbers(state.answer),
        unsupported: event.unsupported === true,
        notFound: event.notFound === true,
        invalidCitations: Array.isArray(event.invalidCitations) ? event.invalidCitations : [],
        provenance: answerProvenance(event) || state.provenance,
        coverage: coverageOf(event) || state.coverage,
      };
    case 'error':
      return { ...state, status: 'error', error: event.error || 'The answer failed', steps: settleSteps(state.steps, 'stopped'), finishedAt: Date.now() };
    default:
      return state;
  }
}

/** The searches a saved answer ran (plan.searches: [{ text, found }]), first one round 0. */
function savedSearches(plan) {
  const list = Array.isArray(plan?.searches) ? plan.searches : [];
  return list.filter((x) => x && typeof x.text === 'string' && x.text).map((x, i) => ({ text: x.text, found: Number(x.found) || 0, round: i ? 1 : 0 }));
}

/** A saved answer's steps, from what was kept: the plan's words, its searches, the messages read. */
function savedSteps(entry, searches, sourceCount) {
  if (!searches.length) return [];
  const steps = [];
  if (entry.plan?.text) steps.push({ id: 'plan', kind: 'plan', status: 'done', text: entry.plan.text });
  searches.forEach((x, i) => {
    if (i === 1) steps.push({ id: 'review:1', kind: 'review', status: 'done', round: 1, enough: false, searches: searches.slice(1).map((y) => y.text) });
    steps.push({ id: `search:${x.round}:${x.text}`, kind: 'search', status: 'done', text: x.text, round: x.round, found: x.found });
  });
  if (sourceCount) steps.push({ id: 'read', kind: 'read', status: 'done', count: sourceCount });
  if (entry.answer) steps.push({ id: 'write', kind: 'write', status: 'done' });
  return steps;
}

const timeOf = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };

/** A saved answer (a history entry or GET /context/ask/:id) as answer state. */
export function fromSaved(entry) {
  if (!entry || typeof entry !== 'object') return ASK2_INITIAL;
  const done = entry.status === 'done' || (entry.status == null && entry.answer);
  return {
    ...ASK2_INITIAL,
    status: 'done',
    id: entry.id || null,
    question: entry.question || '',
    sources: Array.isArray(entry.sources) ? entry.sources.filter((s) => s && s.message) : [],
    answer: typeof entry.answer === 'string' ? entry.answer : '',
    citations: Array.isArray(entry.citations) ? entry.citations : citedNumbers(entry.answer || ''),
    unsupported: entry.unsupported === true,
    notFound: entry.notFound === true,
    error: entry.status === 'error' || entry.status === 'aborted' ? (entry.error || null) : null,
    followUpOf: entry.followUpOf || null,
    feedback: entry.feedback || null,
    searches: savedSearches(entry.plan),
    steps: savedSteps(entry, savedSearches(entry.plan), Array.isArray(entry.sources) ? entry.sources.length : 0),
    startedAt: timeOf(entry.created_at || entry.createdAt),
    finishedAt: timeOf(entry.completed_at || entry.completedAt),
    saved: true,
    createdAt: entry.created_at || entry.createdAt || null,
    unfinished: !done,
    provenance: answerProvenance(entry),
  };
}

/** A history entry's one-word state for the list: 'wrong' | 'notFound' | 'unsupported' | 'unfinished' | null. */
export function historyMark(entry) {
  if (entry?.feedback?.wrong) return 'wrong';
  if (entry?.status && entry.status !== 'done') return 'unfinished';
  if (entry?.notFound) return 'notFound';
  if (entry?.unsupported) return 'unsupported';
  return null;
}

const CITE_RUN = /\[\d{1,3}(?:\s*,\s*\d{1,3})*\](?:\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\])*/g;

/**
 * Citations in reading order. The server numbers every message it read, often 40 or more, so an
 * answer citing 44 and then 4 showed "⁴⁴ … ⁴". The cited sources become 1, 2, 3… in the order the
 * answer first cites them, the ones it read but did not cite follow, and a run of markers such as
 * "[4][44]" becomes one "[1, 2]". Numbers that name no source are left as they are.
 * @param {string} answer
 * @param {{ n: number, message?: object }[]} sources
 * @returns {{ text: string, sources: { n: number, source: number, message?: object, cited: boolean }[], toSource: (d: number) => number }}
 */
export function readingOrder(answer, sources = []) {
  const text = String(answer || '');
  const list = Array.isArray(sources) ? sources.filter((s) => s && Number.isInteger(s.n)) : [];
  const known = new Set(list.map((s) => s.n));
  const cited = citedNumbers(text).filter((n) => known.has(n));
  const order = [...cited, ...list.map((s) => s.n).filter((n) => !cited.includes(n))];
  const toDisplay = new Map(order.map((n, i) => [n, i + 1]));
  const out = text.replace(CITE_RUN, (run) => {
    const nums = [...new Set((run.match(/\d{1,3}/g) || []).map((x) => toDisplay.get(Number(x)) ?? Number(x)))];
    return `[${nums.join(', ')}]`;
  });
  const bySource = new Map(list.map((s) => [s.n, s]));
  const citedSet = new Set(cited);
  return {
    text: out,
    sources: order.map((n, i) => ({ ...bySource.get(n), n: i + 1, source: n, cited: citedSet.has(n) })),
    toSource: (d) => order[Number(d) - 1] ?? Number(d),
  };
}

/**
 * Earlier questions, one row per question: the same words asked again show once, as the newest
 * (history is newest first), or as the one on screen when that is an older copy.
 */
export function distinctQuestions(entries = [], currentId = null) {
  const list = Array.isArray(entries) ? entries : [];
  const groups = new Map();
  for (const e of list) {
    if (!e || !e.id) continue;
    const key = String(e.question || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const at = groups.get(key);
    if (!at) groups.set(key, e);
    else if (e.id === currentId) groups.set(key, e);
  }
  const keep = new Set([...groups.values()].map((e) => e.id));
  return list.filter((e) => e && keep.has(e.id));
}
