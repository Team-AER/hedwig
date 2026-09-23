// The agent loop. One call = one user turn: the model is streamed with the user's tools, read-only
// tool calls run immediately (validated, time-bounded, output truncated), mutating tool calls become
// pending actions for the user to approve, and the loop ends when the model answers without tools or
// the step budget runs out. Messages, steps and token counts are appended to the run after every
// step, so a crash or a closed tab leaves a readable record.
import { getConfig } from '../config.js';
import { chatStream } from '../llm.js';
import { stripThinking } from '../prompts/think.js';
import { toOpenAiTools } from './toolRegistry.js';
import { userTools } from './access.js';
import { validateArgs } from './validate.js';
import { buildSystemPrompt, userProfile } from './prompt.js';
import { engineAvailable } from './mailOps.js';
import { approveAction, truncate } from './actions.js';
import * as store from './store.js';
import { runSources } from '../ask2/citations.js';

export const TOOL_RESULT_MAX_CHARS = 6000;
export const TOOL_TIMEOUT_MS = 60_000;
export const MAX_PROMPT_CHARS = 8000;
const WIRE_KEYS = ['role', 'content', 'tool_calls', 'tool_call_id', 'name'];
// Older turns of a long conversation are dropped from what the model sees (they stay in the run).
export const MAX_HISTORY_MESSAGES = 80;
const LAST_STEP_NOTE = 'You have used every tool step for this turn. Answer now from the tool results you already have; do not ask to call more tools.';

class AbortedError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortedError();
}

export { stripThinking };

function withTimeout(promise, ms, signal) {
  let timer;
  let onAbort;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`tool timed out after ${ms / 1000} s`)), ms);
      if (signal) {
        onAbort = () => reject(new AbortedError());
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }),
  ]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/** A short human line for the tool_result event. */
export function describeResult(result) {
  if (result == null) return 'no result';
  if (Array.isArray(result)) return `${result.length} item${result.length === 1 ? '' : 's'}`;
  if (typeof result === 'object') {
    for (const key of ['results', 'items', 'messages']) {
      if (Array.isArray(result[key])) return `${result[key].length} ${key === 'messages' ? 'message' : 'result'}${result[key].length === 1 ? '' : 's'}`;
    }
  }
  return 'ok';
}

/**
 * Stored conversation → messages for the gateway: only protocol keys, and an action note that was
 * appended while its tool call was still being processed moves after that call's tool results, so
 * an assistant tool_calls message is always followed directly by its tool messages.
 */
export function toWire(messages) {
  const toolIndexByAction = new Map();
  messages.forEach((m, i) => { if (m.role === 'tool' && m.action_id) toolIndexByAction.set(m.action_id, i); });
  const out = [];
  const deferred = [];
  const clean = (m) => Object.fromEntries(WIRE_KEYS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
  messages.forEach((m, i) => {
    if (m.kind === 'action_update' && (toolIndexByAction.get(m.action_id) ?? -1) > i) {
      deferred.push(m);
      return;
    }
    out.push(clean(m));
    const next = messages[i + 1];
    if (m.role === 'tool' && (!next || next.role !== 'tool') && deferred.length) {
      const flush = deferred.filter((d) => (toolIndexByAction.get(d.action_id) ?? Infinity) <= i);
      for (const d of flush) {
        out.push(clean(d));
        deferred.splice(deferred.indexOf(d), 1);
      }
    }
  });
  return [...out, ...deferred.map(clean)];
}

/**
 * The most recent part of a conversation, starting at a real user turn so a tool call is never
 * separated from its results.
 */
export function recentHistory(messages, max = MAX_HISTORY_MESSAGES) {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length - 1 && !(messages[start].role === 'user' && !messages[start].kind)) start++;
  return messages.slice(start);
}

const failure = (message) => ({ ok: false, content: JSON.stringify({ error: message }), summary: message });

