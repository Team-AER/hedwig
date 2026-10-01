import { describe, it, expect, vi, beforeEach } from 'vitest';

// max_tokens with reasoning on: the trace counts against it, so the answer needs headroom on top.
vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [{ n: 0 }] })), pool: {} }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
const cfg = {
  enabled: true, 'llm.baseUrl': 'http://gw/v1', 'llm.apiKey': '', 'llm.catalogUrl': '',
  'llm.models.fast': 'fast-model', 'llm.models.long': 'long-model', 'llm.models.agent': 'long-model',
  'llm.reasoning.fast': 'off', 'llm.reasoning.long': 'low', 'llm.reasoning.agent': 'low', 'llm.offSpelling': 'none',
  'llm.reasoningHeadroomTokens': 2048, 'llm.timeoutMs': 5000, 'llm.concurrency': 2, 'llm.fallbackModel': '',
  'llm.fallbackAfterMs': 5000, 'llm.fallbackCooldownSec': 60,
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) }));

const { chat, outputBudget, _resetLlmState } = await import('./llm.js');

function capture() {
  const bodies = [];
  const fn = vi.fn(async (url, init = {}) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"ok"}' }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
  });
  return { fn, bodies };
}

describe('output budget', () => {
  beforeEach(() => _resetLlmState());

  it('adds the headroom only while the model reasons', () => {
    expect(outputBudget(500, 'low', { headroom: 2048 })).toBe(2548);
    expect(outputBudget(500, 'high', { headroom: 2048 })).toBe(2548);
    expect(outputBudget(500, 'none', { headroom: 2048 })).toBe(500);
    expect(outputBudget(500, 'off', { headroom: 2048, offSpelling: 'off' })).toBe(500);
    expect(outputBudget(500, undefined, { headroom: 2048 })).toBe(500);
    expect(outputBudget(500, 'low', { headroom: 0 })).toBe(500);
    expect(outputBudget(undefined, 'low', { headroom: 2048 })).toBeUndefined();
  });

  it('a Tier 2 summary capped at 500 goes out with room to reason; a Reflex call keeps its cap', async () => {
    const { fn, bodies } = capture();
    await chat({ feature: 'summary', role: 'long', maxTokens: 500, messages: [{ role: 'user', content: 'x' }], fetchFn: fn });
    await chat({ feature: 'summary', role: 'fast', maxTokens: 500, messages: [{ role: 'user', content: 'x' }], fetchFn: fn });
    expect(bodies.map((b) => [b.model, b.reasoning_effort, b.max_tokens])).toEqual([
      ['long-model', 'low', 2548],
      ['fast-model', 'none', 500],
    ]);
  });
});
