import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory stand-in for the tables the agent touches ─────────────────────────
const db = vi.hoisted(() => {
  const state = { runs: new Map(), actions: new Map(), system: {}, user: {}, seq: 0 };
  const uuid = () => `00000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`;
  const res = (rows) => ({ rows, rowCount: rows.length });
  async function query(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM system_settings')) return res([{ value: state.system }]);
    if (sql.includes('FROM hedwig_user_settings')) return res([{ settings: state.user }]);
    if (sql.includes('hedwig_plugin_grants')) return res([]);
    if (sql.includes("preferences->'enabledPlugins'")) return res([{ list: [] }]);
    if (sql.startsWith('SELECT username, display_name FROM users')) return res([{ username: 'demo', display_name: 'Demo User' }]);
    if (sql.includes('FROM email_accounts a WHERE a.user_id')) return res([{ id: 'acc-1', name: 'Work', email_address: 'me@work.example', aliases: [] }]);
    if (sql.startsWith('INSERT INTO hedwig_agent_runs')) {
      const run = { id: uuid(), user_id: params[0], trigger: params[1], automation_id: params[2], title: params[3], status: params[4], messages: [], steps: [], result: null, error: null, prompt_tokens: 0, completion_tokens: 0, updated_at: new Date() };
      state.runs.set(run.id, run);
      return res([{ ...run }]);
    }
    if (sql.startsWith('SELECT * FROM hedwig_agent_runs WHERE id')) {
      const run = state.runs.get(params[0]);
      return res(run && run.user_id === params[1] ? [{ ...run }] : []);
    }
    if (sql.startsWith("UPDATE hedwig_agent_runs SET status = 'running'")) {
      const run = state.runs.get(params[0]);
      if (!run || run.user_id !== params[1] || run.status === 'running') return res([]);
      run.status = 'running';
      return res([{ ...run, messages: [...run.messages] }]);
    }
    if (sql.startsWith('UPDATE hedwig_agent_runs SET messages = messages ||')) {
      const run = state.runs.get(params[0]);
      if (!run || run.user_id !== params[1]) return res([]);
      run.messages.push(...JSON.parse(params[2]));
      run.steps.push(...JSON.parse(params[3]));
      run.prompt_tokens += params[4];
      run.completion_tokens += params[5];
      if (params[6]) run.status = params[6];
      if (params[7]) run.result = params[8];
      if (params[9]) run.error = params[10];
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO hedwig_agent_actions')) {
      const a = { id: uuid(), run_id: params[0], user_id: params[1], tool: params[2], args: JSON.parse(params[3]), summary: params[4], status: 'pending', result: null, created_at: new Date(), decided_at: null };
      state.actions.set(a.id, a);
      return res([{ ...a }]);
    }
    if (sql.startsWith('SELECT * FROM hedwig_agent_actions WHERE id')) {
      const a = state.actions.get(params[0]);
      return res(a && a.user_id === params[1] ? [{ ...a }] : []);
    }
    if (sql.startsWith('UPDATE hedwig_agent_actions')) {
      const a = state.actions.get(params[0]);
      if (!a || a.user_id !== params[1] || a.status !== params[2]) return res([]);
      a.status = params[3];
      if (params[4]) a.result = JSON.parse(params[5]);
      return res([{ ...a }]);
    }
    if (sql.startsWith('INSERT INTO hedwig_jobs')) return res([{ id: 1 }]);
    return res([]);
  }
  return { state, query, reset() { state.runs.clear(); state.actions.clear(); state.system = {}; state.user = {}; } };
});

const llm = vi.hoisted(() => ({ script: [], calls: [] }));
const engine = vi.hoisted(() => ({ available: false }));

