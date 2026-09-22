// Agent module: the tool-using loop, pending actions and automations. See docs/hedwig/API.md.
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { registerAgentTools } from './tools/index.js';
import { mountAgentRoutes } from './routes.js';
import { EXECUTE_JOB, executeActionJob } from './actions.js';
import { RUN_JOB, runAutomationJob, tickAutomations } from './automations.js';

export default {
  name: 'agent',

  tools() {
    const { fallbacks } = registerAgentTools();
    if (fallbacks.length) console.warn(`[hedwig] agent: using built-in stand-ins for ${fallbacks.join(', ')} (owning module did not register them)`);
  },

  routes(r) {
    mountAgentRoutes(r);
  },

  // Approved actions change mail, so they execute where the mail engine lives.
  api() {
    defineJob(EXECUTE_JOB, executeActionJob, { timeoutMs: 5 * 60_000 });
  },

  worker() {
    defineJob(RUN_JOB, runAutomationJob, { timeoutMs: 15 * 60_000 });
    defineSchedule({ name: 'agent.automations', everySec: 60, run: () => tickAutomations() });
  },
};
