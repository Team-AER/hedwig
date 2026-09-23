// Admin routes for the job ledger and prompt registry, mounted by core under /api/hedwig/admin
// (requireAdmin already applied).
import { queueStats, listFailed, retryFailed, reconcile, healthGate, jobKinds, gatewayHealth } from '../jobs.js';
import { listPrompts } from '../prompts/index.js';
import { tierStatus, probeModels } from '../llm.js';
import { catalogView, runtimeSettings, updateRuntime, usageReport } from './admin.js';

// PRD: reconcile runs on every admin-page load (and hourly in the worker). Throttled, and never
// awaited by the page: a slow rebuild() must not hold the admin page.
let lastReconcile = 0;
export function reconcileOnLoad(now = Date.now()) {
  if (now - lastReconcile < 60_000) return false;
  lastReconcile = now;
  reconcile().catch((err) => console.warn('[hedwig] reconcile on admin load failed:', err?.message || err));
  return true;
}

function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
}

export function runtimeAdminRoutes(r) {
  r.get('/jobs/stats', async (req, res) => {
    try {
      reconcileOnLoad();
      res.json({ kinds: jobKinds(), stats: await queueStats(), gateway: gatewayHealth() });
    } catch (err) { sendError(res, err); }
  });
  r.get('/jobs/failed', async (req, res) => {
    try {
      const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
      res.json({ jobs: await listFailed({ kind, limit: req.query.limit }) });
    } catch (err) { sendError(res, err); }
  });
  r.post('/jobs/retry', async (req, res) => {
    try {
      const kind = typeof req.body?.kind === 'string' && req.body.kind ? req.body.kind : null;
      res.json(await retryFailed(kind));
    } catch (err) { sendError(res, err); }
  });
  // No reapStuck() here: this runs in the API process, which does not define every job kind and
  // would requeue long-running worker jobs of kinds it does not know. The worker reaps every 5 min.
  r.post('/jobs/reconcile', async (req, res) => {
    try {
      const [rec, gate] = await Promise.all([reconcile(), healthGate()]);
      res.json({ ...rec, gateway: gate });
    } catch (err) { sendError(res, err); }
  });
  r.get('/prompts', async (req, res) => {
    try {
      res.json({ prompts: await listPrompts() });
    } catch (err) { sendError(res, err); }
  });

  // --- v2 runtime audit: tiers, runtime settings, catalog, usage (shapes in ledger/admin.js) ---
  r.get('/tiers', async (req, res) => {
    try { res.json(await tierStatus(null)); } catch (err) { sendError(res, err); }
  });
  r.post('/tiers/probe', async (req, res) => {
    try {
      const probe = await probeModels({ force: true });
      res.json({ ...(await tierStatus(null)), probed: probe.models || [], skipped: probe.skipped || null });
    } catch (err) { sendError(res, err); }
  });
  r.get('/runtime', async (req, res) => {
    try { res.json(await runtimeSettings()); } catch (err) { sendError(res, err); }
  });
  r.put('/runtime', async (req, res) => {
    try { res.json(await updateRuntime(req.body || {})); } catch (err) { sendError(res, err); }
  });
  r.get('/models/catalog', async (req, res) => {
    try { res.json(await catalogView({ refresh: req.query.refresh === '1' })); } catch (err) { sendError(res, err); }
  });
  r.get('/usage', async (req, res) => {
    try {
      res.json(await usageReport({ days: req.query.days, userId: typeof req.query.userId === 'string' ? req.query.userId : null }));
    } catch (err) { sendError(res, err); }
  });
}
