// The sorting engine's version. Bump SORT_ENGINE_VERSION when a change to the layers (headers,
// sender decisions, classifier training, merge rules) should re-sort stored decisions: on worker
// start ensureSortEngineCurrent() enqueues one sort.resort per user, and classifier heads trained
// under another engine version are ignored until they retrain. The stamp also carries the
// sort.reflex prompt version, so a prompt change re-sorts recent mail with Reflex too.
import reflexPrompt from '../prompts/sort.reflex.js';

export const SORT_ENGINE_VERSION = '2026-09-24.1';

/** Stored on every hedwig_sort row the engine writes (engine_version) and in hedwig_state. */
export function engineStamp() {
  return `${SORT_ENGINE_VERSION}+sort.reflex@${reflexPrompt.version}`;
}
