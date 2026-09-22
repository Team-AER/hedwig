import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));
vi.mock('./service.js', () => ({
  answerQuestion: vi.fn(), findEntities: vi.fn(async () => []), getEntityCard: vi.fn(async () => null),
  getMessageContext: vi.fn(), getTopicCard: vi.fn(), listCommitments: vi.fn(async () => []), listTopics: vi.fn(async () => []),
  resolveEntityByEmail: vi.fn(async () => null), searchMessages: vi.fn(async () => ({ results: [] })), updateCommitment: vi.fn(),
}));
vi.mock('./cards.js', () => ({ ownsEntity: vi.fn(async () => true), ownsTopic: vi.fn(async () => true) }));
vi.mock('./ask.js', () => ({ askHistory: vi.fn(async () => []) }));
vi.mock('./summaries.js', () => ({ summarizeEntity: vi.fn(async () => true) }));
vi.mock('./commitments.js', () => ({ updateFact: vi.fn() }));

const service = await import('./service.js');
const cards = await import('./cards.js');
const { LlmError } = await import('../llm.js');
const { httpError } = await import('./util.js');
const { contextRoutes } = await import('./routes.js');

const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: USER }; next(); });
  const router = express.Router();
  contextRoutes(router);
  app.use('/api/hedwig', router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/hedwig`;
});
afterAll(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
beforeEach(() => vi.clearAllMocks());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const events = (text) => text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));

describe('context routes', () => {
  it('rejects malformed ids before touching the service', async () => {
    const res = await fetch(`${base}/context/entities/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(service.getEntityCard).not.toHaveBeenCalled();
  });

  it("returns 404 when the record is not the caller's", async () => {
    const res = await fetch(`${base}/context/entities/${ID}`);
    expect(res.status).toBe(404);
    expect(service.getEntityCard).toHaveBeenCalledWith(USER, ID);
  });

  it('passes validation errors through with their status', async () => {
    service.listCommitments.mockRejectedValueOnce(httpError(400, 'invalid status'));
    const res = await fetch(`${base}/context/commitments?status=weird`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid status' });
  });

  it('only forwards the documented fields of a commitment patch', async () => {
    service.updateCommitment.mockResolvedValueOnce({ id: ID, status: 'done' });
    const res = await fetch(`${base}/context/commitments/${ID}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done', user_id: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(service.updateCommitment).toHaveBeenCalledWith(USER, ID, { status: 'done' });
  });

  it('streams ask events as SSE and finishes with done', async () => {
    service.answerQuestion.mockImplementationOnce(async (_u, _q, { onEvent }) => {
      onEvent({ type: 'sources', sources: [] });
      onEvent({ type: 'delta', text: 'Hi' });
      onEvent({ type: 'done', answer: 'Hi', citations: [] });
    });
    const res = await post('/context/ask', { question: 'When are the visa documents due?' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(events(await res.text()).map((e) => e.type)).toEqual(['sources', 'delta', 'done']);
    expect(service.answerQuestion.mock.calls[0][0]).toBe(USER);
  });

  it('reports model failures as an error event', async () => {
    service.answerQuestion.mockRejectedValueOnce(new LlmError('gateway 502: down'));
    const res = await post('/context/ask', { question: 'Anything?' });
    expect(events(await res.text())).toEqual([{ type: 'error', error: 'gateway 502: down' }]);
  });

  it('validates the ask body and scope before streaming', async () => {
    expect((await post('/context/ask', { question: '  ' })).status).toBe(400);
    expect((await post('/context/ask', { question: 'x', entityId: 'nope' })).status).toBe(400);
    cards.ownsTopic.mockResolvedValueOnce(false);
    expect((await post('/context/ask', { question: 'x', topicId: ID })).status).toBe(404);
    expect(service.answerQuestion).not.toHaveBeenCalled();
  });

  it('aborts the model call when the client disconnects', async () => {
    let signal;
    service.answerQuestion.mockImplementationOnce(async (_u, _q, opts) => {
      signal = opts.signal;
      opts.onEvent({ type: 'sources', sources: [] });
      await new Promise((resolve) => opts.signal.addEventListener('abort', resolve));
    });
    const controller = new AbortController();
    const res = await fetch(`${base}/context/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'x' }), signal: controller.signal,
    });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });
});
