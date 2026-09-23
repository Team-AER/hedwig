// /api/hedwig/index/… and /api/hedwig/admin/index/…
import { indexStatus, rebuild } from './service.js';

const sendError = (res, err) => res.status(err.status || 500).json({ error: err.message || 'Internal error' });

export function indexRoutes(r) {
  // Per-folder coverage with percentages, totals, recipe and backlog for the signed-in user.
  r.get('/index/status', async (req, res) => {
    try { res.json(await indexStatus(req.session.userId)); } catch (err) { sendError(res, err); }
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function indexAdminRoutes(r) {
  r.get('/index/status', async (req, res) => {
    const userId = req.query.userId || req.session.userId;
    if (!UUID_RE.test(String(userId))) return res.status(400).json({ error: 'invalid userId' });
    try { res.json(await indexStatus(userId)); } catch (err) { sendError(res, err); }
  });
  // { userId?, recipe? }: re-chunk and re-embed one user (or everyone), or move to a new recipe.
  r.post('/index/rebuild', async (req, res) => {
    const { userId = null, recipe = null } = req.body || {};
    if (userId != null && !UUID_RE.test(String(userId))) return res.status(400).json({ error: 'invalid userId' });
    try { res.json(await rebuild({ userId, recipe })); } catch (err) { sendError(res, err); }
  });
}
