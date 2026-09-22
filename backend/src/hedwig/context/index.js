// Context engine: people and organisations, embeddings, topics, commitments and facts, cards,
// hybrid search and ask. See docs/hedwig/ARCHITECTURE.md and docs/hedwig/API.md ("Context").
import { defineStep } from '../pipeline.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { embeddingProfile } from '../embeddings.js';
import { runEntitiesStep } from './entities.js';
import { embedCatchUp, ensureVectorIndex, runEmbedStep } from './embed.js';
import { labelTopic, runTopicsStep } from './topics.js';
import { runExtractStep, runExtraction } from './extract.js';
import { refreshStaleSummaries, summarizeEntity, summarizeTopic } from './summaries.js';
import { sweepOverdue } from './commitments.js';
import { contextRoutes } from './routes.js';
import { registerContextTools } from './tools.js';

export default {
  name: 'context',

  tools() {
    registerContextTools();
  },

  routes(router) {
    contextRoutes(router);
  },

  async worker() {
    defineStep({ name: 'entities', order: 10, backfill: true, run: runEntitiesStep });
    defineStep({ name: 'embed', order: 20, run: runEmbedStep });
    defineStep({ name: 'topics', order: 40, run: runTopicsStep });
    defineStep({ name: 'extract', order: 50, run: runExtractStep });

    defineJob('context.extract', runExtraction, { timeoutMs: 3 * 60_000 });
    defineJob('context.labelTopic', labelTopic, { timeoutMs: 3 * 60_000 });
    defineJob('context.summarizeEntity', ({ entityId }) => summarizeEntity(entityId), { timeoutMs: 3 * 60_000 });
    defineJob('context.summarizeTopic', ({ topicId }) => summarizeTopic(topicId), { timeoutMs: 3 * 60_000 });

    defineSchedule({ name: 'context.embedCatchUp', everySec: 120, run: () => embedCatchUp() });
    defineSchedule({ name: 'context.refreshSummaries', everySec: 1800, run: () => refreshStaleSummaries() });
    defineSchedule({ name: 'context.overdueSweep', everySec: 900, run: () => sweepOverdue() });

    // The index must exist before the first vector query; a failure here only slows search.
    try {
      const profile = await embeddingProfile();
      if (profile) await ensureVectorIndex(profile.dims);
    } catch (err) {
      console.warn('[hedwig] context: could not ensure the vector index:', err.message);
    }
  },
};