async function proposeAction(tool, args, ctx) {
  const { userId, runId, signal, emit, autoExecute } = ctx;
  let summary;
  try {
    const prepared = tool.prepare ? await withTimeout(Promise.resolve(tool.prepare(args, { userId, runId, signal })), TOOL_TIMEOUT_MS, signal) : null;
    summary = prepared?.summary || (tool.summarize ? tool.summarize(args) : null) || `${tool.name} ${JSON.stringify(args)}`;
  } catch (err) {
    if (err instanceof AbortedError) throw err;
    return failure(err.message || 'invalid action');
  }
  const action = store.toAction(await store.insertAction(userId, runId, { tool: tool.name, args, summary: String(summary).slice(0, 500) }));
  if (autoExecute) {
    // The user turned confirmation off: approve it on their behalf, through the same path.
    const { action: done, result } = await approveAction(userId, action.id, { note: false });
    return {
      ok: done.status === 'executed',
      actionId: action.id,
      content: truncate(JSON.stringify({ status: done.status, action_id: action.id, result }), TOOL_RESULT_MAX_CHARS),
      summary: `${done.status === 'executed' ? 'Done' : 'Failed'}: ${summary}`,
    };
  }
  emit({ type: 'action_pending', action });
  return {
    ok: true,
    pending: true,
    actionId: action.id,
    content: JSON.stringify({
      status: 'pending_approval',
      action_id: action.id,
      summary,
      note: 'Not done yet. The user has to approve this action in Hedwig before it happens.',
    }),
    summary: `Awaiting approval: ${summary}`,
  };
}

/** Run one tool call from the model. Never throws except on abort. */
export async function executeToolCall(call, ctx) {
  const tool = ctx.byName.get(call.name);
  if (!tool) return failure(`unknown tool ${call.name}`);
  const v = validateArgs(tool.parameters, call.arguments);
  if (!v.ok) return failure(`invalid arguments: ${v.errors.join('; ')}`);
  if (tool.mutates) return proposeAction(tool, v.value, ctx);
  try {
    const result = await withTimeout(Promise.resolve(tool.handler(v.value, { userId: ctx.userId, runId: ctx.runId, signal: ctx.signal })), TOOL_TIMEOUT_MS, ctx.signal);
    return { ok: true, content: truncate(JSON.stringify(result ?? null), TOOL_RESULT_MAX_CHARS), summary: describeResult(result) };
  } catch (err) {
    if (err instanceof AbortedError || ctx.signal?.aborted) throw new AbortedError();
    const expected = err.name === 'ToolError' || (err.status && err.status < 500);
    if (!expected) console.warn(`[hedwig] agent tool ${call.name} failed:`, err.message);
    return failure(err.message || 'tool failed');
  }
}

function checkAllowedTools(allowedTools) {
  if (allowedTools == null) return null;
  if (!Array.isArray(allowedTools) || allowedTools.length > 100 || allowedTools.some((n) => typeof n !== 'string')) {
    throw store.httpError(400, 'allowedTools must be a list of tool names');
  }
  return allowedTools;
}

/**
 * Run one user turn.
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.prompt
 * @param {string} [opts.runId]        continue this run (it must be the user's and not running)
 * @param {string[]} [opts.allowedTools] narrow the tool set
 * @param {'chat'|'automation'} [opts.trigger]
 * @param {string} [opts.automationId]
 * @param {string} [opts.title]
 * @param {(event: object) => void} [opts.onEvent] SSE events (see docs/hedwig/API.md)
 * @param {AbortSignal} [opts.signal]  client disconnect: stop and mark the run cancelled
 * @returns {Promise<{ runId: string, status: string, result: string|null, error?: string, pendingActions: string[] }>}
 */