vi.mock('../../services/db.js', () => ({ query: db.query, pool: {} }));
vi.mock('../../plugins/mailEngine.js', () => ({
  getMailEngine: () => {
    if (!engine.available) throw new Error('mail engine not initialized');
    return {};
  },
}));
vi.mock('../llm.js', () => ({
  async* chatStream(opts) {
    llm.calls.push({ messages: opts.messages, tools: opts.tools });
    const step = llm.script.shift();
    if (!step) throw new Error('model script exhausted');
    if (typeof step === 'function') await step(opts);
    const { content = '', toolCalls = [] } = typeof step === 'function' ? {} : step;
    if (content) yield { type: 'delta', text: content };
    yield { type: 'done', content, toolCalls, usage: { prompt_tokens: 100, completion_tokens: 10 }, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
  },
}));

const { registerTool, _resetTools } = await import('./toolRegistry.js');
const { invalidateConfigCache } = await import('../config.js');
const { runAgent, toWire, describeResult, recentHistory } = await import('./runner.js');
const { approveAction, rejectAction } = await import('./actions.js');
const { validateArgs } = await import('./validate.js');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

const lookup = vi.fn(async ({ q }) => ({ results: [{ id: MSG, subject: `about ${q}` }] }));
const zap = vi.fn(async ({ messageId }) => ({ archived: true, messageId }));
const zapPrepare = vi.fn(async ({ messageId }) => ({ summary: `Archive ${messageId}` }));

function registerTestTools() {
  _resetTools();
  registerTool({
    name: 'lookup', description: 'find mail', handler: lookup,
    parameters: { type: 'object', properties: { q: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 25, default: 5 } }, required: ['q'] },
  });
  registerTool({
    name: 'zap', description: 'archive a message', mutates: true, handler: zap, prepare: zapPrepare,
    parameters: { type: 'object', properties: { messageId: { type: 'string', format: 'uuid' } }, required: ['messageId'] },
  });
}

const call = (id, name, args) => ({ id, name, arguments: args });

async function run(prompt, opts = {}) {
  const events = [];
  const out = await runAgent({ userId: USER, prompt, onEvent: (e) => events.push(e), ...opts });
  return { ...out, events, run: db.state.runs.get(out.runId) };
}

beforeEach(() => {
  db.reset();
  invalidateConfigCache();
  llm.script = [];
  llm.calls = [];
  engine.available = false;
  lookup.mockClear();
  zap.mockClear();
  zapPrepare.mockClear();
  registerTestTools();
});

