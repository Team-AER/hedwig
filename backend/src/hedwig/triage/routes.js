// /api/hedwig/triage/* — see docs/hedwig/API.md "Triage".
import {
  listTriage, getTriage, overrideTriage, resolveTriage, triageStats, listDecisions, senderRule, retrain,
} from './service.js';

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req, req.session.userId));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.warn(`[hedwig] ${req.method} ${req.originalUrl} failed:`, err.message);
      res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
    }
  };
}

export function mountTriageRoutes(r) {
  r.get('/triage/list', handle((req, userId) => listTriage(userId, {
    view: req.query.view || 'needs_you',
    accountId: req.query.accountId || null,
    limit: req.query.limit,
    before: req.query.before || null,
  })));

  r.get('/triage/stats', handle((req, userId) => triageStats(userId)));

  r.get('/triage/decisions', handle((req, userId) => listDecisions(userId, { limit: req.query.limit })));

  r.get('/triage/messages/:messageId', handle(async (req, userId) => {
    const out = await getTriage(userId, req.params.messageId);
    if (!out) {
      const err = new Error('Message not triaged');
      err.status = 404;
      throw err;
    }
    return out;
  }));

  r.post('/triage/messages/:messageId/override', handle((req, userId) => overrideTriage(userId, req.params.messageId, req.body || {})));

  r.post('/triage/messages/:messageId/resolve', handle((req, userId) => resolveTriage(userId, req.params.messageId)));

  r.post('/triage/sender-rule', handle((req, userId) => {
    const { sender, domain, category, preview } = req.body || {};
    return senderRule(userId, { sender, domain, category, preview: preview === true || preview === 'true' });
  }));

  r.post('/triage/retrain', handle((req, userId) => retrain(userId)));
}
