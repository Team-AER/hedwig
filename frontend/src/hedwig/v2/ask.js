// Ask on the v2 backend (POST /context/ask, stream G): the answer state and how its events fold
// into it, and saved answers from GET /context/ask/history and /context/ask/:id read into the same
// state, so a past answer shows with its citations instead of being asked again. Pure.
//
// Events: { type: 'sources', sources: [{ n, message }], web: [{ n, url, title, host, … }], askLogId,
// coverage }, { type: 'delta', text }…, { type: 'done', answer, citations, unsupported, notFound,
// invalidCitations, askLogId, coverage, model, lighterModel }, { type: 'error', error }; and the
// steps: plan, search, review, thread (the open thread read), web (a web search), read (web pages
// read), links (links in the mail opened or skipped), dig (Dig deeper deciding what else to read).
import { citedNumbers } from '../views/helpers.js';

export const ASK2_INITIAL = Object.freeze({
  status: 'idle', id: null, question: '', sources: [], web: [], webInfo: null, answer: '', citations: [], unsupported: false, notFound: false,
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

/**
 * Web sources as the server numbers them (after the mail): only http(s) pages with a number, so a
 * citation can never open anything else. Pure.
 */
export function webSources(list) {
  return (Array.isArray(list) ? list : []).filter((w) => w && Number.isInteger(w.n) && /^https?:\/\//i.test(String(w.url || ''))).map((w) => ({
    n: w.n, url: String(w.url), title: String(w.title || w.host || w.url), host: String(w.host || ''), published: w.published || null,
    via: w.via || 'search', snippetOnly: w.snippetOnly === true, excerpt: typeof w.excerpt === 'string' ? w.excerpt : '',
  }));
}

/** A new question being asked (a follow-up names the answer it follows). */
export function askStarted(question, { followUpOf = null, now = Date.now() } = {}) {
  return { ...ASK2_INITIAL, status: 'streaming', question, followUpOf, startedAt: now };
}

// ── Progress ─────────────────────────────────────────────────────────────────
// Ask's work as steps for the pane (AskProgress.jsx), in the order they happen:
//   { id, kind: 'thread'|'plan'|'search'|'review'|'web'|'webread'|'links'|'dig'|'read'|'write',
//     status: 'running'|'done'|'stopped', text?, round?, found?, enough?, searches?, count?, pages?,
//     opened?, skipped? }
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
      return {
        ...state,
        status: 'streaming',
        webInfo: event.web && typeof event.web === 'object' ? event.web : state.webInfo,
        steps: upsertStep(state.steps, { id: 'plan', kind: 'plan', status: stepStatus(event.status), ...(event.text ? { text: event.text } : {}) }),
      };
    case 'thread':
      return {
        ...state,
        status: 'streaming',
        steps: upsertStep(state.steps, { id: 'thread', kind: 'thread', status: stepStatus(event.status), ...(event.status === 'done' ? { count: Number(event.messages) || 0, text: event.subject || '' } : {}) }),
      };
    case 'web': {
      // A web search: { query, round, status, found }.
      if (typeof event.query !== 'string' || !event.query) return state;
      const round = Number(event.round) || 0;
      const status = stepStatus(event.status);
      return { ...state, status: 'streaming', steps: upsertStep(state.steps, { id: `web:${round}:${event.query}`, kind: 'web', status, text: event.query, round, ...(status === 'done' ? { found: Number(event.found) || 0 } : {}) }) };
    }
    case 'read': {
      // Web pages being read: { round, status, count } then { round, status: 'done', pages: [{ host, title, ok, via }] }.
      const round = Number(event.round) || 0;
      const status = stepStatus(event.status);
      const pages = Array.isArray(event.pages) ? event.pages : null;
      const step = { id: `webread:${round}`, kind: 'webread', status, round, ...(Number.isFinite(event.count) ? { count: event.count } : {}) };
      if (pages) Object.assign(step, { pages, count: pages.filter((x) => x && x.ok).length });
      return { ...state, status: 'streaming', steps: upsertStep(state.steps, step) };
    }
    case 'links':
      return {
        ...state,
        status: 'streaming',
        steps: upsertStep(state.steps, { id: 'links', kind: 'links', status: 'done', opened: Number(event.opened) || 0, skipped: Array.isArray(event.skipped) ? event.skipped : [] }),
      };
    case 'dig': {
      const round = Number(event.round) || 0;
      const step = { id: `dig:${round}`, kind: 'dig', status: stepStatus(event.status), round };
      if (event.status === 'done') step.enough = event.enough !== false;
      return { ...state, status: 'streaming', steps: upsertStep(state.steps, step) };
    }
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
      const web = webSources(event.web);
      return {
        ...state, status: 'streaming', id: event.askLogId || state.id, sources, web, coverage: coverageOf(event) || state.coverage,
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
  const research = entry.plan?.research;
  const webSearches = Array.isArray(research?.searches) ? research.searches.filter((x) => x && typeof x.text === 'string' && x.text) : [];
  if (!searches.length && !webSearches.length && !entry.plan?.thread) return [];
  const steps = [];
  if (entry.plan?.thread) steps.push({ id: 'thread', kind: 'thread', status: 'done', count: Number(entry.plan.thread.messages) || 0 });
  if (entry.plan?.text) steps.push({ id: 'plan', kind: 'plan', status: 'done', text: entry.plan.text });
  searches.forEach((x, i) => {
    if (i === 1) steps.push({ id: 'review:1', kind: 'review', status: 'done', round: 1, enough: false, searches: searches.slice(1).map((y) => y.text) });
    steps.push({ id: `search:${x.round}:${x.text}`, kind: 'search', status: 'done', text: x.text, round: x.round, found: x.found });
  });
  webSearches.forEach((x) => steps.push({ id: `web:0:${x.text}`, kind: 'web', status: 'done', text: x.text, round: 0, found: Number(x.found) || 0 }));
  if (Number(research?.read) > 0) steps.push({ id: 'webread:0', kind: 'webread', status: 'done', round: 0, count: Number(research.read) });
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
    web: webSources(entry.web),
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
