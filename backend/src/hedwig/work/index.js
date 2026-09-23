// work module — "Working the inbox" and "Writing" from the v2 PRD: Reply Later / Set Aside / Pinned /
// reminders / Done (with sweep and snooze), the thread story with quick replies, drafts in the
// owner's voice, Waiting On with nudges, and the send guard. Routes under /api/hedwig/work/….
// Summaries (thread stories and message TL;DRs) are written eagerly by the work.summarise job; work's
// own Needs You reasons (a reply overdue, a deadline near) are derived by the same sweep.
import { defineStep } from '../pipeline.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { getConfig } from '../config.js';
import { mountWorkRoutes } from './routes.js';
import { applyMail } from './lists.js';
import { SUMMARISE_JOB, runSummariseJob, sweepSummaries } from './summaries.js';
import { deriveAllNeeds } from './needs.js';

export { peopleFilterSql, withWorkRows, decorateRows, syntheticRows } from './lists.js';
export { workNeedsYouSql } from './needs.js';
export { tldrFor } from './summaries.js';

let lastSweep = 0;

export default {
  name: 'work',

  routes(router) {
    mountWorkRoutes(router);
  },

  worker() {
    // Right after sort (32): new mail re-opens done threads, the owner's reply closes Reply Later
    // and "waiting for your reply", anyone else writing resolves a "remind me if no reply" watch,
    // and mail from a person queues the eager summaries.
    defineStep({ name: 'work', order: 34, backfill: false, run: (rows) => applyMail(rows) });
    // --- v2 work audit ---
    defineJob(SUMMARISE_JOB, (payload, job) => runSummariseJob(payload, job), { timeoutMs: 15 * 60_000, needsGateway: true });
    defineSchedule({
      name: 'work.summaries',
      everySec: 60,
      runOnStart: true,
      run: async () => {
        const cfg = await getConfig();
        if (Date.now() - lastSweep < (cfg['work.summariesEverySec'] ?? 1800) * 1000) return;
        lastSweep = Date.now();
        await deriveAllNeeds();
        await sweepSummaries();
      },
    });
    // --- end v2 work audit ---
  },
};
