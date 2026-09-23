import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ enabled: true, 'insights.timezone': 'UTC', 'cards.scanEverySec': 60 })) }));
vi.mock('./store.js', () => ({
  listCards: vi.fn(async () => []), getCard: vi.fn(async () => null), patchCard: vi.fn(async () => null), dismissCard: vi.fn(async () => null),
}));
vi.mock('./today.js', () => ({ cardsToday: vi.fn(async () => [{ kind: 'delivery', figure: 'Today', title: 'Shoes', caption: 'DHL, out for delivery', messageId: 'm', cardId: 'c' }]) }));
vi.mock('../ask2/history.js', () => ({ getAnswer: vi.fn(async () => null), answerFeedback: vi.fn(async () => ({ ok: true, feedback: { wrong: true } })) }));

const store = await import('./store.js');
const history = await import('../ask2/history.js');
const cardsModule = (await import('./index.js')).default;
const ask2Module = (await import('../ask2/index.js')).default;

const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: USER }; next(); });
  const router = express.Router();
  router.get('/context/ask/history', (_req, res) => res.json([]));
  ask2Module.routes(router);
  cardsModule.routes(router);
  app.use('/api/hedwig', router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/hedwig`;
});
afterAll(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
beforeEach(() => vi.clearAllMocks());

const send = (method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

describe('cards routes', () => {
  it('lists cards filtered by kinds and since', async () => {
    const res = await send('GET', '/cards?kinds=delivery,receipt&since=2026-09-01');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cards: [] });
    expect(store.listCards).toHaveBeenCalledWith(USER, expect.objectContaining({ kinds: ['delivery', 'receipt'], since: new Date('2026-09-01') }));
  });

  it('rejects unknown kinds, bad dates and malformed ids', async () => {
    expect((await send('GET', '/cards?kinds=pizza')).status).toBe(400);
    expect((await send('GET', '/cards?since=soon')).status).toBe(400);
    expect((await send('GET', '/cards/not-an-id')).status).toBe(400);
    expect((await send('GET', '/cards/ledger/pizzas')).status).toBe(400);
    expect((await send('GET', `/cards/${ID}`)).status).toBe(404);
  });

  it('serves Today figures as an array and one message\'s cards', async () => {
    expect(await (await send('GET', '/cards/today')).json()).toEqual([expect.objectContaining({ kind: 'delivery', figure: 'Today' })]);
    await send('GET', `/cards/message/${ID}`);
    expect(store.listCards).toHaveBeenCalledWith(USER, { messageId: ID, includeDismissed: true });
  });

  it('passes edits and dismissals to the store', async () => {
    store.patchCard.mockResolvedValueOnce({ id: ID, fields: { total: 5 } });
    const res = await send('PATCH', `/cards/${ID}`, { fields: { total: 5 } });
    expect(res.status).toBe(200);
    expect(store.patchCard).toHaveBeenCalledWith(USER, ID, { total: 5 });
    store.dismissCard.mockResolvedValueOnce({ ok: true, id: ID });
    expect((await send('POST', `/cards/${ID}/dismiss`)).status).toBe(200);
    store.patchCard.mockRejectedValueOnce(Object.assign(new Error('total is not a field'), { status: 400 }));
    expect((await send('PATCH', `/cards/${ID}`, { fields: { x: 1 } })).status).toBe(400);
  });

  it('returns card actions as payloads', async () => {
    store.getCard.mockResolvedValueOnce({ id: ID, kind: 'invoice', fields: { dueDate: '2026-09-25', issuer: 'Fjordkraft', amount: 1240, currency: 'NOK' }, message: null });
    const body = await (await send('GET', `/cards/${ID}/actions`)).json();
    expect(body.actions.map((a) => a.id)).toEqual(['calendar', 'reminder']);
    expect(body.actions[0].ics).toContain('BEGIN:VCALENDAR');
  });
});

describe('ask saved answers and feedback routes', () => {
  it('leaves /context/ask/history to its own route and 404s an unknown answer', async () => {
    expect((await send('GET', '/context/ask/history')).status).toBe(200);
    expect(history.getAnswer).not.toHaveBeenCalled();
    expect((await send('GET', `/context/ask/${ID}`)).status).toBe(404);
  });

  it('records feedback', async () => {
    const res = await send('POST', `/context/ask/${ID}/feedback`, { wrong: true, note: 'wrong fee' });
    expect(res.status).toBe(200);
    expect(history.answerFeedback).toHaveBeenCalledWith(USER, ID, { wrong: true, note: 'wrong fee' });
    expect((await send('POST', `/context/ask/${ID}/feedback`, { note: 5 })).status).toBe(400);
  });
});
