// work module — "Working the inbox" and "Writing" from the v2 PRD: Reply Later / Set Aside / Pinned /
// reminders / Done (with sweep and snooze), the thread story with quick replies, drafts in the
// owner's voice, Waiting On with nudges, and the send guard. Routes under /api/hedwig/work/….
import { defineStep } from '../pipeline.js';
import { mountWorkRoutes } from './routes.js';
import { applyMail } from './lists.js';

export { peopleFilterSql, withWorkRows, syntheticRows } from './lists.js';

export default {
  name: 'work',

  routes(router) {
    mountWorkRoutes(router);
  },

  worker() {
    // Right after sort (32): new mail re-opens done threads, the owner's reply closes Reply Later,
    // anyone else writing resolves a "remind me if no reply" watch.
    defineStep({ name: 'work', order: 34, backfill: false, run: (rows) => applyMail(rows) });
  },
};
