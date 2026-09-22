// Insights service: the functions other modules (and the agent's tools) import.
export { overview } from './overview.js';
export { listCards, generateCards } from './cards.js';
export { latestBriefing, listBriefings } from './briefing.js';
export { dismissInsight as dismissCard } from './store.js';

import { generateBriefing as generate } from './briefing.js';
import { generateCards } from './cards.js';

/** Generate and store a fresh daily briefing now (cards are refreshed first so it can cite them). */
export async function generateBriefing(userId, opts = {}) {
  await generateCards(userId).catch((err) => console.warn(`[hedwig] cards before briefing failed for ${userId}:`, err.message));
  return generate(userId, { period: 'day', ...opts });
}
