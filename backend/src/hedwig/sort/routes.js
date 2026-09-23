// /api/hedwig/sort/* — see docs/hedwig/V2-BUILD.md "C → E: sorting routes".
import * as svc from './service.js';

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

const truthy = (v) => v === '1' || v === 'true' || v === true;

export function mountSortRoutes(r) {
  r.get('/sort/stream/:stream', handle((req, userId) => svc.streamList(userId, req.params.stream, {
    cursor: req.query.cursor || null,
    needsYou: truthy(req.query.needsYou),
    limit: req.query.limit,
    bundle: req.query.bundle || null,
    held: truthy(req.query.held),
  })));

  r.get('/sort/screener', handle((req, userId) => svc.screener(userId)));
  r.post('/sort/screener/decide', handle((req, userId) => svc.decide(userId, req.body || {})));

  r.post('/sort/correct', handle((req, userId) => svc.correct(userId, req.body || {})));

  r.get('/sort/today', handle((req, userId) => svc.today(userId)));
  r.post('/sort/undo', handle((req, userId) => svc.undo(userId, req.body || {})));

  r.get('/sort/bundles', handle((req, userId) => svc.bundles(userId)));
  r.post('/sort/bundles', handle((req, userId) => svc.addBundle(userId, req.body || {})));
  r.patch('/sort/bundles/:id', handle((req, userId) => svc.changeBundle(userId, req.params.id, req.body || {})));

  r.get('/sort/rules', handle((req, userId) => svc.rules(userId)));
  r.post('/sort/rules', handle((req, userId) => svc.addRule(userId, req.body || {})));
  r.post('/sort/rules/import', handle((req, userId) => svc.importGmail(userId, req.body || {})));
  r.post('/sort/rules/:id/dryrun', handle((req, userId) => svc.dryRunRule(userId, req.params.id, req.body || {})));
  r.patch('/sort/rules/:id', handle((req, userId) => svc.changeRule(userId, req.params.id, req.body || {})));
  r.delete('/sort/rules/:id', handle((req, userId) => svc.removeRule(userId, req.params.id)));

  r.get('/sort/message/:id/why', handle((req, userId) => svc.why(userId, req.params.id)));

  // Check the spam folder for mail worth rescuing now (queued; the result lands in the Screener).
  r.post('/sort/rescue/run', handle((req, userId) => svc.runRescue(userId)));
  r.get('/sort/rescue/status', handle((req, userId) => svc.rescueStatus(userId)));
}

// /api/hedwig/admin/sort/* (requireAdmin applied by the module loader).
export function mountSortAdminRoutes(r) {
  r.get('/sort/rescue', handle(() => svc.rescueStatus(null)));
  r.post('/sort/rescue/run', handle((req) => svc.runRescueFor((req.body || {}).userId || null)));
  r.post('/sort/spam/reevaluate', handle((req) => svc.reevaluateSpamFor((req.body || {}).userId || null)));
}