describe('agent loop', () => {
  it('runs a read-only tool and returns the final answer', async () => {
    llm.script = [
      { toolCalls: [call('c1', 'lookup', { q: 'invoice' })] },
      { content: `Marta sent it [msg:${MSG}].` },
    ];
    const { status, result, events, run: stored } = await run('find the invoice');

    expect(status).toBe('done');
    expect(result).toBe(`Marta sent it [msg:${MSG}].`);
    expect(lookup).toHaveBeenCalledWith({ q: 'invoice', limit: 5 }, expect.objectContaining({ userId: USER }));
    expect(events.map((e) => e.type)).toEqual(['run', 'tool_call', 'tool_result', 'delta', 'done']);
    expect(events[2]).toMatchObject({ type: 'tool_result', id: 'c1', name: 'lookup', ok: true, summary: '1 result' });

    // The second model call saw the assistant tool call followed by its result.
    const wire = llm.calls[1].messages;
    expect(wire[0].role).toBe('system');
    expect(wire[0].content).toContain('Demo User');
    expect(wire[0].content).toContain('me@work.example');
    expect(wire.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.parse(wire[3].content).results[0].id).toBe(MSG);

    expect(stored.status).toBe('done');
    expect(stored.result).toBe(result);
    expect(stored.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(stored.steps).toHaveLength(2);
    expect(stored.prompt_tokens).toBe(200);
  });

  it('turns a mutating tool call into a pending action without executing it', async () => {
    engine.available = true; // even where the engine exists, confirmation is on by default
    llm.script = [
      { toolCalls: [call('c1', 'zap', { messageId: MSG })] },
      { content: 'The archive is waiting for your approval.' },
    ];
    const { status, events, pendingActions, run: stored } = await run('archive it');

    expect(status).toBe('done');
    expect(zap).not.toHaveBeenCalled();
    expect(zapPrepare).toHaveBeenCalledOnce();
    const pending = events.find((e) => e.type === 'action_pending');
    expect(pending.action).toMatchObject({ tool: 'zap', status: 'pending', summary: `Archive ${MSG}`, args: { messageId: MSG } });
    expect(pendingActions).toEqual([pending.action.id]);
    expect(db.state.actions.get(pending.action.id).status).toBe('pending');
    const toolMsg = stored.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ status: 'pending_approval', action_id: pending.action.id });
  });

  it('never executes mutating tools outside the API process, even with confirmation off', async () => {
    db.state.user = { 'agent.requireConfirmation': false };
    llm.script = [{ toolCalls: [call('c1', 'zap', { messageId: MSG })] }, { content: 'Queued.' }];
    const { events } = await run('archive it');
    expect(zap).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'action_pending')).toBe(true);
  });

  it('executes immediately when the user turned confirmation off (API process, chat only)', async () => {
    engine.available = true;
    db.state.user = { 'agent.requireConfirmation': false };
    llm.script = [{ toolCalls: [call('c1', 'zap', { messageId: MSG })] }, { content: 'Archived.' }];
    const { events } = await run('archive it');
    expect(zap).toHaveBeenCalledOnce();
    const [action] = [...db.state.actions.values()];
    expect(action.status).toBe('executed');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: true, summary: expect.stringMatching(/^Done/) });

    // Automations never auto-execute.
    zap.mockClear();
    llm.script = [{ toolCalls: [call('c2', 'zap', { messageId: MSG })] }, { content: 'Proposed.' }];
    await run('archive it', { trigger: 'automation' });
    expect(zap).not.toHaveBeenCalled();
  });

  it('reports invalid arguments to the model without calling the tool', async () => {
    llm.script = [
      { toolCalls: [call('c1', 'lookup', { limit: 99 }), call('c2', 'zap', { messageId: 'not-an-id' }), call('c3', 'nope', {})] },
      { content: 'Sorry.' },
    ];
    const { events } = await run('go');
    expect(lookup).not.toHaveBeenCalled();
    expect(zapPrepare).not.toHaveBeenCalled();
    expect(db.state.actions.size).toBe(0);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(results[0].summary).toMatch(/q is required/);
    expect(results[0].summary).toMatch(/limit must be ≤ 25/);
    expect(results[1].summary).toMatch(/messageId must be an id/);
    expect(results[2].summary).toMatch(/unknown tool nope/);
  });

  it('only offers tools named in allowedTools and refuses calls to others', async () => {
    llm.script = [{ toolCalls: [call('c1', 'zap', { messageId: MSG })] }, { content: 'ok' }];
    const { events } = await run('go', { allowedTools: ['lookup'] });
    expect(llm.calls[0].tools.map((t) => t.function.name)).toEqual(['lookup']);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: 'unknown tool zap' });
    expect(db.state.actions.size).toBe(0);
  });

  it('caps the loop at agent.maxSteps and withholds tools on the last step', async () => {
    db.state.system = { 'agent.maxSteps': 3 };
    llm.script = [
      { toolCalls: [call('c1', 'lookup', { q: 'a' })] },
      { toolCalls: [call('c2', 'lookup', { q: 'b' })] },
      { content: 'Here is what I found.', toolCalls: [call('c3', 'lookup', { q: 'c' })] },
    ];
    const { status, result, run: stored } = await run('dig');
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[0].tools).toBeDefined();
    expect(llm.calls[2].tools).toBeUndefined();
    expect(llm.calls[2].messages[0].content).toMatch(/used every tool step/);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(status).toBe('done');
    expect(result).toBe('Here is what I found.');
    expect(stored.steps).toHaveLength(3);
  });

  it('stops and marks the run cancelled when the client disconnects', async () => {
    const controller = new AbortController();
    lookup.mockImplementationOnce(async () => {
      controller.abort();
      return { results: [] };
    });
    llm.script = [{ toolCalls: [call('c1', 'lookup', { q: 'x' }), call('c2', 'lookup', { q: 'y' })] }, { content: 'never' }];
    const { status, events, run: stored } = await run('go', { signal: controller.signal });
    expect(status).toBe('cancelled');
    expect(lookup).toHaveBeenCalledOnce();
    expect(llm.calls).toHaveLength(1);
    expect(stored.status).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
  });

  it('records a model failure as an error event and run status', async () => {
    llm.script = [() => { throw Object.assign(new Error('daily model budget for agent reached (400)'), { code: 'budget_exceeded' }); }];
    const { status, events, run: stored } = await run('go');
    expect(status).toBe('error');
    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'daily model budget for agent reached (400)' });
    expect(stored.status).toBe('error');
  });

  it('continues a run with its history, and refuses other users and busy runs', async () => {
    llm.script = [{ content: 'First answer.' }];
    const first = await run('hello');
    llm.script = [{ content: 'Second answer.' }];
    await run('and then?', { runId: first.runId });
    expect(llm.calls[1].messages.slice(1).map((m) => m.content)).toEqual(['hello', 'First answer.', 'and then?']);

    await expect(runAgent({ userId: OTHER, prompt: 'x', runId: first.runId })).rejects.toMatchObject({ status: 404 });
    db.state.runs.get(first.runId).status = 'running';
    await expect(runAgent({ userId: USER, prompt: 'x', runId: first.runId })).rejects.toMatchObject({ status: 409 });
    await expect(runAgent({ userId: USER, prompt: '   ' })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to run when the agent feature is off', async () => {
    db.state.user = { 'features.agent': false };
    await expect(runAgent({ userId: USER, prompt: 'x' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('actions', () => {
  async function pendingAction() {
    llm.script = [{ toolCalls: [call('c1', 'zap', { messageId: MSG })] }, { content: 'Waiting for approval.' }];
    const { events, runId } = await run('archive it');
    return { action: events.find((e) => e.type === 'action_pending').action, runId };
  }

  it('executes an approved action once, records the result and notes it on the run', async () => {
    engine.available = true;
    const { action, runId } = await pendingAction();
    const { action: done, result } = await approveAction(USER, action.id);
    expect(zap).toHaveBeenCalledWith({ messageId: MSG }, expect.objectContaining({ userId: USER, actionId: action.id }));
    expect(done.status).toBe('executed');
    expect(result).toEqual({ archived: true, messageId: MSG });
    await expect(approveAction(USER, action.id)).rejects.toMatchObject({ status: 409 });
    expect(zap).toHaveBeenCalledOnce();

    const note = db.state.runs.get(runId).messages.at(-1);
    expect(note).toMatchObject({ role: 'user', kind: 'action_update', action_id: action.id });
    expect(note.content).toMatch(/^\[Hedwig status update, not typed by the user\] The user approved/);
  });

  it('records a failed execution', async () => {
    engine.available = true;
    const { action } = await pendingAction();
    zap.mockRejectedValueOnce(Object.assign(new Error('message not found'), { name: 'ToolError', status: 400 }));
    const { action: done } = await approveAction(USER, action.id);
    expect(done.status).toBe('failed');
    expect(done.result).toEqual({ error: 'message not found' });
  });

  it('queues execution for the API process when approved elsewhere', async () => {
    const { action } = await pendingAction();
    const out = await approveAction(USER, action.id);
    expect(out.queued).toBe(true);
    expect(out.action.status).toBe('approved');
    expect(zap).not.toHaveBeenCalled();
  });

  it('never lets another user approve or reject an action', async () => {
    engine.available = true;
    const { action } = await pendingAction();
    await expect(approveAction(OTHER, action.id)).rejects.toMatchObject({ status: 404 });
    await expect(rejectAction(OTHER, action.id)).rejects.toMatchObject({ status: 404 });
    expect(db.state.actions.get(action.id).status).toBe('pending');
    expect(zap).not.toHaveBeenCalled();
  });

  it('rejecting does not execute, and a rejected action cannot be approved', async () => {
    engine.available = true;
    const { action } = await pendingAction();
    expect((await rejectAction(USER, action.id)).action.status).toBe('rejected');
    await expect(approveAction(USER, action.id)).rejects.toMatchObject({ status: 409 });
    expect(zap).not.toHaveBeenCalled();
  });
});

describe('toWire', () => {
  it('keeps protocol keys only and moves an early action note after its tool results', () => {
    const messages = [
      { role: 'user', content: 'archive both' },
      { role: 'user', kind: 'action_update', action_id: 'a1', content: 'approved a1' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }, { id: 'c2' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'zap', content: '{}', action_id: 'a1' },
      { role: 'tool', tool_call_id: 'c2', name: 'zap', content: '{}', action_id: 'a2' },
      { role: 'assistant', content: 'waiting' },
    ];
    const wire = toWire(messages);
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    expect(wire[4].content).toBe('approved a1');
    expect(wire.every((m) => !('action_id' in m) && !('kind' in m))).toBe(true);
  });
});

describe('recentHistory', () => {
  it('drops old turns but always starts at a real user message', () => {
    const turn = (i) => [
      { role: 'user', content: `q${i}` },
      { role: 'assistant', content: null, tool_calls: [{ id: `c${i}` }] },
      { role: 'tool', tool_call_id: `c${i}`, content: '{}' },
      { role: 'user', kind: 'action_update', content: 'note' },
      { role: 'assistant', content: `a${i}` },
    ];
    const history = [1, 2, 3, 4].flatMap(turn);
    expect(recentHistory(history, 100)).toBe(history);
    const cut = recentHistory(history, 7); // would start mid-turn: skips ahead to q4
    expect(cut[0]).toEqual({ role: 'user', content: 'q4' });
    expect(cut).toHaveLength(5);
  });
});

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      messageId: { type: 'string', format: 'uuid' },
      read: { type: 'boolean', default: true },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
      when: { type: 'string', format: 'date-time' },
      mode: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string', maxLength: 5 }, maxItems: 2 },
    },
    required: ['messageId'],
  };

  it('coerces model-style values, applies defaults and drops unknown keys', () => {
    expect(validateArgs(schema, { messageId: MSG, limit: '7', read: 'false', extra: 'x' }))
      .toEqual({ ok: true, value: { messageId: MSG, read: false, limit: 7 } });
    expect(validateArgs(schema, { messageId: MSG })).toEqual({ ok: true, value: { messageId: MSG, read: true } });
  });

  it('reports every problem', () => {
    const r = validateArgs(schema, { limit: 0, when: 'next tuesday', mode: 'c', tags: ['toolong', 'a', 'b'] });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      'messageId is required', 'limit must be ≥ 1', 'when must be an ISO 8601 date-time', 'mode must be one of a, b',
      'tags has more than 2 items', 'tags[0] is longer than 5 characters',
    ]));
  });

  it('rejects unparseable argument JSON and wrong types', () => {
    expect(validateArgs(schema, { _raw: '{"messageId":' })).toEqual({ ok: false, errors: ['arguments were not valid JSON'] });
    expect(validateArgs(schema, { messageId: 12 }).ok).toBe(false);
    expect(validateArgs(schema, { messageId: MSG, limit: 2.5 }).errors).toEqual(['limit must be integer']);
  });
});

describe('describeResult', () => {
  it('summarises common result shapes', () => {
    expect(describeResult([1, 2])).toBe('2 items');
    expect(describeResult({ results: [1] })).toBe('1 result');
    expect(describeResult({ messages: [1, 2, 3] })).toBe('3 messages');
    expect(describeResult({ ok: true })).toBe('ok');
    expect(describeResult(null)).toBe('no result');
  });
});