export async function runAgent({ userId, prompt, runId = null, allowedTools = null, trigger = 'chat', automationId = null, title = null, onEvent = () => {}, signal = null }) {
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['features.agent']) throw store.httpError(403, 'The agent is turned off');
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) throw store.httpError(400, 'prompt is required');
  if (text.length > MAX_PROMPT_CHARS) throw store.httpError(400, `prompt is longer than ${MAX_PROMPT_CHARS} characters`);
  const allowed = checkAllowedTools(allowedTools);

  let run;
  if (runId) {
    if (!(await store.getRunRow(userId, runId))) throw store.httpError(404, 'Run not found');
    run = await store.claimRun(userId, runId);
    if (!run) throw store.httpError(409, 'This run is still working');
  } else {
    run = await store.createRun(userId, { trigger, automationId, title: title || text.slice(0, 80), status: 'running' });
  }

  const emit = (event) => {
    try { onEvent(event); } catch (err) { console.warn('[hedwig] agent event listener failed:', err.message); }
  };
  const userMessage = { role: 'user', content: text };
  const convo = [...(Array.isArray(run.messages) ? run.messages : []), userMessage];
  const pendingActions = [];
  let status = 'done';
  let result = null;
  let error;

  try {
    await store.appendToRun(userId, run.id, { messages: [userMessage] });
    emit({ type: 'run', runId: run.id });

    const tools = await userTools(userId, allowed);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const system = buildSystemPrompt({ profile: await userProfile(userId), tz: cfg['insights.timezone'], extra: cfg['agent.systemPrompt'] });
    const maxSteps = cfg['agent.maxSteps'];
    // Automations run unattended, so their mail changes always wait for approval.
    const autoExecute = cfg['agent.requireConfirmation'] === false && trigger !== 'automation' && engineAvailable();
    const ctx = { userId, runId: run.id, byName, signal, emit, autoExecute };

    for (let step = 0; step < maxSteps; step++) {
      throwIfAborted(signal);
      const offerTools = step < maxSteps - 1 && tools.length > 0;
      const systemContent = offerTools || step === 0 ? system : `${system}\n\n${LAST_STEP_NOTE}`;
      let final = null;
      for await (const evt of chatStream({
        userId, feature: 'agent', role: 'agent', signal,
        messages: [{ role: 'system', content: systemContent }, ...toWire(recentHistory(convo))],
        tools: offerTools ? toOpenAiTools(tools) : undefined,
      })) {
        if (evt.type === 'delta') emit({ type: 'delta', text: evt.text });
        else if (evt.type === 'done') final = evt;
      }
      throwIfAborted(signal);
      if (!final) throw new Error('the model stream ended without a result');

      const calls = offerTools ? (final.toolCalls || []).filter((c) => c.name) : [];
      const assistant = { role: 'assistant', content: final.content || null };
      if (calls.length) {
        assistant.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } }));
      }
      const newMessages = [assistant];
      const stepRecord = {
        n: step + 1,
        at: new Date().toISOString(),
        finish_reason: final.finishReason,
        prompt_tokens: final.usage?.prompt_tokens ?? null,
        completion_tokens: final.usage?.completion_tokens ?? null,
        tool_calls: [],
      };
      for (const call of calls) {
        throwIfAborted(signal);
        emit({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments });
        const outcome = await executeToolCall(call, ctx);
        if (outcome.pending) pendingActions.push(outcome.actionId);
        newMessages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: outcome.content, ...(outcome.actionId ? { action_id: outcome.actionId } : {}) });
        stepRecord.tool_calls.push({ id: call.id, name: call.name, arguments: call.arguments, ok: outcome.ok, summary: outcome.summary, action_id: outcome.actionId || null });
        emit({ type: 'tool_result', id: call.id, name: call.name, ok: outcome.ok, summary: outcome.summary });
      }
      convo.push(...newMessages);
      await store.appendToRun(userId, run.id, {
        messages: newMessages, steps: [stepRecord],
        promptTokens: final.usage?.prompt_tokens, completionTokens: final.usage?.completion_tokens,
      });
      if (!calls.length) {
        result = stripThinking(final.content);
        break;
      }
    }
  } catch (err) {
    if (err instanceof AbortedError || signal?.aborted) {
      status = 'cancelled';
    } else {
      status = 'error';
      error = err.message || 'agent run failed';
      if (!err.code) console.error(`[hedwig] agent run ${run.id} failed:`, err);
    }
  }

  await store.appendToRun(userId, run.id, { status, result, ...(error !== undefined ? { error } : {}) })
    .catch((err) => console.error(`[hedwig] could not record the end of run ${run.id}:`, err.message));
  if (status === 'error') emit({ type: 'error', error, runId: run.id });
  else emit({ type: 'done', runId: run.id, status, result, sources: await runSources(userId, run.id).catch(() => []) });
  return { runId: run.id, status, result, error, pendingActions };
}
