// onboarding module (v2 stream I): "Sort the past" for a new user, the read-only routing table for
// everyone, and the admin routing table, model bounds and household summary. See docs/hedwig/API.md.
// Admin routes are mounted under /api/hedwig/admin with requireAdmin, so non-admins get 403.
import { getConfig } from '../config.js';
import { onboardingStatus, acceptProposals, dismissOnboarding } from './status.js';
import { routingTable, updateRouting, enabledModels, setEnabledModels, usersSummary } from './routing.js';

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[hedwig] onboarding/admin route failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

const handle = (fn) => async (req, res) => {
  try {
    const cfg = await getConfig(req.session.userId);
    if (!cfg.enabled) return res.status(403).json({ error: 'Hedwig intelligence is turned off' });
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

const admin = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { sendError(res, err); }
};

export default {
  name: 'onboarding',

  routes(r) {
    r.get('/onboarding/status', handle(async (req, res) => res.json(await onboardingStatus(req.session.userId))));
    r.post('/onboarding/accept', handle(async (req, res) => res.json(await acceptProposals(req.session.userId, req.body || {}))));
    r.post('/onboarding/dismiss', handle(async (req, res) => res.json(await dismissOnboarding(req.session.userId, req.body || {}))));
    // Read-only routing table for everyone (Power mode shows it), with the user's own spend today.
    r.get('/routing', handle(async (req, res) => res.json(await routingTable({ userId: req.session.userId }))));
  },

  adminRoutes(r) {
    r.get('/routing', admin(async (req, res) => res.json(await routingTable())));
    r.put('/routing', admin(async (req, res) => res.json(await updateRouting(req.body || {}))));
    r.get('/models/enabled', admin(async (req, res) => res.json(await enabledModels())));
    r.put('/models/enabled', admin(async (req, res) => res.json(await setEnabledModels(req.body || {}))));
    r.get('/users/summary', admin(async (req, res) => res.json(await usersSummary())));
  },
};
