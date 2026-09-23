// Admin routes for the job ledger and prompt registry, mounted by core under /api/hedwig/admin
// (requireAdmin already applied).
import { queueStats, listFailed, retryFailed, reconcile, healthGate, jobKinds, gatewayHealth } from '../jobs.js';
import { listPrompts } from '../prompts/index.js';

function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
}

export function runtimeAdminRoutes(r) {
  r.get('/jobs/stats', async (req, res) => {
    try {
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
}
