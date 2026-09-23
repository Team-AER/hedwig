import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

const db = { calls: [], usage: { n: 0, tokens: 0 }, nextId: 1 };
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    db.calls.push({ sql, params });
    if (/INSERT INTO hedwig_ai_calls/.test(sql)) return { rows: [{ id: db.nextId++ }] };
    if (/FROM hedwig_ai_calls/.test(sql)) return { rows: [db.usage] };
    return { rows: [] };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';
const USER = '11111111-1111-4111-8111-111111111111';
const gw = mockGateway();
const base = {
  enabled: true, 'llm.baseUrl': gw.baseUrl, 'llm.apiKey': '', 'llm.catalogUrl': gw.catalogUrl,
  'llm.models.fast': GEMMA, 'llm.models.long': QWEN, 'llm.models.agent': QWEN,
  'llm.reasoning.fast': 'off', 'llm.reasoning.long': 'low', 'llm.reasoning.agent': 'low', 'llm.offSpelling': 'none',
  'llm.timeoutMs': 5000, 'llm.concurrency': 4, 'llm.fallbackModel': '', 'llm.fallbackAfterMs': 45000, 'llm.fallbackCooldownSec': 60,
  'llm.lanes.interactive.concurrency': 2, 'llm.lanes.background.concurrency': 1, 'llm.lanes.interactive.fallbackAfterMs': 8000,
  'llm.lanes.leaseSec': 300, 'llm.defaultMaxOutputTokens': 8192, 'llm.keepTranscripts': false, 'llm.transcriptDays': 14,
  'llm.tokenBudget.sort': 1_000_000, 'llm.dailyBudget.triage': 1000,
};
let cfg = { ...base };
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) }));

const { definePrompt, runPrompt, listPrompts, PromptOutputError, _resetPrompts } = await import('./index.js');
const { chat, chatStream, _resetLlmState, stripThinking } = await import('../llm.js');
const { createThinkFilter } = await import('./think.js');
const { _resetLanes, setLaneRedis, acquireLane } = await import('./lanes.js');
const { runInContext } = await import('../ledger/context.js');

const itemSchema = {
  type: 'object',
  required: ['id', 'stream', 'confidence'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    stream: { type: 'string', enum: ['people', 'reading', 'records'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: ['string', 'null'], maxLength: 90 },
  },
};

definePrompt({
  id: 'test.single', version: '2026-09-23.1', tier: 'reflex',
  system: 'You sort mail.', user: (v) => `Message: ${v.subject}`,
  schema: { type: 'object', required: ['stream'], additionalProperties: false, properties: { stream: { type: 'string', enum: ['people', 'reading', 'records'] } } },
  maxTokens: 1500, temperature: 0, feature: 'sort',
});
definePrompt({
  id: 'test.batch', version: '2026-09-23.1', tier: 'reflex',
  system: 'You sort mail in batches.', user: 'Messages: {{list}}',
  schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: itemSchema } } },
  batch: { key: 'items', validateEach: itemSchema },
  maxTokens: 800, feature: 'sort',
});

const run = (id, vars = { subject: 'Hi' }, opts = {}) => runPrompt(id, vars, { userId: USER, lane: 'background', ...opts });

beforeEach(() => {
  cfg = { ...base };
  db.calls = []; db.usage = { n: 0, tokens: 0 }; db.nextId = 1;
  gw.reset().install();
  _resetLlmState();
  _resetLanes();
  _resetPrompts({ keepFiles: true });
});
afterEach(() => gw.restore());

describe('definePrompt', () => {
  it('is idempotent for identical content and refuses a different body under the same id', async () => {
    const spec = { id: 'test.dupe', version: '1', tier: 'reflex', system: 's', user: 'u', schema: { type: 'object' } };
    const a = definePrompt(spec);
    expect(definePrompt({ ...spec })).toBe(a);
    expect(() => definePrompt({ ...spec, system: 'changed' })).toThrow(/already defined/);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await listPrompts()).map((p) => p.id)).toEqual(expect.arrayContaining(['test.single', 'test.batch']));
  });
  it('validates the spec', () => {
    expect(() => definePrompt({ id: 'nodot', version: '1', tier: 'reflex', system: 's', user: 'u', schema: {} })).toThrow(/area.name/);
    expect(() => definePrompt({ id: 'a.b', version: '1', tier: 'fast', system: 's', user: 'u', schema: {} })).toThrow(/tier/);
  });
});

