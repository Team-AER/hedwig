import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [{ n: 0 }] })), pool: {} }));
// Model health is shared through Redis; a unit test must not read or write the dev Redis (HEDWIG_IT runs).
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
const cfg = {
  enabled: true, 'llm.baseUrl': 'http://gw/v1', 'llm.apiKey': '', 'llm.catalogUrl': '',
  'llm.models.fast': 'primary-model', 'llm.models.long': 'primary-model', 'llm.models.agent': 'primary-model',
  'llm.reasoning.fast': 'off', 'llm.reasoning.long': 'low', 'llm.reasoning.agent': 'low', 'llm.offSpelling': 'none',
  'llm.timeoutMs': 5000, 'llm.concurrency': 2, 'llm.fallbackModel': 'fallback-model', 'llm.fallbackAfterMs': 50,
  'llm.fallbackCooldownSec': 60, 'llm.dailyBudget.triage': 1000,
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) }));

const { chat, chatStream, activeModels, _resetLlmState } = await import('./llm.js');

// Budgeted features (triage here) must name the user they charge.
const USER = '11111111-1111-4111-8111-111111111111';

const okBody = (model) => JSON.stringify({ choices: [{ message: { content: `hi from ${model}` }, finish_reason: 'stop' }], usage: {} });

/** fetch mock: the primary hangs (until aborted), the fallback answers at once. /models for the catalog. */
function makeFetch({ primary = 'hang' } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === 'primary-model') {
      if (primary === 'ok') return new Response(okBody(body.model), { status: 200 });
      if (primary === '500') return new Response('boom', { status: 500 });
      if (primary === '400') return new Response('bad request', { status: 400 });
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    if (body.stream) {
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'streamed' } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200 });
    }
    return new Response(okBody(body.model), { status: 200 });
  });
  return { fn, calls };
}

describe('llm fallback', () => {
  beforeEach(() => _resetLlmState());

  it('uses the primary when it answers', async () => {
    const { fn, calls } = makeFetch({ primary: 'ok' });
    const out = await chat({ userId: USER, feature: 'triage', messages: [], fetchFn: fn });
    expect(out.model).toBe('primary-model');
    expect(out.fellBack).toBe(false);
    expect(calls).toEqual(['primary-model']);
  });

  it('falls back when the primary does not respond in time, then skips it during the cooldown', async () => {
    const { fn, calls } = makeFetch();
    const first = await chat({ userId: USER, feature: 'triage', messages: [], fetchFn: fn });
    expect(first.model).toBe('fallback-model');
    expect(first.fellBack).toBe(true);
    const second = await chat({ userId: USER, feature: 'triage', messages: [], fetchFn: fn });
    expect(second.model).toBe('fallback-model');
    expect(calls).toEqual(['primary-model', 'fallback-model', 'fallback-model']);
    const models = await activeModels();
    expect(models.fast).toMatchObject({ primary: 'primary-model', active: 'fallback-model', degraded: true });
  });

  it('falls back on a 5xx but not on a 4xx', async () => {
    const five = makeFetch({ primary: '500' });
    expect((await chat({ userId: USER, feature: 'triage', messages: [], fetchFn: five.fn })).model).toBe('fallback-model');
    _resetLlmState();
    const four = makeFetch({ primary: '400' });
    await expect(chat({ userId: USER, feature: 'triage', messages: [], fetchFn: four.fn })).rejects.toThrow(/400/);
    expect(four.calls).toEqual(['primary-model']);
  });

  it('streams from the fallback when the primary never sends headers', async () => {
    const { fn } = makeFetch();
    const events = [];
    for await (const e of chatStream({ feature: 'ask', role: 'long', messages: [], fetchFn: fn })) events.push(e);
    expect(events[0]).toEqual({ type: 'delta', text: 'streamed' });
    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'fallback-model', fellBack: true });
  });
});
