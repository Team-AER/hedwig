// sort module — People / Reading / Records streams, the Screener, bundles, rules and spam rescue.
// See docs/hedwig/V2-BUILD.md "Sorting decision (C)".
import { defineStep, userAddresses } from '../pipeline.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { getConfig } from '../config.js';
import {
  runSortStep, runReflexJob, runResortJob, pendingSweep, backfillSweep, rescueSweep, sortUsers, runRescueJob, runReevaluateSpamJob,
  ensureSpamSignalsCurrent, ensureSortEngineCurrent, reflexSweep, reflexPayloads,
} from './engine.js';
import { releaseDueBundles } from './bundles.js';
import { refreshProposals } from './senders.js';
import { retrainSortDue } from './learning.js';
import { mountSortRoutes, mountSortAdminRoutes } from './routes.js';
import { makeSpamMoveHandler } from './spamMove.js';
import { correct } from './service.js';
import { query } from '../../services/db.js';

/**
 * Payloads sort.reflex should have for a user right now (for the job ledger's reconcile/retry):
 * the same rows and batches the Reflex sweep would enqueue (engine.js reflexPayloads).
 */
async function reflexRebuild(userId) {
  if (!userId) return [];
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['sort.enabled']) return [];
  return reflexPayloads(userId, cfg);
}

async function screenerTick() {
  const { rows } = await query(`SELECT DISTINCT user_id FROM hedwig_sort WHERE stream = 'screener'`);
  for (const { user_id: userId } of rows) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled || !cfg['sort.enabled']) continue;
      const { rows: u } = await query('SELECT display_name, username FROM users WHERE id = $1', [userId]);
      const addresses = (await userAddresses([userId])).get(userId) || new Set();
      await refreshProposals(userId, { useModel: Boolean(cfg['llm.baseUrl']), user: { name: u[0]?.display_name || u[0]?.username || null, addresses: [...addresses] } });
    } catch (err) {
      console.warn(`[hedwig] sort: screener proposals failed for ${userId}:`, err.message);
    }
  }
}

export { sortUsers };

export default {
  name: 'sort',

  routes(router) {
    mountSortRoutes(router);
  },

  adminRoutes(router) {
    mountSortAdminRoutes(router);
  },

  api({ imapManager }) {
    defineJob('sort.spamMove', makeSpamMoveHandler(imapManager), { timeoutMs: 90_000 });
  },

  worker() {
    // After triage (30) so its needs-you decision and sender stats (15) are in place.
    defineStep({ name: 'sort', order: 32, backfill: true, run: (rows, ctx) => runSortStep(rows, ctx) });
    defineJob('sort.reflex', (payload, job) => runReflexJob(payload, job), { timeoutMs: 5 * 60_000, needsGateway: true, rebuild: reflexRebuild });
    // Corrections D queued before this module existed (labels/runtime.js applySortCorrection).
    defineJob('sort.applyCorrection', (payload, job) => {
      const body = { ...payload };
      delete body.userId; // the job's owner is authoritative, never the payload
      return correct(job.user_id, body);
    }, { timeoutMs: 60_000 });
    defineJob('sort.resort', (payload, job) => runResortJob(payload, job), { timeoutMs: 5 * 60_000 });
    defineJob('sort.rescue', (payload, job) => runRescueJob(payload, job), { timeoutMs: 15 * 60_000 });
    defineJob('sort.reevaluateSpam', (payload, job) => runReevaluateSpamJob(payload, job), { timeoutMs: 15 * 60_000 });
    defineSchedule({ name: 'sort.pending', everySec: 30, run: pendingSweep });
    // Tier 1 coverage: what Tier 0 left unsure reaches Reflex even after a job failed for good.
    defineSchedule({ name: 'sort.reflexSweep', everySec: 120, run: () => reflexSweep() });
    defineSchedule({ name: 'sort.backfill', everySec: 60, run: backfillSweep });
    defineSchedule({ name: 'sort.bundles', everySec: 60, run: () => releaseDueBundles() });
    defineSchedule({ name: 'sort.rescue', everySec: 600, run: () => rescueSweep() });
    // Runs at start-up (short schedules are due at once) and re-checks cheaply: one state read.
    defineSchedule({ name: 'sort.spamSignals', everySec: 600, run: () => ensureSpamSignalsCurrent() });
    // Same for the sorting engine and sort.reflex prompt: a new version re-sorts stored decisions once.
    defineSchedule({ name: 'sort.engine', everySec: 600, run: () => ensureSortEngineCurrent() });
    defineSchedule({ name: 'sort.screener', everySec: 300, run: screenerTick });
    defineSchedule({ name: 'sort.retrain', everySec: 3600, run: () => retrainSortDue() });
  },
};
