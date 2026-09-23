// Ask on the v2 backend (POST /context/ask, stream G): the answer state and how its events fold
// into it, and saved answers from GET /context/ask/history and /context/ask/:id read into the same
// state, so a past answer shows with its citations instead of being asked again. Pure.
//
// Events: { type: 'sources', sources: [{ n, message }], askLogId }, { type: 'delta', text }…,
// { type: 'done', answer, citations, unsupported, notFound, invalidCitations, askLogId },
// { type: 'error', error }.
import { citedNumbers } from '../views/helpers.js';

export const ASK2_INITIAL = Object.freeze({
  status: 'idle', id: null, question: '', sources: [], answer: '', citations: [], unsupported: false, notFound: false,
  invalidCitations: [], error: null, followUpOf: null, feedback: null, saved: false, createdAt: null,
});

/** A new question being asked (a follow-up names the answer it follows). */
export function askStarted(question, { followUpOf = null } = {}) {
  return { ...ASK2_INITIAL, status: 'streaming', question, followUpOf };
}

export function reduceAsk2(state, event) {
  if (!event || typeof event !== 'object') return state;
  switch (event.type) {
    case 'sources':
      return { ...state, status: 'streaming', id: event.askLogId || state.id, sources: Array.isArray(event.sources) ? event.sources : [] };
    case 'delta':
      return { ...state, status: 'streaming', answer: state.answer + (event.text || '') };
    case 'done':
      return {
        ...state,
        status: 'done',
        id: event.askLogId || state.id,
        answer: typeof event.answer === 'string' && event.answer ? event.answer : state.answer,
        citations: Array.isArray(event.citations) ? event.citations : citedNumbers(state.answer),
        unsupported: event.unsupported === true,
        notFound: event.notFound === true,
        invalidCitations: Array.isArray(event.invalidCitations) ? event.invalidCitations : [],
      };
    case 'error':
      return { ...state, status: 'error', error: event.error || 'The answer failed' };
    default:
      return state;
  }
}

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
    saved: true,
    createdAt: entry.created_at || entry.createdAt || null,
    unfinished: !done,
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
