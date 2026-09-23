// Admin runtime API: tier models, effort, lanes, probe, budgets; catalog with capabilities; usage.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

const db = { system: {}, usage: { daily: [], features: [] }, calls: [] };
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    db.calls.push({ sql, params });
    if (/FROM system_settings/.test(sql)) return { rows: Object.keys(db.system).length ? [{ value: db.system }] : [] };
    if (/INSERT INTO system_settings/.test(sql)) { db.system = JSON.parse(params[0]); return { rows: [] }; }
    if (/to_char\(date_trunc\('day'/.test(sql)) return { rows: db.usage.daily };
    if (/FROM hedwig_ai_calls WHERE/.test(sql)) return { rows: db.usage.features };
    return { rows: [] };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';
const gw = mockGateway({ catalog: [
  { id: GEMMA, display_name: 'Gemma 4 12B QAT', node: 'atlas-vllm', capabilities: ['chat', 'completions', 'reasoning', 'streaming'], context_window: 131072, max_output_tokens: 32768, reasoning_efforts: ['none', 'high'], status: 'ready' },
  { id: QWEN, display_name: 'Qwen 3.8 Flash Next', node: 'dgx-spark', capabilities: ['chat', 'tools', 'reasoning', 'streaming'], context_window: 262144, max_output_tokens: 65536, reasoning_efforts: ['off', 'low', 'medium', 'xhigh'], default_reasoning_effort: 'medium', status: 'ready' },
  { id: 'bge-m3', capabilities: ['embeddings'], context_window: 8192, reasoning_efforts: [], status: 'ready' },
] });
// Saved and put back after the file, so a worker reused with .env.hedwig-dev keeps its dead URLs.
const ENV_KEYS = ['HEDWIG_LLM_BASE_URL', 'HEDWIG_LLM_CATALOG_URL', 'HEDWIG_LLM_FALLBACK_MODEL', 'HEDWIG_LLM_PROBE_ENABLED'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;
process.env.HEDWIG_LLM_FALLBACK_MODEL = GEMMA;
process.env.HEDWIG_LLM_PROBE_ENABLED = 'false';
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const { runtimePatch, runtimeSettings, updateRuntime, catalogView, usageReport } = await import('./admin.js');
const { runtimeAdminRoutes } = await import('./routes.js');
const { invalidateConfigCache } = await import('../config.js');
const { _resetLlmState, getCatalog } = await import('../llm.js');

beforeEach(() => {
  db.system = {}; db.calls = []; db.usage = { daily: [], features: [] };
  invalidateConfigCache();
  _resetLlmState();
  gw.reset().install();
});
afterEach(() => gw.restore());

describe('GET /admin/runtime', () => {
  it('shows each tier by its PRD name with model, effort, what the catalog allows and what is sent', async () => {
    const s = await runtimeSettings();
    expect(s.tiers.reflex).toMatchObject({ label: 'Tier 1 Reflex', role: 'fast', modelKey: 'llm.models.fast', model: GEMMA, effort: 'off', efforts: ['off', 'high'], wireEffort: 'none', modelSource: 'default' });
    expect(s.tiers.reasoning).toMatchObject({ label: 'Tier 2 Reasoning', role: 'long', model: QWEN, effort: 'low', efforts: ['off', 'low', 'medium', 'xhigh'], wireEffort: 'low' });
    expect(s.tiers.agent).toMatchObject({ role: 'agent', model: QWEN });
    expect(s.fallback).toMatchObject({ model: GEMMA, modelSource: 'env', afterMs: { interactive: 8000, background: 45000 }, cooldownSec: 300 });
    expect(s.lanes).toEqual({
      interactive: { concurrency: 2, waitMs: 30000, fallbackAfterMs: 8000 },
      background: { concurrency: 1, waitMs: 1200000, fallbackAfterMs: 45000 },
    });
    expect(s.probe).toMatchObject({ enabled: false, everySec: 60, timeoutMs: 10000, recoverAfter: 2 });
    expect(s.budgets.sort).toMatchObject({ tokens: 2000000, tokensKey: 'llm.tokenBudget.sort' });
    expect(s.budgets.ask).toMatchObject({ tokensKey: 'llm.tokenBudget.ask', callsKey: 'llm.dailyBudget.ask' });
    expect(s.status.reasoning).toMatchObject({ label: 'Tier 2 Reasoning', model: QWEN, fallback: GEMMA });
  });
});

describe('PUT /admin/runtime', () => {
  it('maps tier models, effort, lanes, probe, fallback and budgets onto config keys', async () => {
    const catalog = await getCatalog();
    const { patch, notes } = runtimePatch({
      models: { reflex: GEMMA, long: QWEN, fallback: '' },
      effort: { fast: 'low', reasoning: 'medium' },
      lanes: { interactive: { concurrency: 3, fallbackAfterMs: 5000 }, background: { fallbackAfterMs: 60000, waitMs: null } },
      fallback: { cooldownSec: 120 },
      probe: { everySec: 30, enabled: true },
      budgets: { sort: { tokens: 12345.6 }, ask: { calls: 50, tokens: null } },
      enabledModels: [QWEN],
    }, { catalog, cfg: { 'llm.offSpelling': 'none' } });
    expect(patch).toEqual({
      'llm.models.fast': GEMMA, 'llm.models.long': QWEN, 'llm.fallbackModel': '',
      'llm.reasoning.fast': 'low', 'llm.reasoning.long': 'medium',
      'llm.lanes.interactive.concurrency': 3, 'llm.lanes.interactive.fallbackAfterMs': 5000, 'llm.fallbackAfterMs': 60000, 'llm.lanes.background.waitMs': null,
      'llm.fallbackCooldownSec': 120, 'llm.probe.everySec': 30, 'llm.probe.enabled': true,
      'llm.tokenBudget.sort': 12346, 'llm.dailyBudget.ask': 50, 'llm.tokenBudget.ask': null,
      'llm.models.enabled': [QWEN],
    });
    // Gemma only does none/high: the admin is told what "low" becomes on the wire.
    expect(notes).toEqual([expect.stringMatching(/accepts none\/high; low is sent as none/)]);
  });

  it('refuses what the catalog does not support', async () => {
    const catalog = await getCatalog();
    const opts = { catalog, cfg: {} };
    expect(() => runtimePatch({ models: { fast: 'made/up' } }, opts)).toThrow(/not in the gateway catalog/);
    expect(() => runtimePatch({ models: { long: 'bge-m3' } }, opts)).toThrow(/not a chat model/);
    expect(() => runtimePatch({ models: { agent: GEMMA } }, opts)).toThrow(/does not support tool calling/);
    expect(() => runtimePatch({ effort: { long: 'max' } }, opts)).toThrow(/effort.long must be one of/);
    expect(() => runtimePatch({ lanes: { turbo: {} } }, opts)).toThrow(/unknown field turbo/);
    expect(() => runtimePatch({ budgets: { nope: { tokens: 1 } } }, opts)).toThrow(/unknown feature nope/);
    expect(() => runtimePatch({ budgets: { sort: { calls: 1 } } }, opts)).toThrow(/sort has no calls budget/);
    expect(() => runtimePatch({ enabledModels: ['x/y'] }, opts)).toThrow(/not in the gateway catalog: x\/y/);
    expect(() => runtimePatch({ routing: {} }, opts)).toThrow(/unknown field routing/);
  });

  it('saves to the admin layer and returns the new settings with what changed', async () => {
    const out = await updateRuntime({ models: { reasoning: QWEN }, effort: { long: 'xhigh' }, lanes: { background: { concurrency: 2 } } });
    expect(db.system).toEqual({ 'llm.models.long': QWEN, 'llm.reasoning.long': 'xhigh', 'llm.lanes.background.concurrency': 2 });
    expect(out.changed).toEqual(['llm.models.long', 'llm.reasoning.long', 'llm.lanes.background.concurrency']);
    expect(out.tiers.reasoning).toMatchObject({ effort: 'xhigh', effortSource: 'admin', wireEffort: 'xhigh' });
    expect(out.lanes.background.concurrency).toBe(2);
  });
});

describe('GET /admin/models/catalog', () => {
  it('lists gateway models with capabilities, the tiers they serve and their health', async () => {
    const { models } = await catalogView();
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId[GEMMA]).toMatchObject({ displayName: 'Gemma 4 12B QAT', node: 'atlas-vllm', chat: true, tools: false, streaming: true, reasoningEfforts: ['off', 'high'], maxOutputTokens: 32768, roles: ['fast'], tiers: ['reflex'], fallback: true, enabled: false });
    expect(byId[QWEN]).toMatchObject({ tools: true, contextWindow: 262144, defaultReasoningEffort: 'medium', roles: ['long', 'agent'], tiers: ['reasoning', 'agent'], health: { degraded: false } });
    expect(byId['bge-m3']).toMatchObject({ chat: false, embeddings: true, roles: [] });
    // Also a superset of the raw GET /admin/catalog entry, for clients written against that.
    expect(byId[QWEN]).toMatchObject({ display_name: 'Qwen 3.8 Flash Next', reasoning_efforts: ['off', 'low', 'medium', 'xhigh'], max_output_tokens: 65536, capabilities: expect.arrayContaining(['tools']) });
  });
});

describe('GET /admin/usage', () => {
  it('reports calls, tokens, latency, fallback and escalation per feature per tier per day', async () => {
    db.usage.daily = [{ day: '2026-09-23', feature: 'labels', tier: 'reasoning', model: GEMMA, calls: 63, errors: 0, fell_back: 63, escalated: 0, tokens_in: '1000', tokens_out: '200', avg_latency_ms: 3000, p95_latency_ms: 9000 }];
    db.usage.features = [
      { feature: 'labels', tier: 'reasoning', calls: 67, errors: 4, fell_back: 63, escalated: 0, tokens: '1200', avg_latency_ms: 5000, p95_latency_ms: 45000 },
      { feature: 'sort', tier: 'reflex', calls: 10, errors: 0, fell_back: 0, escalated: 1, tokens: '500', avg_latency_ms: 2000, p95_latency_ms: 4000 },
      { feature: 'summary', tier: 'unknown', calls: 3, errors: 0, fell_back: 0, escalated: 0, tokens: '10', avg_latency_ms: 100, p95_latency_ms: 100 },
    ];
    const out = await usageReport({ days: '14', userId: 'not-a-uuid' });
    expect(out.days).toBe(14);
    expect(out.userId).toBeNull();
    expect(db.calls.at(-1).params).toEqual([14, null]);
    expect(out.daily[0]).toMatchObject({ day: '2026-09-23', feature: 'labels', tier: 'reasoning', model: GEMMA, calls: 63, fellBack: 63, tokensIn: 1000, tokensOut: 200, p95LatencyMs: 9000 });
    expect(out.features[0]).toMatchObject({ feature: 'labels', tier: 'reasoning', errorRate: 0.06, fallbackRate: 0.94, escalationRate: 0 });
    expect(out.features[1]).toMatchObject({ feature: 'sort', escalationRate: 0.1 });
    expect(out.tiers).toEqual({
      reasoning: { calls: 67, errors: 4, fellBack: 63, tokens: 1200 },
      reflex: { calls: 10, errors: 0, fellBack: 0, tokens: 500 },
      unknown: { calls: 3, errors: 0, fellBack: 0, tokens: 10 },
    });
    expect(out.escalation).toEqual({ escalated: 1, calls: 80, rate: 0.013 });
  });
});

describe('routes', () => {
  it('mounts tiers, probe, runtime, catalog and usage under the admin router', async () => {
    const seen = [];
    const r = { get: (p) => seen.push(`GET ${p}`), post: (p) => seen.push(`POST ${p}`), put: (p) => seen.push(`PUT ${p}`) };
    runtimeAdminRoutes(r);
    expect(seen).toEqual(expect.arrayContaining(['GET /tiers', 'POST /tiers/probe', 'GET /runtime', 'PUT /runtime', 'GET /models/catalog', 'GET /usage']));
  });
});
