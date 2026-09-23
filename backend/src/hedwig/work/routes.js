// /api/hedwig/work/* — working the inbox (lists, Done, sweep, snooze, reminders), the thread story
// and quick replies, drafts in the owner's voice, Waiting On with nudges, and the send guard.
import { getConfig } from '../config.js';
import { listCounts, listItems, addItem, removeItem, sweep, snooze } from './lists.js';
import { threadStory } from './thread.js';
import { draft } from './draft.js';
import { listWaiting, addWatch, resolveWaiting, nudge } from './waiting.js';
import { sendGuard } from './sendguard.js';

function handle(fn) {
  return async (req, res) => {
    try {
      const userId = req.session.userId;
      const cfg = await getConfig(userId);
      if (cfg['work.enabled'] === false) {
        res.status(404).json({ error: 'Working the inbox is off in your settings' });
        return;
      }
      res.json(await fn(req, userId));
    } catch (err) {
      const status = err.status || (err.name === 'BudgetExceededError' ? 429 : 500);
      if (status >= 500) console.warn(`[hedwig] ${req.method} ${req.originalUrl} failed:`, err.message);
      res.status(status).json({ error: status === 500 ? 'Internal error' : err.message, ...(err.code ? { code: err.code } : {}) });
    }
  };
}

const truthy = (v) => v === '1' || v === 'true' || v === true;

export function mountWorkRoutes(r) {
  r.get('/work/lists', handle((req, userId) => listCounts(userId)));
  r.get('/work/lists/:kind', handle((req, userId) => listItems(userId, req.params.kind, { limit: req.query.limit })));
  r.post('/work/lists/:kind', handle((req, userId) => addItem(userId, req.params.kind, req.body || {})));
  r.delete('/work/lists/:kind/:threadId', handle((req, userId) => removeItem(userId, req.params.kind, req.params.threadId)));
  r.post('/work/sweep', handle((req, userId) => sweep(userId, req.body || {})));
  r.post('/work/snooze', handle((req, userId) => snooze(userId, req.body || {})));

  r.get('/work/thread/:threadId', handle((req, userId) => threadStory(userId, req.params.threadId, { refresh: truthy(req.query.refresh) })));
  r.post('/work/draft', handle((req, userId) => draft(userId, req.body || {})));

  r.get('/work/waiting', handle((req, userId) => listWaiting(userId)));
  r.post('/work/waiting', handle((req, userId) => addWatch(userId, req.body || {})));
  r.post('/work/waiting/:threadId/nudge', handle((req, userId) => nudge(userId, req.params.threadId)));
  r.post('/work/waiting/:threadId/resolve', handle((req, userId) => resolveWaiting(userId, req.params.threadId)));

  r.post('/work/sendguard', handle((req, userId) => sendGuard(userId, req.body || {})));
}
