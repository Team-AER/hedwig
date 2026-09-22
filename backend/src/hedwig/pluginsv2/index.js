// Plugins v2 module — manifests, permissions, loader, facade, routes. See docs/hedwig/PLUGINS.md.
//
// Loads in both processes: the API mounts plugin routes and runs API-side actions (mail writes and
// drafts need the live mail engine); the worker runs plugin hooks fired by the pipeline, plugin
// jobs and schedules, and follows installs the API records in hedwig_plugins.
import { defineJob } from '../jobs.js';
import { defineSchedule } from '../schedule.js';
import { PluginRuntime, ACTION_JOB } from './loader.js';
import { accessSummary } from './access.js';
import { userRoutes, adminRoutes } from './routes.js';
import { BUNDLED } from './bundled.js';

export const runtime = new PluginRuntime({ bundled: BUNDLED });

/**
 * Activation and grants of every loaded v2 plugin for a user, in the shape
 * agent/toolRegistry.toolsFor() takes: { activePlugins: Set<pluginId>, grants: Set<'pluginId:perm'> }.
 */
export async function pluginAccessFor(userId) {
  return accessSummary(userId, runtime.list().filter((e) => e.status === 'loaded').map((e) => e.id));
}

function summary() {
  const list = runtime.list();
  const bad = list.filter((e) => e.status !== 'loaded');
  return `${list.length - bad.length} loaded${bad.length ? `, ${bad.length} not loaded (${bad.map((e) => `${e.id}: ${e.status}`).join('; ')})` : ''}`;
}

export default {
  name: 'pluginsv2',

  routes(r) { userRoutes(r, runtime); },
  adminRoutes(r) { adminRoutes(r, runtime); },

  async api({ imapManager }) {
    runtime.processKind = 'api';
    runtime.setEngine(imapManager || null);
    defineJob(ACTION_JOB, (payload) => runtime.actionJob(payload), { timeoutMs: 120_000 });
    try { await runtime.loadAll(); } catch (err) { console.error('[pluginsv2] loading plugins failed:', err); }
    console.log(`Hedwig plugins: ${summary()}`);
  },

  async worker() {
    runtime.processKind = 'worker';
    try { await runtime.loadAll(); } catch (err) { console.error('[pluginsv2] loading plugins failed:', err); }
    defineSchedule({ name: 'pluginsv2.sync', everySec: 30, run: () => runtime.syncFromDb() });
    console.log(`[hedwig-worker] plugins: ${summary()}`);
  },
};