describe('runPrompt', () => {
  it('sends a strict json_schema request with provenance headers and returns data + provenance', async () => {
    gw.on('test.single', { stream: 'people' });
    const { data, provenance } = await run('test.single', { subject: 'Lunch?' });
    expect(data).toEqual({ stream: 'people' });
    expect(provenance).toMatchObject({
      aiCallId: 1, promptId: 'test.single', promptVersion: '2026-09-23.1', model: GEMMA, tier: 'reflex',
      fellBack: false, escalated: false, repaired: false, dropped: [],
    });
    expect(provenance.tokensIn).toBeGreaterThan(0);
    const [call] = gw.calls;
    expect(call.workflow).toBe('test.single');
    expect(call.sessionId).toBe('hedwig');
    expect(call.responseFormat).toMatchObject({ type: 'json_schema', json_schema: { name: 'test_single', strict: true } });
    expect(call.text).toContain('Message: Lunch?');
    const insert = db.calls.find((c) => /INSERT INTO hedwig_ai_calls/.test(c.sql));
    expect(insert.params.slice(10, 16)).toEqual(['test.single', '2026-09-23.1', provenance.promptHash, 'background', 'reflex', 'test.single']);
    expect(insert.params[17]).toBeNull(); // no transcript unless llm.keepTranscripts
  });

  it('retries once on the same model with the errors appended, then once on the other tier', async () => {
    gw.on('test.single', [{ stream: 'spam' }, { stream: 'nope' }, { stream: 'records' }]);
    const { data, provenance } = await run('test.single');
    expect(data).toEqual({ stream: 'records' });
    expect(gw.calls.map((c) => c.model)).toEqual([GEMMA, GEMMA, QWEN]);
    expect(gw.calls[1].text).toMatch(/did not match the required JSON schema: stream must be one of people, reading, records/);
    expect(gw.calls[1].messages.at(-2)).toMatchObject({ role: 'assistant', content: '{"stream":"spam"}' });
    expect(gw.calls[2].text).not.toMatch(/did not match/);
    expect(provenance).toMatchObject({ model: QWEN, tier: 'reasoning', repaired: true, escalated: true, aiCallId: 3, attempts: 3 });
  });

  it('throws PromptOutputError with provenance when every attempt is invalid', async () => {
    gw.on('test.single', 'not json at all');
    const err = await run('test.single').catch((e) => e);
    expect(err).toBeInstanceOf(PromptOutputError);
    expect(err.code).toBe('invalid_output');
    expect(err.provenance.attempts).toBe(3);
    expect(gw.calls).toHaveLength(3);
  });

  it('doubles max_tokens on finish_reason length up to the catalog cap', async () => {
    gw.on('test.single', [gw.truncated('{"str'), gw.truncated('{"stream": "peo'), { stream: 'people' }]);
    const { data } = await run('test.single');
    expect(data).toEqual({ stream: 'people' });
    expect(gw.calls.map((c) => c.maxTokens)).toEqual([1500, 3000, 4096]); // Gemma: 4,096 max output
  });

  it('treats output still truncated at the cap as invalid and moves down the retry chain', async () => {
    gw.on('test.single', (req) => (req.model === GEMMA ? gw.truncated('{"stream": "') : { stream: 'reading' }));
    const { data, provenance } = await run('test.single');
    expect(data).toEqual({ stream: 'reading' });
    expect(provenance.model).toBe(QWEN);
    const gemmaTokens = gw.calls.filter((c) => c.model === GEMMA).map((c) => c.maxTokens);
    expect(gemmaTokens).toEqual([1500, 3000, 4096, 1500, 3000, 4096]);
    expect(gw.calls.find((c) => /cut off at 4096 tokens/.test(c.text))).toBeTruthy();
  });

  it('escalate: true runs on the reasoning tier first', async () => {
    gw.on('test.single', { stream: 'people' });
    const { provenance } = await run('test.single', {}, { escalate: true });
    expect(gw.calls[0].model).toBe(QWEN);
    expect(provenance).toMatchObject({ tier: 'reasoning', escalated: true, repaired: false });
  });

  it('drops invalid batch entries and reports them', async () => {
    gw.on('test.batch', { items: [
      { id: 'a', stream: 'people', confidence: 0.9 },
      { id: 'b', stream: 'sideways', confidence: 0.5 },
      { id: 'c', stream: 'records', confidence: '0.7', extra: 'ignored' },
    ] });
    const { data, provenance } = await run('test.batch', { list: ['a', 'b', 'c'] });
    expect(data.items).toEqual([
      { id: 'a', stream: 'people', confidence: 0.9 },
      { id: 'c', stream: 'records', confidence: 0.7 },
    ]);
    expect(provenance.dropped).toHaveLength(1);
    expect(provenance.dropped[0]).toMatchObject({ index: 1, entry: { id: 'b' } });
    expect(provenance.dropped[0].errors[0]).toMatch(/stream must be one of/);
    expect(gw.calls[0].text).toContain('Messages: ["a","b","c"]');
  });

  it('retries a batch when every entry is invalid', async () => {
    gw.on('test.batch', [{ items: [{ id: 'a', stream: 'x', confidence: 2 }] }, { items: [{ id: 'a', stream: 'people', confidence: 1 }] }]);
    const { data, provenance } = await run('test.batch', { list: [] });
    expect(data.items).toHaveLength(1);
    expect(provenance.repaired).toBe(true);
    expect(gw.calls).toHaveLength(2);
  });

  it('strips <think> blocks before parsing', async () => {
    gw.on('test.single', '<think>The sender is a friend, so people.</think>\n{"stream": "people"}');
    expect((await run('test.single')).data).toEqual({ stream: 'people' });
  });

  it('falls back to json_object when a model rejects json_schema, and remembers it', async () => {
    gw.on('test.single', (req) => (req.responseFormat.type === 'json_schema' ? gw.error(400, 'json_schema unsupported') : { stream: 'reading' }));
    expect((await run('test.single')).data).toEqual({ stream: 'reading' });
    expect(gw.calls.map((c) => c.responseFormat.type)).toEqual(['json_schema', 'json_object']);
    expect(gw.calls[1].text).toContain('matches this JSON schema');
    await run('test.single');
    expect(gw.calls.map((c) => c.responseFormat.type)).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('requires a user for budgeted features and enforces token budgets', async () => {
    gw.on('test.single', { stream: 'people' });
    await expect(runPrompt('test.single', {}, { lane: 'background' })).rejects.toMatchObject({ code: 'user_required' });
    db.usage = { n: 3, tokens: 1_000_000 };
    await expect(run('test.single')).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(gw.calls).toHaveLength(0);
  });

  it('keeps transcripts only when llm.keepTranscripts is on', async () => {
    cfg['llm.keepTranscripts'] = true;
    gw.on('test.single', { stream: 'people' });
    await run('test.single', { subject: 'Keep me' });
    const insert = db.calls.find((c) => /INSERT INTO hedwig_ai_calls/.test(c.sql));
    expect(insert.params[17]).toContain('Keep me');
    expect(insert.params[18]).toBe('{"stream":"people"}');
  });

  it('rejects unknown prompt ids', async () => {
    await expect(run('test.missing')).rejects.toMatchObject({ code: 'unknown_prompt' });
  });
});

describe('think stripping', () => {
  it('strips closed, unclosed and orphaned blocks', () => {
    expect(stripThinking('<think>secret</think> Hello')).toBe('Hello');
    expect(stripThinking('Answer <think>still going')).toBe('Answer');
    expect(stripThinking('reasoning the template opened</think>\nAnswer')).toBe('Answer');
    expect(stripThinking('no tags')).toBe('no tags');
  });

  it('filters streamed deltas with tags split across chunks', () => {
    const f = createThinkFilter();
    const chunks = ['<thi', 'nk>plan', ' the reply</th', 'ink>\n\nHel', 'lo <', 'b>there</b>'];
    const out = chunks.map((c) => f.push(c)).join('') + f.flush();
    expect(out).toBe('Hello <b>there</b>');
  });

  it('chat() and chatStream() return content without reasoning', async () => {
    gw.on('ask', '<think>let me think about this carefully</think>The answer is 42.');
    const res = await chat({ userId: USER, feature: 'ask', role: 'long', messages: [{ role: 'user', content: 'q' }] });
    expect(res.content).toBe('The answer is 42.');
    const deltas = [];
    let done;
    for await (const e of chatStream({ userId: USER, feature: 'ask', role: 'long', messages: [{ role: 'user', content: 'q' }] })) {
      if (e.type === 'delta') deltas.push(e.text); else done = e;
    }
    expect(deltas.join('')).toBe('The answer is 42.');
    expect(done).toMatchObject({ content: 'The answer is 42.', aiCallId: expect.any(Number), lane: 'interactive' });
    expect(gw.calls.every((c) => c.sessionId === 'hedwig' && c.workflow === 'ask')).toBe(true);
  });
});

describe('interactive lane fallback', () => {
  it('switches to the fallback after llm.lanes.interactive.fallbackAfterMs, not the global wait', async () => {
    cfg = { ...cfg, 'llm.fallbackModel': QWEN, 'llm.models.long': GEMMA, 'llm.fallbackAfterMs': 30000, 'llm.lanes.interactive.fallbackAfterMs': 30 };
    gw.on('ask', (req) => (req.model === GEMMA ? gw.hang() : 'from the fallback'));
    const started = Date.now();
    const res = await chat({ userId: USER, feature: 'ask', role: 'long', lane: 'interactive', messages: [] });
    expect(res).toMatchObject({ model: QWEN, fellBack: true, content: 'from the fallback' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('lane waits (llm.lanes.<lane>.waitMs)', () => {
  const hold = (lane) => acquireLane(lane, { limit: 1, leaseMs: 60_000 });

  it('a background call waits llm.lanes.background.waitMs for a slot, then gives up with lane_busy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cfg = { ...cfg, 'llm.lanes.background.concurrency': 1, 'llm.lanes.background.waitMs': 1200, 'llm.timeoutMs': 200 };
    gw.on('ask', 'late');
    const held = await hold('background');
    const started = Date.now();
    await expect(chat({ userId: USER, feature: 'ask', role: 'fast', lane: 'background', messages: [] }))
      .rejects.toMatchObject({ code: 'lane_busy', message: 'the background model lane stayed full for 1 s' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1150); // not llm.timeoutMs (200)
    // freed within the wait: the call gets the slot
    setTimeout(held, 150);
    await expect(chat({ userId: USER, feature: 'ask', role: 'fast', lane: 'background', messages: [] })).resolves.toMatchObject({ content: 'late' });
  }, 10_000);

  it('an interactive call fails fast after llm.lanes.interactive.waitMs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cfg = { ...cfg, 'llm.lanes.interactive.concurrency': 1, 'llm.lanes.interactive.waitMs': 100, 'llm.lanes.background.waitMs': 60_000 };
    const held = await hold('interactive');
    const started = Date.now();
    await expect(chat({ userId: USER, feature: 'ask', role: 'fast', lane: 'interactive', messages: [] })).rejects.toMatchObject({ code: 'lane_busy', status: 503 });
    expect(Date.now() - started).toBeLessThan(1000);
    held();
  });

  it('a job whose call never got a slot is deferred with its attempt refunded, not failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    cfg = { ...cfg, 'llm.lanes.background.concurrency': 1, 'llm.lanes.background.waitMs': 100, 'jobs.laneDeferMin': 7 };
    const jobs = await import('../jobs.js');
    jobs._resetJobs();
    jobs.defineJob('t.laneJob', () => chat({ userId: USER, feature: 'ask', role: 'fast', messages: [] }));
    const held = await hold('background');
    await jobs.runJob({ id: 42, kind: 't.laneJob', payload: {}, attempts: 1, max_attempts: 1 });
    held();
    const deferred = db.calls.find((c) => /attempts = GREATEST\(attempts - 1, 0\)/.test(c.sql) && c.params[0] === 42);
    expect(deferred).toBeTruthy();
    expect(deferred.params[1]).toBe('deferred: the background model lane stayed full for 0 s');
    expect(deferred.params[2]).toBe(String(7 * 60));
    expect(db.calls.some((c) => /SET failed_at = NOW\(\)/.test(c.sql) && c.params[0] === 42)).toBe(false);
    jobs._resetJobs();
  });
});

describe('review fixes (wave 1)', () => {
  it('remembers a json_schema rejection per prompt and model, and only for schema errors', async () => {
    gw.on('test.single', (req) => (req.responseFormat.type === 'json_schema' ? gw.error(400, 'response_format json_schema is not supported') : { stream: 'reading' }));
    gw.on('test.batch', { items: [{ id: 'a', stream: 'people', confidence: 0.9 }] });
    await run('test.single');
    await run('test.batch', { list: 'x' });
    // The other prompt on the same model still asks for json_schema.
    expect(gw.callsFor('test.batch')[0].responseFormat.type).toBe('json_schema');
    await run('test.single');
    expect(gw.callsFor('test.single').map((c) => c.responseFormat.type)).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('a 400 that is not about the schema is thrown, not answered by downgrading', async () => {
    gw.on('test.single', gw.error(400, 'context length exceeded: 140000 tokens'));
    await expect(run('test.single')).rejects.toMatchObject({ status: 400 });
    expect(gw.callsFor('test.single').map((c) => c.responseFormat.type)).toEqual(['json_schema']);
    gw.on('test.single', { stream: 'people' });
    await run('test.single');
    expect(gw.callsFor('test.single').at(-1).responseFormat.type).toBe('json_schema');
  });

  it('a budgeted feature without a user fails loudly unless the caller marks it budget-exempt', async () => {
    cfg = { ...cfg, 'llm.tokenBudget.assistant': 500000 };
    gw.on('assistant', 'ok');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(chat({ feature: 'assistant', role: 'long', messages: [] })).rejects.toMatchObject({ code: 'user_required' });
    const out = await chat({ feature: 'assistant', role: 'long', messages: [], budgetExempt: 'admin connection test' });
    expect(out.content).toBe('ok');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/outside the daily budget \(admin connection test\)/));
    warn.mockRestore();
  });

  it('a lane lease covers the primary and the fallback attempt', async () => {
    const evals = [];
    setLaneRedis({ isReady: true, eval: async (_lua, { arguments: args }) => { evals.push(args); return 1; }, zRem: async () => 1 });
    cfg = { ...cfg, 'llm.lanes.leaseSec': 1, 'llm.timeoutMs': 5000, 'llm.fallbackModel': QWEN };
    gw.on('ask', 'hi');
    await chat({ userId: USER, feature: 'ask', role: 'fast', messages: [] });
    expect(Number(evals[0][1])).toBe(2 * 5000 + 30_000);
    cfg = { ...cfg, 'llm.fallbackModel': '' };
    await chat({ userId: USER, feature: 'ask', role: 'fast', messages: [] });
    expect(Number(evals[1][1])).toBe(5000 + 30_000);
  });

  it("a running job's signal aborts its model calls even when the handler does not pass it on", async () => {
    gw.on('test.single', gw.hang());
    const controller = new AbortController();
    const pending = runInContext({ lane: 'background', signal: controller.signal }, () => run('test.single'));
    setTimeout(() => controller.abort(new Error('job timed out after 50 ms')), 50);
    const started = Date.now();
    await expect(pending).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
