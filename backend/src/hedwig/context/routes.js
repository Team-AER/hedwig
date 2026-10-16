// Context routes (docs/hedwig/API.md, "Context"). Mounted under /api/hedwig with requireAuth.
import {
  answerQuestion, findEntities, getEntityCard, getMessageContext, getTopicCard, listCommitments,
  listTopics, resolveEntityByEmail, searchMessages, updateCommitment,
} from './service.js';
import { LlmError } from '../llm.js';
import { updateFact } from './commitments.js';
import { askHistory } from './ask.js';
import { ownsEntity, ownsTopic } from './cards.js';
import { summarizeEntity } from './summaries.js';
import { clampInt, isUuid } from './util.js';
import { findThreadKey } from '../work/util.js';
import { webSettings } from '../ask2/web.js';
import { getConfig } from '../config.js';

function sendError(res, err) {
  if (err instanceof LlmError) return res.status(err.status || 502).json({ error: err.message });
  if (err?.expose && err.status) return res.status(err.status).json({ error: err.message });
  console.warn('[hedwig] context route failed:', err?.message || err);
  return res.status(500).json({ error: 'Internal error' });
}

/** Wrap a handler: 400 on a malformed :id param, JSON errors, 404 for null results. */
function handle(fn, { uuidParams = [], notFound = 'Not found' } = {}) {
  return async (req, res) => {
    for (const p of uuidParams) if (!isUuid(req.params[p])) return res.status(400).json({ error: `invalid ${p}` });
    try {
      const out = await fn(req, res);
      if (res.headersSent) return undefined;
      if (out == null) return res.status(404).json({ error: notFound });
      return res.json(out);
    } catch (err) {
      return sendError(res, err);
    }
  };
}

function publicStreamError(err) {
  if (err instanceof LlmError || err?.expose) return err.message;
  return 'Something went wrong answering that.';
}

export function contextRoutes(r) {
  r.get('/context/entities', handle((req) => findEntities(
    req.session.userId, req.query.q, clampInt(req.query.limit, 1, 200, 30), { kind: req.query.kind || null },
  )));

  r.get('/context/entities/by-email/:email', handle(
    (req) => resolveEntityByEmail(req.session.userId, req.params.email),
    { notFound: 'Entity not found' },
  ));

  r.get('/context/entities/:id', handle(
    (req) => getEntityCard(req.session.userId, req.params.id),
    { uuidParams: ['id'], notFound: 'Entity not found' },
  ));

  r.post('/context/entities/:id/refresh', handle(async (req) => {
    if (!(await ownsEntity(req.session.userId, req.params.id))) return null;
    await summarizeEntity(req.params.id, { userId: req.session.userId, force: true });
    return { ok: true };
  }, { uuidParams: ['id'], notFound: 'Entity not found' }));

  r.get('/context/topics', handle((req) => listTopics(req.session.userId, { limit: clampInt(req.query.limit, 1, 200, 30) })));

  r.get('/context/topics/:id', handle(
    (req) => getTopicCard(req.session.userId, req.params.id),
    { uuidParams: ['id'], notFound: 'Topic not found' },
  ));

  r.get('/context/messages/:messageId', handle(
    (req) => getMessageContext(req.session.userId, req.params.messageId),
    { uuidParams: ['messageId'], notFound: 'Message not found' },
  ));

  r.get('/context/commitments', handle((req) => listCommitments(req.session.userId, {
    status: req.query.status || 'open',
    direction: req.query.direction || null,
    limit: clampInt(req.query.limit, 1, 500, 50),
  })));

  r.patch('/context/commitments/:id', handle(
    (req) => updateCommitment(req.session.userId, req.params.id, pick(req.body, ['status', 'what', 'due_at'])),
    { uuidParams: ['id'], notFound: 'Commitment not found' },
  ));

  r.patch('/context/facts/:id', handle(
    (req) => updateFact(req.session.userId, req.params.id, pick(req.body, ['value', 'dismissed', 'pinned'])),
    { uuidParams: ['id'], notFound: 'Fact not found' },
  ));

  r.post('/context/search', handle((req) => {
    const b = req.body || {};
    if (typeof b.q !== 'string' || !b.q.trim()) return { results: [] };
    return searchMessages(req.session.userId, {
      q: b.q, limit: b.limit, entityId: b.entityId || null, topicId: b.topicId || null, after: b.after, before: b.before,
    });
  }));

  // What the Ask pane offers this user: the web toggle shows only when a search service is set up.
  r.get('/context/ask/options', handle(async (req) => {
    const ws = webSettings(await getConfig(req.session.userId));
    return { web: { allowed: ws.allowed, available: ws.available } };
  }));

  r.get('/context/ask/history', handle(async (req) => {
    const userId = req.session.userId;
    // A thread id from the reader may be a message id; history is kept by thread_key.
    const asked = typeof req.query.threadKey === 'string' && req.query.threadKey.trim() && req.query.threadKey.length <= 1000 ? req.query.threadKey : null;
    const threadKey = asked ? await findThreadKey(userId, asked) : null;
    if (asked && !threadKey) return [];
    return askHistory(userId, { limit: req.query.limit, threadKey });
  }));

  r.post('/context/ask', async (req, res) => {
    const userId = req.session.userId;
    const { question, entityId = null, topicId = null, threadKey = null, web = null, deep = false } = req.body || {};
    if (typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'question is required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question too long' });
    for (const [name, v] of [['entityId', entityId], ['topicId', topicId]]) {
      if (v != null && !isUuid(v)) return res.status(400).json({ error: `invalid ${name}` });
    }
    if (threadKey != null && (typeof threadKey !== 'string' || !threadKey.trim() || threadKey.length > 1000)) return res.status(400).json({ error: 'invalid threadKey' });
    if (web != null && typeof web !== 'boolean') return res.status(400).json({ error: 'web must be true or false' });
    try {
      if (entityId && !(await ownsEntity(userId, entityId))) return res.status(404).json({ error: 'Entity not found' });
      if (topicId && !(await ownsTopic(userId, topicId))) return res.status(404).json({ error: 'Topic not found' });
      if (threadKey && !(await findThreadKey(userId, threadKey))) return res.status(404).json({ error: 'Thread not found' });
    } catch (err) {
      return sendError(res, err);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const controller = new AbortController();
    // `close` on the response fires both when we end it and when the client goes away.
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', onClose);
    const send = (evt) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    // SSE comment every 15 s so proxies keep the connection open while the model is queued.
    const keepalive = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
    try {
      await answerQuestion(userId, question, {
        entityId, topicId, threadKey, web, deep: deep === true,
        followUpOf: isUuid(req.body?.followUpOf) ? req.body.followUpOf : null, onEvent: send, signal: controller.signal,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        if (!(err instanceof LlmError) && !err?.expose) console.warn('[hedwig] context ask failed:', err?.message || err);
        send({ type: 'error', error: publicStreamError(err) });
      }
    } finally {
      clearInterval(keepalive);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
    return undefined;
  });
}

function pick(body, keys) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  return out;
}
