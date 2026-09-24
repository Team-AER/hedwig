// Model health: the probe marks a slow Tier 2 degraded so calls skip straight to the fallback,
// traffic returns on its own, and every output says which tier and model answered.
// Mock gateway only; never the live one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockGateway } from './testing/mockGateway.js';

const db = { calls: [], nextId: 1 };
vi.mock('../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    db.calls.push({ sql, params });
    if (/INSERT INTO hedwig_ai_calls/.test(sql)) return { rows: [{ id: db.nextId++ }] };
    if (/FROM hedwig_ai_calls/.test(sql)) return { rows: [{ n: 0, tokens: 0 }] };
    return { rows: [] };
  }),
}));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';
const USER = '11111111-1111-4111-8111-111111111111';
const gw = mockGateway();
const base = {
  enabled: true, 'llm.baseUrl': gw.baseUrl, 'llm.apiKey': '', 'llm.catalogUrl': gw.catalogUrl,
  'llm.models.fast': GEMMA, 'llm.models.long': QWEN, 'llm.models.agent': QWEN, 'llm.models.enabled': [],
  'llm.reasoning.fast': 'off', 'llm.reasoning.long': 'low', 'llm.reasoning.agent': 'low', 'llm.offSpelling': 'none',
  'llm.timeoutMs': 5000, 'llm.concurrency': 4, 'llm.fallbackModel': GEMMA, 'llm.fallbackAfterMs': 400, 'llm.fallbackCooldownSec': 300,
  'llm.lanes.interactive.concurrency': 4, 'llm.lanes.background.concurrency': 4, 'llm.lanes.interactive.fallbackAfterMs': 150,
  'llm.lanes.leaseSec': 300, 'llm.defaultMaxOutputTokens': 8192, 'llm.keepTranscripts': false, 'llm.transcriptDays': 14,
  'llm.probe.enabled': true, 'llm.probe.everySec': 60, 'llm.probe.timeoutMs': 100, 'llm.probe.degradeAfter': 1, 'llm.probe.recoverAfter': 2,
  'llm.stream.firstToken': true, 'llm.tokenBudget.sort': 1_000_000, 'llm.tokenBudget.labels': 1_000_000,
};
let cfg = { ...base };
vi.mock('./config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) }));

const llm = await import('./llm.js');
const { chat, chatStream, probeModels, tierStatus, activeModels, primaryDegraded, _resetLlmState } = llm;
const { definePrompt, runPrompt, _resetPrompts } = await import('./prompts/index.js');
const { _resetLanes, setLaneRedis } = await import('./prompts/lanes.js');
const { resolveInline, callerFiles } = await import('./prompts/inline.js');

definePrompt({
  id: 'test.quick', version: '1', tier: 'reflex', feature: 'sort',
  system: 'Quick.', user: 'Q: {{q}}',
  schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
  maxTokens: 200,
});

definePrompt({
  id: 'test.think', version: '1', tier: 'reasoning', feature: 'labels',
  system: 'Think.', user: 'Q: {{q}}',
  schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
  maxTokens: 200,
});

/** A fake Redis with get/set/mGet for the shared health records. */
function fakeRedis() {
  const kv = new Map();
  return {
    isReady: true, kv,
    async set(k, v) { kv.set(k, v); return 'OK'; },
    async mGet(keys) { return keys.map((k) => kv.get(k) ?? null); },
    async eval() { return 1; },
    async zRem() { return 1; },
  };
}

const ask = (opts = {}) => chat({ userId: USER, feature: 'labels', role: 'long', lane: 'background', messages: [{ role: 'user', content: 'q' }], workflow: 'test.work', ...opts });
const modelsCalled = (wf = 'test.work') => gw.callsFor(wf).map((c) => c.model);
const settle = () => new Promise((r) => setTimeout(r, 20));
// The probe backs off from a degraded model and skips one probed moments ago; tests move the clock.
let skew = 0;
const realNow = Date.now.bind(Date);
const later = (sec) => { skew += sec * 1000; };

beforeEach(() => {
  cfg = { ...base };
  db.calls = []; db.nextId = 1;
  gw.reset().install();
  _resetLlmState();
  _resetLanes();
  _resetPrompts({ keepFiles: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  skew = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
});
afterEach(() => { gw.restore(); vi.restoreAllMocks(); });

describe('model probe', () => {
  it('marks a model that does not answer the probe degraded, and its calls then skip straight to the fallback', async () => {
    gw.health(QWEN, 'hang');
    const out = await probeModels();
    expect(out.models.find((m) => m.model === QWEN)).toMatchObject({ ok: false, degraded: true, error: 'no answer within 100 ms' });
    expect(out.models.find((m) => m.model === GEMMA)).toMatchObject({ ok: true, degraded: false });
    expect(gw.callsFor('runtime.probe').every((c) => c.body.max_tokens === 1 && c.sessionId === 'hedwig')).toBe(true);
    // Qwen advertises off/low/medium/xhigh: the probe asks for no reasoning, spelled for the wire.
    expect(gw.callsFor('runtime.probe').find((c) => c.model === QWEN).body.reasoning_effort).toBe('none');

    gw.on('test.work', 'fine');
    const started = Date.now();
    const res = await ask();
    expect(Date.now() - started).toBeLessThan(300); // no 400 ms first-token wait paid
    expect(modelsCalled()).toEqual([GEMMA]);
    expect(res).toMatchObject({ model: GEMMA, fellBack: true, tier: 'reasoning', servedTier: 'reflex', lighterModel: true });
    const insert = db.calls.find((c) => /INSERT INTO hedwig_ai_calls/.test(c.sql));
    expect(insert.params.slice(19)).toEqual([true, false]); // fell_back, escalated
  });

  it('returns traffic to the primary after llm.probe.recoverAfter answered probes in a row', async () => {
    gw.health(QWEN, 'hang');
    await probeModels();
    expect(primaryDegraded(QWEN)).toBe(true);
    gw.health(QWEN, 'ok');
    later(301); // past llm.probe.degradedEverySec
    await probeModels();
    expect(primaryDegraded(QWEN)).toBe(true); // one good probe is not enough
    later(61); // it answered, so the next probe comes at the normal pace
    await probeModels();
    expect(primaryDegraded(QWEN)).toBe(false);
    gw.on('test.work', 'back');
    const res = await ask();
    expect(res).toMatchObject({ model: QWEN, fellBack: false, lighterModel: false });
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/answers again/));
  });

  it('still probes a model the catalog calls offline, and an answer wins over the catalog', async () => {
    // 2026-09-24: the catalog listed Gemma offline during a reload while it answered in 200 ms,
    // and Tier 1 fell back to rules. The catalog is a hint; the probe is the verdict.
    const offline = mockGateway({ catalog: [
      { id: GEMMA, capabilities: ['chat', 'streaming'], max_output_tokens: 4096, reasoning_efforts: ['none', 'high'], status: 'ready' },
      { id: QWEN, capabilities: ['chat', 'tools', 'streaming'], max_output_tokens: 32768, reasoning_efforts: ['off', 'low'], status: 'offline' },
    ] });
    gw.restore(); offline.install();
    try {
      const out = await probeModels();
      expect(out.models.find((m) => m.model === QWEN)).toMatchObject({ ok: true, degraded: false });
      expect(offline.callsFor('runtime.probe').map((c) => c.model).sort()).toEqual([GEMMA, QWEN].sort());
      // When it does not answer, the catalog's word labels the failure.
      offline.on('runtime.probe', (req) => (req.model === QWEN ? offline.hang() : 'ok'));
      later(301);
      const again = await probeModels();
      expect(again.models.find((m) => m.model === QWEN)).toMatchObject({ ok: false, error: expect.stringMatching(/catalog lists it as offline/) });
    } finally { offline.restore(); gw.install(); }
  });

  it('a timed-out call marks the primary degraded for the cooldown; a good probe run clears it early', async () => {
    gw.on('test.work', (req) => (req.model === QWEN ? gw.hang() : 'from gemma'));
    const first = await ask();
    expect(first.model).toBe(GEMMA);
    expect(modelsCalled()).toEqual([QWEN, GEMMA]);
    await ask();
    expect(modelsCalled()).toEqual([QWEN, GEMMA, GEMMA]); // cooldown: no second wait
    expect(gw.callsFor('runtime.probe').map((c) => c.model).sort()).toEqual([GEMMA, QWEN].sort()); // the first call waited for a first verdict
    later(301); await probeModels(); later(61); await probeModels();
    expect(primaryDegraded(QWEN)).toBe(false);
  });

  it('backs off from a degraded model: probed every llm.probe.degradedEverySec, not every minute', async () => {
    cfg['llm.probe.degradedEverySec'] = 300;
    gw.health(QWEN, 'hang');
    await probeModels();
    const probes = (m) => gw.callsFor('runtime.probe').filter((c) => c.model === m).length;
    expect([probes(QWEN), probes(GEMMA)]).toEqual([1, 1]);
    // The next scheduled runs: Gemma is probed every minute, the degraded Qwen is left alone.
    for (let i = 0; i < 4; i++) {
      later(60);
      const out = await probeModels();
      expect(out.models.find((m) => m.model === QWEN)).toMatchObject({ skipped: 'backoff', degraded: true });
    }
    expect([probes(QWEN), probes(GEMMA)]).toEqual([1, 5]);
    later(60); // 300 s since Qwen's last probe
    await probeModels();
    expect([probes(QWEN), probes(GEMMA)]).toEqual([2, 6]);
    expect(primaryDegraded(QWEN)).toBe(true);
    // The admin's "probe now" is not held back.
    await probeModels({ force: true });
    expect(probes(QWEN)).toBe(3);
  });

  it('skips a model another process (or run) probed moments ago, so /status reads do not add probes', async () => {
    const redis = fakeRedis();
    setLaneRedis(redis);
    await probeModels();
    await settle();
    expect(gw.callsFor('runtime.probe')).toHaveLength(2);
    _resetLlmState(); // "the API process": no local state, the worker's verdicts in Redis
    setLaneRedis(redis);
    later(10);
    const out = await probeModels();
    expect(out.models.every((m) => m.skipped === 'recent')).toBe(true);
    await tierStatus(USER);
    await settle();
    expect(gw.callsFor('runtime.probe')).toHaveLength(2);
  });

  it('shares verdicts through Redis so another process skips the degraded model too', async () => {
    const redis = fakeRedis();
    setLaneRedis(redis);
    gw.health(QWEN, 'hang');
    await probeModels();
    await settle();
    expect(JSON.parse(redis.kv.get(`hedwig:model-health:${QWEN}`))).toMatchObject({ degraded: true, source: 'probe' });
    _resetLlmState(); // "another process": no local verdict
    setLaneRedis(redis);
    expect((await activeModels()).long).toMatchObject({ primary: QWEN, active: GEMMA, degraded: true });
  });
});

describe('tierStatus', () => {
  it('names the tiers as the PRD does and says when Tier 2 is on the lighter model', async () => {
    let s = await tierStatus(USER);
    expect(s.reflex).toMatchObject({ tier: 'reflex', label: 'Tier 1 Reflex', role: 'fast', model: GEMMA, active: GEMMA, degraded: false, fallback: null });
    expect(s.reasoning).toMatchObject({ tier: 'reasoning', label: 'Tier 2 Reasoning', role: 'long', model: QWEN, active: QWEN, degraded: false, lighterModel: false, fallback: GEMMA });
    expect(s.notice).toBeNull();
    await settle(); // the stale-state probe it kicked off
    gw.health(QWEN, 'hang');
    later(61);
    await probeModels();
    s = await tierStatus(USER);
    expect(s.reasoning).toMatchObject({ active: GEMMA, degraded: true, lighterModel: true, reason: 'no answer within 100 ms', source: 'probe' });
    expect(s.agent).toMatchObject({ role: 'agent', active: GEMMA, degraded: true });
    expect(s.notice).toMatchObject({ level: 'warning', tier: 'reasoning', text: 'Tier 2 is slow; using the lighter model' });
    expect(s.probe).toMatchObject({ enabled: true, everySec: 60, timeoutMs: 100 });
  });

  it('probes on its own when nothing has probed recently', async () => {
    await tierStatus(USER);
    await settle();
    expect(gw.callsFor('runtime.probe').map((c) => c.model).sort()).toEqual([GEMMA, QWEN].sort());
  });
});

describe('runPrompt provenance', () => {
  it('annotates the tier asked, the model and tier that answered, and lighterModel', async () => {
    gw.on('test.think', { answer: '42' });
    let { provenance } = await runPrompt('test.think', { q: 'x' }, { userId: USER, lane: 'background' });
    expect(provenance).toMatchObject({ tier: 'reasoning', model: QWEN, servedTier: 'reasoning', fellBack: false, lighterModel: false });
    gw.health(QWEN, 'hang');
    later(61);
    await probeModels();
    ({ provenance } = await runPrompt('test.think', { q: 'x' }, { userId: USER, lane: 'background' }));
    expect(provenance).toMatchObject({ tier: 'reasoning', model: GEMMA, servedTier: 'reflex', fellBack: true, lighterModel: true });
  });

  it('allowLighter: false fails at once with tier_degraded instead of using the fallback', async () => {
    gw.health(QWEN, 'hang');
    await probeModels();
    gw.on('test.think', { answer: '42' });
    await expect(runPrompt('test.think', { q: 'x' }, { userId: USER, lane: 'background', allowLighter: false }))
      .rejects.toMatchObject({ code: 'tier_degraded', status: 503 });
    expect(gw.callsFor('test.think')).toHaveLength(0);
  });
});

describe('before the first probe', () => {
  it('a Tier 2 call waits for the first verdict instead of paying the first-token wait on a model that is down', async () => {
    gw.health(QWEN, 'hang');
    gw.on('test.work', 'from gemma');
    const started = Date.now();
    const res = await ask();
    expect(Date.now() - started).toBeLessThan(380); // the probe's 100 ms, not the 400 ms first-token wait
    expect(modelsCalled()).toEqual([GEMMA]); // Qwen never got the real request
    expect(res).toMatchObject({ model: GEMMA, lighterModel: true });
  });
});

describe('runPrompt retries while Tier 2 is degraded', () => {
  it('does not repeat a failed Reflex prompt on "Tier 2" when Gemma is what serves Tier 2', async () => {
    gw.health(QWEN, 'hang');
    await probeModels();
    gw.on('test.quick', { wrong: true });
    await expect(runPrompt('test.quick', { q: 'x' }, { userId: USER, lane: 'background' })).rejects.toMatchObject({ name: 'PromptOutputError' });
    expect(gw.callsFor('test.quick').map((c) => c.model)).toEqual([GEMMA, GEMMA]); // the try and the repair, no third
  });

  it('still tries the other tier when it is a different model', async () => {
    gw.on('test.quick', (req) => (req.model === QWEN ? { answer: 'from qwen' } : { wrong: true }));
    const { data, provenance } = await runPrompt('test.quick', { q: 'x' }, { userId: USER, lane: 'background' });
    expect(data).toEqual({ answer: 'from qwen' });
    expect(provenance).toMatchObject({ model: QWEN, escalated: true });
    expect(gw.callsFor('test.quick').map((c) => c.model)).toEqual([GEMMA, GEMMA, QWEN]);
  });

  it('allowLighter: false never ends on the other tier', async () => {
    gw.on('test.think', (req) => (req.model === QWEN ? { wrong: true } : { answer: 'gemma' }));
    await expect(runPrompt('test.think', { q: 'x' }, { userId: USER, lane: 'background', allowLighter: false })).rejects.toMatchObject({ name: 'PromptOutputError' });
    expect(gw.callsFor('test.think').map((c) => c.model)).toEqual([QWEN, QWEN]);
  });
});

describe('tool calls', () => {
  it('never fall back to a model without tool calling; a degraded agent model fails at once', async () => {
    const tools = [{ type: 'function', function: { name: 'search_mail', parameters: { type: 'object', properties: {} } } }];
    gw.health(QWEN, 'hang');
    await probeModels();
    const started = Date.now();
    await expect(chat({ userId: USER, feature: 'labels', role: 'agent', lane: 'interactive', tools, messages: [], workflow: 'test.work' }))
      .rejects.toMatchObject({ code: 'tier_degraded', message: expect.stringMatching(/cannot call tools/) });
    expect(Date.now() - started).toBeLessThan(100);
    expect(gw.callsFor('test.work')).toHaveLength(0);
  });
});

describe('first-token waits per lane', () => {
  it('interactive calls fall back after the interactive wait, background calls after the longer one', async () => {
    gw.on('test.work', (req) => (req.model === QWEN ? gw.hang() : 'ok'));
    let t = Date.now();
    await ask({ lane: 'interactive' });
    const interactive = Date.now() - t;
    _resetLlmState();
    t = Date.now();
    await ask({ lane: 'background' });
    const background = Date.now() - t;
    expect(interactive).toBeGreaterThanOrEqual(140);
    expect(interactive).toBeLessThan(380);
    expect(background).toBeGreaterThanOrEqual(390);
  });

  it('streams internally so a slow but working answer is not cut off at the wait', async () => {
    // First token after 50 ms, whole answer after 600 ms: longer than the 400 ms wait.
    gw.on('test.work', (req) => (req.model === QWEN ? gw.delay(600, 'the long answer', { firstChunkMs: 50, totalMs: 600 }) : 'lighter'));
    const res = await ask();
    expect(res).toMatchObject({ model: QWEN, content: 'the long answer', fellBack: false });
    expect(gw.callsFor('test.work')[0].stream).toBe(true);
  });

  it('with llm.stream.firstToken off the wait bounds the whole answer (the old behaviour)', async () => {
    cfg['llm.stream.firstToken'] = false;
    gw.on('test.work', (req) => (req.model === QWEN ? gw.delay(600, 'the long answer') : 'lighter'));
    const res = await ask();
    expect(res).toMatchObject({ model: GEMMA, content: 'lighter', fellBack: true });
  });

  it('falls back when the server sends headers but no token (headers are not a first token)', async () => {
    gw.on('test.work', (req) => (req.model === QWEN ? gw.stall() : 'from the fallback'));
    const events = [];
    for await (const e of chatStream({ userId: USER, feature: 'labels', role: 'long', lane: 'interactive', messages: [], workflow: 'test.work' })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'done', model: GEMMA, fellBack: true, lighterModel: true });
    expect(events.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('from the fallback');
    const failed = db.calls.filter((c) => /INSERT INTO hedwig_ai_calls/.test(c.sql)).map((c) => c.params);
    expect(failed[0][9]).toMatch(/no first token within 150 ms/);
  });
});

describe('inline prompts (calls without a registered prompt)', () => {
  it('resolves upstream and module call sites from the stack, skipping llm.js and aiProvider.js', () => {
    const stack = [
      'Error',
      '    at captureStack (/app/src/hedwig/prompts/inline.js:40:12)',
      '    at chat (/app/src/hedwig/llm.js:740:17)',
      '    at hedwigComplete (/app/src/services/aiProvider.js:447:23)',
      '    at async completeText (/app/src/services/aiProvider.js:325:12)',
      '    at async summarizeMessage (/app/src/services/summarize.js:74:22)',
    ].join('\n');
    expect(callerFiles(stack)).toEqual(['/app/src/services/summarize.js']);
    expect(resolveInline({ feature: 'assistant', stack, messages: [{ role: 'user', content: 'x' }] }))
      .toMatchObject({ id: 'upstream.summarize', version: 'inline', tier: 'reflex', hash: null });
    const ctx = stack.replace('/app/src/services/summarize.js:74:22', 'file:///app/src/hedwig/context/extract.js:481:9');
    expect(resolveInline({ feature: 'extraction', stack: ctx, messages: [{ role: 'system', content: 'S' }] }))
      .toMatchObject({ id: 'context.extract', tier: null, hash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const plugin = stack.replace('/app/src/services/summarize.js:74:22', '/app/src/hedwig/pluginsv2/facade.js:133:9');
    expect(resolveInline({ feature: 'extraction', pluginId: 'p', stack: plugin }).id).toBe('plugin.extract');
    expect(resolveInline({ feature: 'summary', pluginId: 'p', stack: plugin }).id).toBe('plugin.summarize');
    expect(resolveInline({ feature: 'mystery' }).id).toBe('mystery.inline');
    expect(resolveInline({ feature: 'summary', workflow: 'context.summary' }).id).toBe('context.summary');
  });

  it('records prompt id, version, hash, tier and lane for them, and X-Workflow is the inline id', async () => {
    cfg['llm.fallbackModel'] = '';
    gw.on('insights.inline', 'brief');
    await chat({ userId: USER, feature: 'insights', role: 'long', lane: 'background', messages: [{ role: 'system', content: 'Write a brief.' }, { role: 'user', content: 'e' }] });
    const p = db.calls.find((c) => /INSERT INTO hedwig_ai_calls/.test(c.sql)).params;
    // prompt_id, prompt_version, prompt_hash, lane, tier, workflow
    expect(p.slice(10, 16)).toEqual(['insights.inline', 'inline', expect.stringMatching(/^[0-9a-f]{16}$/), 'background', 'reasoning', 'insights.inline']);
    expect(p[0]).toBe(USER);
  });

  it('routing.<feature>.tier moves an inline call to the other tier', async () => {
    cfg['llm.fallbackModel'] = '';
    cfg['routing.summary.tier'] = 'reflex';
    gw.on('context.summary', 'short');
    const res = await chat({ userId: USER, feature: 'summary', role: 'long', workflow: 'context.summary', messages: [{ role: 'user', content: 'x' }] });
    expect(res).toMatchObject({ model: GEMMA, tier: 'reflex' });
    cfg['routing.summary.tier'] = 'auto';
    await chat({ userId: USER, feature: 'summary', role: 'long', workflow: 'context.summary', messages: [{ role: 'user', content: 'x' }] });
    expect(gw.callsFor('context.summary').map((c) => c.model)).toEqual([GEMMA, QWEN]);
  });
});
