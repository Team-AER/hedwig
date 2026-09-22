// triage module — learning triage (Needs you, Waiting on, Digest, Notifications, Everything, Spam).
// See docs/hedwig/ARCHITECTURE.md and docs/hedwig/API.md "Triage".
import { defineStep } from '../pipeline.js';
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { getConfig } from '../config.js';
import { query } from '../../services/db.js';
import { runSenderStats } from './senderStats.js';
import { runTriage } from './classify.js';
import { runStage3 } from './stage3.js';
import { sweepResolution, scanWaitingOn } from './resolution.js';
import { implicitFeedbackSweep, retrainDue } from './learning.js';
import { makePushJunkHandler } from './junk.js';
import { mountTriageRoutes } from './routes.js';
import { registerTriageTools } from './tools.js';
import { userAddresses } from './store.js';

async function activeTriageUsers() {
  const { rows } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  const out = [];
  for (const { user_id: userId } of rows) {
    const cfg = await getConfig(userId);
    if (cfg.enabled && cfg['features.triage']) out.push({ userId, cfg });
  }
  return out;
}

/** Every 15 minutes: resolve handled items, then find what the user is waiting on. */
export async function waitingAndResolutionTick() {
  const users = await activeTriageUsers();
  const addrs = await userAddresses(users.map((u) => u.userId));
  for (const { userId, cfg } of users) {
    const mine = addrs.get(userId) || new Set();
    try {
      await sweepResolution(userId, mine);
      await scanWaitingOn(userId, mine, { waitingDays: cfg['triage.waitingOnDays'] });
    } catch (err) {
      console.warn(`[hedwig] triage waiting-on/resolution failed for user ${userId}:`, err.message);
    }
  }
}

export default {
  name: 'triage',

  tools() {
    registerTriageTools();
  },

  routes(router) {
    mountTriageRoutes(router);
  },

  api({ imapManager }) {
    defineJob('triage.pushJunk', makePushJunkHandler(imapManager), { timeoutMs: 90_000 });
  },

  worker() {
    defineStep({ name: 'senderStats', order: 15, backfill: true, run: (rows) => runSenderStats(rows) });
    defineStep({ name: 'triage', order: 30, backfill: false, run: (rows) => runTriage(rows) });
    defineJob('triage.llm', (payload, job) => runStage3(payload, job), { timeoutMs: 3 * 60_000 });
    defineSchedule({ name: 'triage.waitingOn', everySec: 15 * 60, run: waitingAndResolutionTick });
    defineSchedule({ name: 'triage.implicitFeedback', everySec: 3600, run: implicitFeedbackSweep });
    defineSchedule({ name: 'triage.retrain', everySec: 3600, run: () => retrainDue() });
  },
};
