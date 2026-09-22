// Agent routes (mounted at /api/hedwig with requireAuth). Contract: docs/hedwig/API.md "Agent".
import { getConfig } from '../config.js';
import { runAgent } from './runner.js';
import { userTools } from './access.js';
import { approveAction, rejectAction } from './actions.js';
import {
  listAutomations, createAutomation, updateAutomation, deleteAutomation, startAutomationNow, availableTemplates,
} from './automations.js';
import * as store from './store.js';

const ACTION_STATUSES = ['pending', 'approved', 'rejected', 'executed', 'failed'];
const KEEPALIVE_MS = 15_000;

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[hedwig] agent route failed:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

const handle = (fn) => async (req, res) => {
  try {
    const cfg = await getConfig(req.session.userId);
    if (!cfg.enabled || !cfg['features.agent']) return res.status(403).json({ error: 'The agent is turned off' });
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

/**
 * POST /agent/runs as Server-Sent Events. Headers are sent with the first event, so a request the
 * runner rejects up front (bad prompt, unknown run, run busy) still gets a plain JSON error.
 */
async function streamRun(req, res) {
  const body = req.body || {};
  const controller = new AbortController();
  let started = false;
  let keepalive = null;
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const send = (event) => {
    if (res.writableEnded || res.destroyed) return;
    if (!started) {
      started = true;
      res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      keepalive = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, KEEPALIVE_MS);
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await runAgent({
      userId: req.session.userId,
      prompt: body.prompt,
      runId: body.runId || null,
      allowedTools: body.allowedTools ?? null,
      trigger: 'chat',
      onEvent: send,
      signal: controller.signal,
    });
  } catch (err) {
    if (!started) return sendError(res, err);
    send({ type: 'error', error: err.status && err.status < 500 ? err.message : 'The agent failed' });
    if (!err.status || err.status >= 500) console.error('[hedwig] agent run stream failed:', err);
  } finally {
    clearInterval(keepalive);
  }
  if (!res.writableEnded) res.end();
}

export function mountAgentRoutes(r) {
  r.get('/agent/tools', handle(async (req, res) => {
    const tools = await userTools(req.session.userId);
    res.json(tools.map((t) => ({ name: t.name, description: t.description, mutates: Boolean(t.mutates), pluginId: t.pluginId || null })));
  }));

  r.post('/agent/runs', handle(streamRun));

  r.get('/agent/runs', handle(async (req, res) => {
    res.json(await store.listRuns(req.session.userId, { limit: req.query.limit }));
  }));

  r.get('/agent/runs/:id', handle(async (req, res) => {
    const row = await store.getRunRow(req.session.userId, req.params.id);
    if (!row) return res.status(404).json({ error: 'Run not found' });
    const actions = await store.listActions(req.session.userId, { runId: row.id, limit: 500 });
    res.json({ run: store.toRun(row), actions: actions.reverse() });
  }));

  r.get('/agent/actions', handle(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !ACTION_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${ACTION_STATUSES.join(', ')}` });
    res.json(await store.listActions(req.session.userId, { status }));
  }));

  r.post('/agent/actions/:id/approve', handle(async (req, res) => {
    const { action, result } = await approveAction(req.session.userId, req.params.id);
    res.json({ action, result });
  }));

  r.post('/agent/actions/:id/reject', handle(async (req, res) => {
    res.json(await rejectAction(req.session.userId, req.params.id));
  }));

  // Before the :id routes so "templates" is never read as an id.
  r.get('/agent/automations/templates', handle(async (req, res) => {
    res.json(availableTemplates());
  }));

  r.get('/agent/automations', handle(async (req, res) => {
    res.json(await listAutomations(req.session.userId));
  }));

  r.post('/agent/automations', handle(async (req, res) => {
    res.json(await createAutomation(req.session.userId, req.body || {}));
  }));

  r.patch('/agent/automations/:id', handle(async (req, res) => {
    res.json(await updateAutomation(req.session.userId, req.params.id, req.body || {}));
  }));

  r.delete('/agent/automations/:id', handle(async (req, res) => {
    const ok = await deleteAutomation(req.session.userId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Automation not found' });
    res.json({ ok: true });
  }));

  r.post('/agent/automations/:id/run', handle(async (req, res) => {
    res.json(await startAutomationNow(req.session.userId, req.params.id));
  }));
}
