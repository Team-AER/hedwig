// Sorting's prompt definitions (the files live in prompts/ per the v2 contract; B's registry
// registers them, and sort/deps.js registers them itself if the registry has not).
import reflex from '../prompts/sort.reflex.js';
import screener from '../prompts/sort.screener.js';
import spamReflex from '../prompts/spam.reflex.js';
import bundleDescribe from '../prompts/sort.bundleDescribe.js';

export const SORT_PROMPTS = Object.freeze({
  [reflex.id]: reflex,
  [screener.id]: screener,
  [spamReflex.id]: spamReflex,
  [bundleDescribe.id]: bundleDescribe,
});
