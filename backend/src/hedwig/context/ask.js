// Ask: answer a question from the user's mail with numbered citations, streamed.
// Since v2 wave 2 this delegates to ask2/ (query plan, chunk-index retrieval, relevance floor,
// thread-grouped evidence, citation check, follow-ups, saved answers). The exports and the event
// shapes are unchanged; `followUpOf` and the extra event fields are additions.
import { answerQuestion as answerV2, NOTHING_RELEVANT } from '../ask2/answer.js';
import { askHistory as historyV2 } from '../ask2/history.js';

export const NO_SOURCES_ANSWER = NOTHING_RELEVANT;

/**
 * Retrieve, then stream an answer. Emits { type: 'sources' }, { type: 'delta' }…, { type: 'done' }
 * through onEvent and resolves with { answer, citations, sources, unsupported, notFound, askLogId }.
 * Throws on model failure; the caller turns that into an error event.
 */
export function answerQuestion(userId, question, opts = {}) {
  return answerV2(userId, question, opts);
}

/** Saved answers, newest first, each with its answer and numbered sources. */
export function askHistory(userId, opts = {}) {
  return historyV2(userId, opts);
}
