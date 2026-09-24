// /api/hedwig/work/* — working the inbox (lists, Done, sweep, snooze, reminders), the thread story
// and quick replies, drafts in the owner's voice, Waiting On with nudges, and the send guard.
import { getConfig } from '../config.js';
import { listCounts, listItems, addItem, removeItem, sweep, snooze } from './lists.js';
import { threadStory } from './thread.js';
import { draft } from './draft.js';
import { listWaiting, addWatch, resolveWaiting, nudge } from './waiting.js';
import { sendGuard } from './sendguard.js';
import { tldrFor, messageTldr, summaryStatus, SUMMARISE_JOB } from './summaries.js';
import { needsFor } from './needs.js';
import { regenerateStory, regenerateTldr, takeRegenerate } from './regenerate.js';
import { latestOfThreads, streamRow, isUuid, httpError } from './util.js';
import { enqueue } from '../jobs.js';

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
  // "Regenerate summary" (the sparkles in the summary): six a minute per user, 429 past that.
  r.post('/work/thread/:threadId/story/regenerate', handle((req, userId) => {
    takeRegenerate(userId);
    return regenerateStory(userId, req.params.threadId);
  }));
  r.post('/work/message/:id/tldr/regenerate', handle((req, userId) => {
    if (!isUuid(req.params.id)) throw httpError(400, 'invalid message id');
    takeRegenerate(userId);
    return regenerateTldr(userId, req.params.id);
  }));

  r.get('/work/waiting', handle((req, userId) => listWaiting(userId)));
  r.post('/work/waiting', handle((req, userId) => addWatch(userId, req.body || {})));
  r.post('/work/waiting/:threadId/nudge', handle((req, userId) => nudge(userId, req.params.threadId)));
  r.post('/work/waiting/:threadId/resolve', handle((req, userId) => resolveWaiting(userId, req.params.threadId)));

  r.post('/work/sendguard', handle((req, userId) => sendGuard(userId, req.body || {})));

  // --- v2 work audit ---
  // TL;DRs for any rows (Screener, Reading, search): GET /work/tldr?ids=<uuid>,<uuid>
  r.get('/work/tldr', handle(async (req, userId) => {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(isUuid).slice(0, 200);
    const map = await tldrFor(userId, ids);
    return { tldr: Object.fromEntries([...map].map(([id, t]) => [id, t])) };
  }));
  r.get('/work/message/:id/tldr', handle((req, userId) => {
    if (!isUuid(req.params.id)) throw httpError(400, 'invalid message id');
    return messageTldr(userId, req.params.id, { compute: truthy(req.query.compute) });
  }));
  // Work's own Needs You reasons, as stream rows.
  r.get('/work/needs', handle(async (req, userId) => {
    const { query } = await import('../../services/db.js');
    const { rows } = await query('SELECT DISTINCT thread_key FROM hedwig_work_needs WHERE user_id = $1 AND resolved_at IS NULL LIMIT 500', [userId]);
    const keys = rows.map((x) => x.thread_key);
    const [latest, needs] = await Promise.all([latestOfThreads(userId, keys), needsFor(userId, keys)]);
    const items = keys.filter((k) => latest.has(k)).map((k) => {
      const n = needs.get(k);
      return streamRow(latest.get(k), { needsYou: true, reason: n.reason, workNeeds: n });
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
    return { items };
  }));
  // Coverage of the eager summaries, and a way to ask for a pass now.
  r.get('/work/summaries/status', handle((req, userId) => summaryStatus(userId)));
  r.post('/work/summaries/run', handle(async (req, userId) => ({
    queued: Boolean(await enqueue(SUMMARISE_JOB, { userId }, { userId, dedupeKey: `work.summarise:${userId}`, priority: 5, maxAttempts: 3 })),
  })));
  // --- end v2 work audit ---
}
