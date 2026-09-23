// Index (v2 stream A): coverage ledger, body and attachment acquisition, parser, chunks with
// weighted full-text vectors, chunk embeddings, and hybrid retrieval. See docs/hedwig/V2-BUILD.md.
import { defineStep } from '../pipeline.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { getConfig } from '../config.js';
import { ATTACHMENT_JOB, makeAttachmentHandler } from './acquire.js';
import { indexStep, sweeps } from './service.js';
import { indexRoutes, indexAdminRoutes } from './routes.js';

export default {
  name: 'indexer',

  routes(router) {
    indexRoutes(router);
  },

  adminRoutes(router) {
    indexAdminRoutes(router);
  },

  // Attachment bytes come over IMAP, so extraction runs where the mail engine lives.
  api({ imapManager }) {
    defineJob(ATTACHMENT_JOB, makeAttachmentHandler(imapManager), { timeoutMs: 5 * 60_000 });
  },

  async worker() {
    // Last, so chunking never delays triage; runs on history and on the spam folder too.
    defineStep({ name: 'index', order: 60, backfill: true, spam: true, run: indexStep });
    const cfg = await getConfig();
    defineSchedule({ name: 'index.coverage', everySec: cfg['index.coverageEverySec'], run: sweeps.coverage });
    defineSchedule({ name: 'index.acquire', everySec: 10, run: sweeps.acquire });
    defineSchedule({ name: 'index.chunk', everySec: 10, run: sweeps.chunk });
    defineSchedule({ name: 'index.embed', everySec: 5, run: sweeps.embed });
  },
};
