import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));

const { resolveField, coerce, envNameFor, SCHEMA } = await import('./config.js');
const { clampEffort, extractJson } = await import('./llm.js');
const { hashEmbed, cosine, toVectorLiteral, fromVectorLiteral } = await import('./embeddings.js');
const { stripQuoted, messageText, addressesOf } = await import('./text.js');

describe('config', () => {
  it('maps keys to env names', () => {
    expect(envNameFor('llm.baseUrl')).toBe('HEDWIG_LLM_BASE_URL');
    expect(envNameFor('llm.dailyBudget.triage')).toBe('HEDWIG_LLM_DAILY_BUDGET_TRIAGE');
  });
  it('layers user over admin over env over default, honouring scope', () => {
    const f = SCHEMA.find((x) => x.key === 'triage.needsYouThreshold');
    expect(resolveField(f, { env: {} })).toBe(0.5);
    expect(resolveField(f, { env: { HEDWIG_TRIAGE_NEEDS_YOU_THRESHOLD: '0.7' } })).toBe(0.7);
    expect(resolveField(f, { system: { 'triage.needsYouThreshold': 0.6 }, env: { HEDWIG_TRIAGE_NEEDS_YOU_THRESHOLD: '0.7' } })).toBe(0.6);
    expect(resolveField(f, { user: { 'triage.needsYouThreshold': 0.4 }, system: { 'triage.needsYouThreshold': 0.6 } })).toBe(0.4);
    const sys = SCHEMA.find((x) => x.key === 'llm.baseUrl');
    expect(resolveField(sys, { user: { 'llm.baseUrl': 'http://evil' }, env: {} })).toBe('http://llm-proxy.cls/v1');
  });
  it('clamps numbers and rejects bad enums', () => {
    const n = SCHEMA.find((x) => x.key === 'agent.maxSteps');
    expect(coerce(n, '999')).toBe(40);
    const e = SCHEMA.find((x) => x.key === 'llm.reasoning.fast');
    expect(coerce(e, 'bogus')).toBeUndefined();
  });
});

describe('llm helpers', () => {
  const flash = { id: 'Qwen/Qwen3.8-Flash-Next', capabilities: ['chat', 'reasoning'], reasoning_efforts: ['off', 'low', 'medium', 'xhigh'] };
  it('maps off to the wire spelling', () => {
    expect(clampEffort('off', flash, 'none')).toBe('none');
  });
  it('clamps an unadvertised level to the nearest advertised one', () => {
    expect(clampEffort('high', flash, 'none')).toBe('medium');
    expect(clampEffort('low', flash, 'none')).toBe('low');
  });
  it('omits effort for non-reasoning models', () => {
    expect(clampEffort('low', { id: 'x', capabilities: ['chat'] })).toBeUndefined();
  });
  it('extracts JSON from fenced or chatty output', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a": {"b": "}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(extractJson('nothing')).toBeNull();
  });
});

describe('embeddings', () => {
  it('hash embeddings are normalised and similar for similar text', () => {
    const a = hashEmbed('visa sponsorship documents payslips', 256);
    const b = hashEmbed('sponsorship visa payslips and documents', 256);
    const c = hashEmbed('boiler inspection engineer thursday', 256);
    expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThan(1e-6);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
  it('round-trips pgvector literals', () => {
    expect(fromVectorLiteral(toVectorLiteral([0.5, -0.25]))).toEqual([0.5, -0.25]);
  });
  it('embedding errors carry the HTTP status and Retry-After (so the index can tell bad input from an outage)', async () => {
    const { embed, EmbeddingError } = await import('./embeddings.js');
    const { invalidateConfigCache } = await import('./config.js');
    const saved = { provider: process.env.HEDWIG_EMBEDDINGS_PROVIDER, url: process.env.HEDWIG_EMBEDDINGS_BASE_URL };
    process.env.HEDWIG_EMBEDDINGS_PROVIDER = 'openai';
    process.env.HEDWIG_EMBEDDINGS_BASE_URL = 'http://embed.test/v1';
    invalidateConfigCache();
    try {
      const rateLimited = embed(['x'], { fetchFn: async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '42' } }) });
      await expect(rateLimited).rejects.toBeInstanceOf(EmbeddingError);
      await expect(rateLimited).rejects.toMatchObject({ status: 429, retryAfterSec: 42 });
      await expect(embed(['x'], { fetchFn: async () => new Response('too long', { status: 400 }) })).rejects.toMatchObject({ status: 400 });
      const down = await embed(['x'], { fetchFn: async () => { throw new Error('ECONNREFUSED'); } }).catch((e) => e);
      expect(down).toBeInstanceOf(EmbeddingError);
      expect(down.status).toBeUndefined();
    } finally {
      for (const [k, v] of [['HEDWIG_EMBEDDINGS_PROVIDER', saved.provider], ['HEDWIG_EMBEDDINGS_BASE_URL', saved.url]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      invalidateConfigCache();
    }
  });
});

describe('text', () => {
  it('strips quoted replies', () => {
    const t = 'Thanks, Thursday works for me and I will be in all morning.\n\nOn Tue, 3 Sep 2026 at 10:00, Sam <s@x> wrote:\n> Is someone going to be in?';
    expect(stripQuoted(t)).toBe('Thanks, Thursday works for me and I will be in all morning.');
  });
  it('falls back from body_text to html to snippet', () => {
    expect(messageText({ body_html: '<p>Hello <b>there</b></p><script>x</script>' })).toBe('Hello there');
    expect(messageText({ snippet: 'just a snippet' })).toBe('just a snippet');
  });
  it('normalises address lists', () => {
    expect(addressesOf([{ address: 'A@B.com', name: 'A' }, 'c@d.com', { name: 'x' }])).toEqual([{ email: 'a@b.com', name: 'A' }, { email: 'c@d.com', name: null }]);
  });
});
