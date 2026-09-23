// Hedwig model gateway client.
//
// One client for every model call Hedwig or a plugin makes. It speaks the OpenAI chat-completions
// protocol to a configurable base URL (llm-proxy.cls by default), picks the model by ROLE
// (fast / long / agent), clamps reasoning effort to what the catalog says each model accepts,
// enforces per-user daily budgets per feature (calls and tokens), bounds concurrency per model and
// per lane (prompts/lanes.js), strips reasoning traces (prompts/think.js), and logs every call to
// hedwig_ai_calls with its provenance. Nothing else in Hedwig opens a connection to a model.
// Structured prompts go through prompts/index.js (runPrompt), which is built on chat() below.
import { query } from '../services/db.js';
import { getConfig } from './config.js';
import { stripThinking, createThinkFilter } from './prompts/think.js';
import { acquireLane } from './prompts/lanes.js';
import { currentLane, recordUsage, currentJobId, currentContext } from './ledger/context.js';

export { stripThinking };

export class LlmError extends Error {
  constructor(message, { status = 502, code = 'llm_error' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

export class BudgetExceededError extends LlmError {
  constructor(feature, limit) {
    super(`daily model budget for ${feature} reached (${limit})`, { status: 429, code: 'budget_exceeded' });
    this.name = 'BudgetExceededError';
  }
}

export class LlmDisabledError extends LlmError {
  constructor(reason = 'model features are disabled') {
    super(reason, { status: 503, code: 'llm_disabled' });
    this.name = 'LlmDisabledError';
  }
}

export const ROLES = ['fast', 'long', 'agent'];
const EFFORT_LADDER = ['off', 'low', 'medium', 'high', 'xhigh'];

// ── Catalog ─────────────────────────────────────────────────────────────────
let catalogCache = { url: null, data: null, expiry: 0 };

export async function getCatalog({ force = false, fetchFn = fetch } = {}) {
  const cfg = await getConfig();
  const url = cfg['llm.catalogUrl'];
  if (!force && catalogCache.url === url && catalogCache.expiry > Date.now()) return catalogCache.data;
  let data = null;
  if (url) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) data = await res.json();
    } catch {
      data = null;
    }
  }
  if (!data && cfg['llm.baseUrl']) {
    // Fall back to /models, which lists ids but not reasoning levels.
    try {
      const res = await fetchFn(`${cfg['llm.baseUrl'].replace(/\/+$/, '')}/models`, {
        headers: authHeaders(cfg['llm.apiKey']),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const body = await res.json();
        data = { models: (body.data || []).map((m) => ({ id: m.id, display_name: m.id, status: 'ready' })) };
      }
    } catch {
      data = null;
    }
  }
  catalogCache = { url, data: data || { models: [] }, expiry: Date.now() + 5 * 60_000 };
  return catalogCache.data;
}

/** The catalog entry for a model id, or null. */
export async function modelInfo(model, { fetchFn } = {}) {
  const catalog = await getCatalog(fetchFn ? { fetchFn } : {});
  return (catalog.models || []).find((m) => m.id === model) || null;
}

/** The most output tokens a model may be asked for: the catalog's max_output_tokens, else config. */
export async function outputCap(model, cfg, { fetchFn } = {}) {
  const info = await modelInfo(model, { fetchFn });
  const n = Number(info?.max_output_tokens);
  if (Number.isFinite(n) && n > 0) return n;
  return (cfg || await getConfig())['llm.defaultMaxOutputTokens'] || 8192;
}

/**
 * Is the gateway reachable right now? Tries the catalog URL, then /models. Used by the job health
 * gate (jobs.js) to defer model work instead of burning attempts while the gateway is down.
 * @returns {Promise<{ ok: boolean, disabled?: boolean, error?: string }>}
 */
export async function probeGateway({ fetchFn = fetch, timeoutMs = 5000 } = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg['llm.baseUrl']) return { ok: true, disabled: true };
  const urls = [cfg['llm.catalogUrl'], `${cfg['llm.baseUrl'].replace(/\/+$/, '')}/models`].filter(Boolean);
  let error = 'unreachable';
  for (const url of urls) {
    try {
      const res = await fetchFn(url, { headers: authHeaders(cfg['llm.apiKey']), signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true };
      error = `${url} answered ${res.status}`;
    } catch (err) {
      error = `${url}: ${errorText(err)}`;
    }
  }
  return { ok: false, error };
}

/**
 * Map a requested effort onto the nearest level the model advertises, then onto the wire spelling.
 * Returns undefined when the model does not do reasoning at all (the field is then omitted).
 */
export function clampEffort(requested, catalogModel, offSpelling = 'none') {
  if (!requested) return undefined;
  const advertised = Array.isArray(catalogModel?.reasoning_efforts) ? catalogModel.reasoning_efforts : null;
  const normalise = (e) => (e === 'none' ? 'off' : e);
  let level = normalise(requested);
  if (advertised && advertised.length) {
    const available = advertised.map(normalise).filter((e) => EFFORT_LADDER.includes(e));
    if (available.length && !available.includes(level)) {
      const want = EFFORT_LADDER.indexOf(level);
      level = available.reduce((best, e) => {
        const d = Math.abs(EFFORT_LADDER.indexOf(e) - want);
        const bd = Math.abs(EFFORT_LADDER.indexOf(best) - want);
        return d < bd || (d === bd && EFFORT_LADDER.indexOf(e) < EFFORT_LADDER.indexOf(best)) ? e : best;
      }, available[0]);
    }
  } else if (catalogModel && catalogModel.capabilities && !catalogModel.capabilities.includes('reasoning')) {
    return undefined;
  }
  return level === 'off' ? offSpelling : level;
}

// ── Concurrency ─────────────────────────────────────────────────────────────
const semaphores = new Map(); // model -> { active, queue: [] }

async function acquire(model, limit) {
  let s = semaphores.get(model);
  if (!s) { s = { active: 0, queue: [] }; semaphores.set(model, s); }
  if (s.active < limit) { s.active++; return () => release(model); }
  await new Promise((resolve) => s.queue.push(resolve));
  s.active++;
  return () => release(model);
}

function release(model) {
  const s = semaphores.get(model);
  if (!s) return;
  s.active = Math.max(0, s.active - 1);
  const next = s.queue.shift();
  if (next) next();
}

// ── Budgets ─────────────────────────────────────────────────────────────────
export async function usedToday(userId, feature, pluginId = null) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM hedwig_ai_calls
      WHERE created_at >= date_trunc('day', NOW())
        AND feature = $1
        AND ($2::uuid IS NULL OR user_id = $2)
        AND ($3::text IS NULL OR plugin_id = $3)`,
    [feature, userId || null, pluginId],
  );
  return rows[0]?.n || 0;
}

/** Calls and tokens a user has spent on a feature today. */
export async function usageToday(userId, feature, pluginId = null) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)),0)::bigint AS tokens
       FROM hedwig_ai_calls
      WHERE created_at >= date_trunc('day', NOW())
        AND feature = $1
        AND ($2::uuid IS NULL OR user_id = $2)
        AND ($3::text IS NULL OR plugin_id = $3)`,
    [feature, userId || null, pluginId],
  );
  return { calls: Number(rows[0]?.n) || 0, tokens: Number(rows[0]?.tokens) || 0 };
}

const exemptWarned = new Set();

/**
 * Budgets are per user, per feature, per day: a call budget (llm.dailyBudget.<feature>) and a token
 * budget (llm.tokenBudget.<feature>). A budgeted feature always needs a user to charge, with one
 * explicit exception: a caller where no user can exist (an admin connection test, say) passes
 * `budgetExempt: '<why>'`. The call then runs unbudgeted, the reason is logged once per process,
 * and the call is still recorded in hedwig_ai_calls (with no user). Without a user and without
 * budgetExempt the call fails loudly (400 user_required); it is never skipped silently.
 */
async function checkBudget(cfg, userId, feature, pluginId, budgetExempt = null) {
  const callKey = pluginId ? 'llm.dailyBudget.plugins' : `llm.dailyBudget.${feature}`;
  const tokenKey = pluginId ? 'llm.tokenBudget.plugins' : `llm.tokenBudget.${feature}`;
  const hasCalls = callKey in cfg;
  const hasTokens = tokenKey in cfg;
  if (!hasCalls && !hasTokens) return;
  const label = pluginId ? `plugin ${pluginId}` : feature;
  if (!userId && typeof budgetExempt === 'string' && budgetExempt.trim()) {
    const why = budgetExempt.trim().slice(0, 120);
    if (!exemptWarned.has(`${label}|${why}`)) {
      exemptWarned.add(`${label}|${why}`);
      console.warn(`[hedwig] ${label} model call without a user runs outside the daily budget (${why})`);
    }
    return;
  }
  if (!userId) throw new LlmError(`model calls for ${label} need a user to charge the budget to`, { status: 400, code: 'user_required' });
  const used = await usageToday(userId, pluginId ? 'plugin' : feature, pluginId);
  if (hasCalls && used.calls >= cfg[callKey]) throw new BudgetExceededError(label, cfg[callKey]);
  if (hasTokens && used.tokens >= cfg[tokenKey]) throw new BudgetExceededError(`${label} tokens`, cfg[tokenKey]);
}

const TRANSCRIPT_MAX_CHARS = 200_000;

/** Record one call. Returns the hedwig_ai_calls id (null when logging failed). Never throws. */
async function logCall(entry) {
  try {
    const keep = entry.keepTranscripts === true;
    const { rows } = await query(
      `INSERT INTO hedwig_ai_calls (user_id, feature, plugin_id, model, reasoning, prompt_tokens, completion_tokens, latency_ms, ok, error,
                                    prompt_id, prompt_version, prompt_hash, lane, tier, workflow, job_id, prompt_text, output_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [entry.userId || null, entry.feature, entry.pluginId || null, entry.model, entry.reasoning || null,
        entry.promptTokens ?? null, entry.completionTokens ?? null, entry.latencyMs ?? null, entry.ok, entry.error ? String(entry.error).slice(0, 500) : null,
        entry.prompt?.id || null, entry.prompt?.version || null, entry.prompt?.hash || null, entry.lane || null, entry.prompt?.tier || entry.tier || null,
        entry.workflow || null, currentJobId(),
        keep && entry.messages ? JSON.stringify(entry.messages).slice(0, TRANSCRIPT_MAX_CHARS) : null,
        keep && typeof entry.output === 'string' ? entry.output.slice(0, TRANSCRIPT_MAX_CHARS) : null],
    );
    return rows?.[0]?.id ?? null;
  } catch {
    // Logging must never fail a call.
    return null;
  }
}

function authHeaders(apiKey, extra = null) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  if (extra) Object.assign(h, extra);
  return h;
}

/** Headers every completion carries: the gateway groups calls by session and workflow. */
function gatewayHeaders(workflow) {
  return { 'X-Session-ID': 'hedwig', 'X-Workflow': String(workflow || 'hedwig').slice(0, 120) };
}

/** Whether model features can run at all right now. */
export async function llmAvailable(userId) {
  const cfg = await getConfig(userId);
  return Boolean(cfg.enabled && cfg['llm.baseUrl']);
}

// ── Fallback ────────────────────────────────────────────────────────────────
// When llm.fallbackModel is set, a call that gets no response from the primary model within
// llm.fallbackAfterMs (or fails with a 5xx or connection error) is retried once on the fallback
// model, and the primary is skipped for llm.fallbackCooldownSec so every call does not pay the wait.
// After the cooldown the primary is tried again, so traffic returns to it on its own.
const degradedUntil = new Map(); // model -> epoch ms

export function primaryDegraded(model, now = Date.now()) {
  const until = degradedUntil.get(model) || 0;
  return until > now;
}

function markDegraded(model, cooldownSec) {
  degradedUntil.set(model, Date.now() + cooldownSec * 1000);
}

/** Which model currently serves each role, for status pages. */
export async function activeModels(userId) {
  const cfg = await getConfig(userId);
  const fallback = cfg['llm.fallbackModel'];
  return Object.fromEntries(ROLES.map((role) => {
    const primary = cfg[`llm.models.${role}`];
    const degraded = Boolean(fallback) && primaryDegraded(primary);
    return [role, { primary, fallback: fallback || null, active: degraded ? fallback : primary, degraded }];
  }));
}

async function prepare({ userId, feature, role = 'fast', pluginId, model: explicitModel, reasoning, lane: requestedLane, fetchFn, budgetExempt }) {
  const cfg = await getConfig(userId);
  if (!cfg.enabled) throw new LlmDisabledError('Hedwig intelligence is disabled');
  if (!cfg['llm.baseUrl']) throw new LlmDisabledError('no model gateway configured');
  if (!ROLES.includes(role)) throw new LlmError(`unknown model role ${role}`, { status: 400 });
  await checkBudget(cfg, userId, feature, pluginId, budgetExempt);
  const lane = currentLane(requestedLane);
  // A person is waiting on interactive calls, so they give up on a silent primary sooner.
  const interactiveWait = cfg['llm.lanes.interactive.fallbackAfterMs'];
  const firstByteMs = lane === 'interactive' && Number.isFinite(interactiveWait)
    ? Math.min(interactiveWait, cfg['llm.fallbackAfterMs'])
    : cfg['llm.fallbackAfterMs'];
  const catalog = await getCatalog(fetchFn ? { fetchFn } : {});
  const requested = reasoning || cfg[`llm.reasoning.${role}`];
  const plan = (model) => ({
    model,
    effort: clampEffort(requested, (catalog.models || []).find((m) => m.id === model), cfg['llm.offSpelling']),
  });
  const primary = explicitModel || cfg[`llm.models.${role}`];
  const fallback = !explicitModel && cfg['llm.fallbackModel'] && cfg['llm.fallbackModel'] !== primary ? cfg['llm.fallbackModel'] : null;
  // Attempts in order. A degraded primary is skipped while its cooldown lasts.
  const attempts = fallback
    ? (primaryDegraded(primary) ? [plan(fallback)] : [{ ...plan(primary), firstByteMs }, plan(fallback)])
    : [plan(primary)];
  return { cfg, attempts, primary, lane };
}

/**
 * Hold a lane slot for the duration of one chat()/chatStream() call. The lease covers every attempt
 * the call may make (primary, then fallback), each bounded by llm.timeoutMs, plus 30 s of slack, so
 * a slow primary followed by a slow fallback never outlives its slot. Time spent waiting for the
 * slot is reported to the running job (ledger/context.js laneWait) so it does not count against the
 * job's timeout (jobs.js runJob).
 */
async function takeLane(cfg, lane, signal, attemptCount = 1) {
  const limit = cfg[`llm.lanes.${lane}.concurrency`] ?? (lane === 'interactive' ? 2 : 1);
  const timeoutMs = cfg['llm.timeoutMs'] ?? 240_000;
  const leaseMs = Math.max((cfg['llm.lanes.leaseSec'] ?? 300) * 1000, timeoutMs * Math.max(1, attemptCount) + 30_000);
  const laneWait = currentContext()?.laneWait;
  laneWait?.pause();
  try {
    return await acquireLane(lane, { limit, leaseMs, maxWaitMs: timeoutMs, signal });
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError(errorText(err), { status: err?.status || 503, code: err?.code || 'lane_busy' });
  } finally {
    laneWait?.resume();
  }
}

/** The caller's signal combined with the running job's (jobs.js aborts it on timeout). */
function callSignal(explicit) {
  const ambient = currentContext()?.signal;
  if (explicit && ambient && explicit !== ambient) return AbortSignal.any([explicit, ambient]);
  return explicit || ambient || undefined;
}

function buildBody({ model, effort, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, stream }) {
  const body = { model, messages, stream: Boolean(stream) };
  if (effort) body.reasoning_effort = effort;
  if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (responseFormat) body.response_format = responseFormat;
  else if (json === true) body.response_format = { type: 'json_object' };
  else if (json && typeof json === 'object') {
    body.response_format = { type: 'json_schema', json_schema: { name: json.name || 'result', schema: json.schema || json, strict: json.strict === true } };
  }
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

class FirstByteTimeout extends Error {
  constructor(ms) { super(`no response within ${ms} ms`); this.name = 'FirstByteTimeout'; }
}

/** Worth trying the fallback model after this error? (Not for 4xx: the request itself is wrong.) */
function retryable(err) {
  if (err instanceof FirstByteTimeout) return true;
  if (err?.name === 'TimeoutError') return true;
  if (err instanceof LlmError) return err.status >= 500;
  return true; // connection-level failures
}

/**
 * POST one attempt and resolve once response headers arrive. `firstByteMs` bounds the wait for the
 * headers only; the overall `timeoutMs` bounds the whole exchange including the body.
 */
async function openAttempt({ cfg, attempt, body, signal, fetchFn, workflow }) {
  const overall = AbortSignal.timeout(cfg['llm.timeoutMs']);
  const firstByte = new AbortController();
  const signals = [overall, firstByte.signal];
  if (signal) signals.push(signal);
  let timer = null;
  if (attempt.firstByteMs) timer = setTimeout(() => firstByte.abort(new FirstByteTimeout(attempt.firstByteMs)), attempt.firstByteMs);
  try {
    const res = await fetchFn(`${cfg['llm.baseUrl'].replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(cfg['llm.apiKey'], gatewayHeaders(workflow)),
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    return res;
  } catch (err) {
    if (firstByte.signal.aborted) throw firstByte.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function errorText(err) {
  if (err?.name === 'TimeoutError') return 'timeout';
  return err?.message || String(err);
}

/**
 * One chat completion.
 * @param {object} opts
 * @param {string} [opts.userId]  owner, for budgets and logs (required when the feature has a budget)
 * @param {string} opts.feature   'triage'|'extraction'|'summary'|'ask'|'agent'|'insights'|'plugin'|…
 * @param {'fast'|'long'|'agent'} [opts.role]
 * @param {Array} opts.messages
 * @param {Array} [opts.tools]    OpenAI tool definitions
 * @param {boolean|object} [opts.json] true for json_object, or a JSON schema
 * @param {object} [opts.responseFormat] raw response_format (wins over json; runPrompt uses it)
 * @param {'interactive'|'background'} [opts.lane] default: the ambient lane (jobs are background)
 * @param {string} [opts.workflow] X-Workflow header (default: prompt id, else feature)
 * @param {{id, version, hash, tier}} [opts.prompt] provenance recorded with the call
 * @param {AbortSignal} [opts.signal] aborts the call; combined with the running job's signal
 * @param {string} [opts.budgetExempt] only for callers where no user can exist: why the call may
 *   run outside the per-user budget (see checkBudget). Ignored when userId is set.
 * @returns {Promise<{content: string|null, toolCalls: Array, usage: object, model: string, finishReason: string, fellBack: boolean, aiCallId: number|null, lane: string}>}
 */
export async function chat(opts) {
  const { userId, feature, pluginId, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, prompt, fetchFn = fetch } = opts;
  const signal = callSignal(opts.signal);
  const { cfg, attempts, primary, lane } = await prepare(opts);
  const workflow = opts.workflow || prompt?.id || (pluginId ? `plugin.${pluginId}` : feature);
  const releaseLane = await takeLane(cfg, lane, signal, attempts.length);
  try {
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const { model, effort } = attempt;
      const body = buildBody({ model, effort, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, stream: false });
      const releaseSlot = await acquire(model, cfg['llm.concurrency']);
      const started = Date.now();
      let error = null; let usage = {}; let result = null; let more = false; let output = null;
      try {
        const res = await openAttempt({ cfg, attempt, body, signal, fetchFn, workflow });
        const text = await res.text();
        if (!res.ok) throw new LlmError(`gateway ${res.status}: ${text.slice(0, 300)}`, { status: res.status >= 500 ? 502 : res.status });
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new LlmError('gateway returned invalid JSON'); }
        const choice = parsed.choices?.[0];
        if (!choice) throw new LlmError('gateway returned no choices');
        usage = parsed.usage || {};
        output = typeof choice.message?.content === 'string' ? choice.message.content : null;
        result = {
          content: output != null && /<\/?think>/i.test(output) ? stripThinking(output) : output,
          toolCalls: (choice.message?.tool_calls || []).map(normaliseToolCall),
          usage,
          model,
          finishReason: choice.finish_reason || 'stop',
          fellBack: model !== primary,
          lane,
        };
      } catch (err) {
        error = errorText(err);
        lastErr = err;
        more = i < attempts.length - 1 && !signal?.aborted && retryable(err);
      } finally {
        releaseSlot();
      }
      recordUsage(usage);
      const aiCallId = await logCall({
        userId, feature: pluginId ? 'plugin' : feature, pluginId, model, reasoning: effort, promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens, latencyMs: Date.now() - started, ok: Boolean(result), error,
        prompt, lane, workflow, keepTranscripts: cfg['llm.keepTranscripts'], messages, output,
      });
      if (result) return { ...result, aiCallId };
      if (more) {
        markDegraded(model, cfg['llm.fallbackCooldownSec']);
        console.warn(`[hedwig] model ${model} unavailable (${error}); falling back to ${attempts[i + 1].model} for ${cfg['llm.fallbackCooldownSec']} s`);
        continue;
      }
      if (lastErr instanceof LlmError) throw lastErr;
      throw new LlmError(error);
    }
    throw lastErr instanceof LlmError ? lastErr : new LlmError(errorText(lastErr));
  } finally {
    releaseLane();
  }
}

function normaliseToolCall(tc) {
  let args = {};
  const raw = tc.function?.arguments;
  if (raw && typeof raw === 'object') args = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { args = JSON.parse(raw); } catch { args = { _raw: raw }; }
  }
  return { id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: tc.function?.name, arguments: args };
}

/**
 * Streaming chat completion. Yields { type: 'delta', text } events (reasoning traces removed), then
 * a final { type: 'done', content, toolCalls, usage, finishReason, model, fellBack, aiCallId }.
 * Falls back only before the first response byte; a stream that has started is never switched.
 */
export async function* chatStream(opts) {
  const { userId, feature, pluginId, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, prompt, fetchFn = fetch } = opts;
  const signal = callSignal(opts.signal);
  const { cfg, attempts, primary, lane } = await prepare(opts);
  const workflow = opts.workflow || prompt?.id || (pluginId ? `plugin.${pluginId}` : feature);
  const releaseLane = await takeLane(cfg, lane, signal, attempts.length);
  const logBase = { userId, feature: pluginId ? 'plugin' : feature, pluginId, prompt, lane, workflow, keepTranscripts: cfg['llm.keepTranscripts'], messages };
  try {
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const { model, effort } = attempt;
      const body = buildBody({ model, effort, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, stream: true });
      const releaseSlot = await acquire(model, cfg['llm.concurrency']);
      const started = Date.now();
      let res;
      try {
        res = await openAttempt({ cfg, attempt, body, signal, fetchFn, workflow });
        if (!res.ok) {
          const text = await res.text();
          throw new LlmError(`gateway ${res.status}: ${text.slice(0, 300)}`, { status: res.status >= 500 ? 502 : res.status });
        }
      } catch (err) {
        const error = errorText(err);
        lastErr = err;
        releaseSlot();
        await logCall({ ...logBase, model, reasoning: effort, latencyMs: Date.now() - started, ok: false, error });
        if (i < attempts.length - 1 && !signal?.aborted && retryable(err)) {
          markDegraded(model, cfg['llm.fallbackCooldownSec']);
          console.warn(`[hedwig] model ${model} unavailable (${error}); falling back to ${attempts[i + 1].model} for ${cfg['llm.fallbackCooldownSec']} s`);
          continue;
        }
        if (err instanceof LlmError) throw err;
        throw new LlmError(error);
      }

      let raw = '';
      let usage = {};
      let ok = false; let error = null; let settled = false;
      const toolAcc = new Map();
      const filter = createThinkFilter();
      let finishReason = 'stop';
      try {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let evt;
            try { evt = JSON.parse(data); } catch { continue; }
            if (evt.usage) usage = evt.usage;
            const choice = evt.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta || {};
            if (typeof delta.content === 'string' && delta.content) {
              raw += delta.content;
              const visible = filter.push(delta.content);
              if (visible) yield { type: 'delta', text: visible };
            }
            for (const tc of delta.tool_calls || []) {
              const k = tc.index ?? 0;
              const acc = toolAcc.get(k) || { id: tc.id, function: { name: '', arguments: '' } };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
              toolAcc.set(k, acc);
            }
          }
        }
        const tail = filter.flush();
        if (tail) yield { type: 'delta', text: tail };
        ok = true;
        settled = true;
      } catch (err) {
        error = errorText(err);
        lastErr = err;
        settled = true;
      } finally {
        releaseSlot();
        // The consumer stopped reading mid-stream (client went away): still record the call.
        if (!settled) {
          recordUsage(usage);
          logCall({ ...logBase, model, reasoning: effort, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, latencyMs: Date.now() - started, ok: false, error: 'stream abandoned by the caller', output: raw });
        }
      }
      recordUsage(usage);
      const aiCallId = await logCall({
        ...logBase, model, reasoning: effort, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        latencyMs: Date.now() - started, ok, error, output: raw,
      });
      if (!ok) {
        if (lastErr instanceof LlmError) throw lastErr;
        throw new LlmError(error);
      }
      const content = /<\/?think>/i.test(raw) ? stripThinking(raw) : raw;
      yield { type: 'done', content, toolCalls: [...toolAcc.values()].map(normaliseToolCall), usage, finishReason, model, fellBack: model !== primary, aiCallId, lane };
      return;
    }
    throw lastErr instanceof LlmError ? lastErr : new LlmError(errorText(lastErr));
  } finally {
    releaseLane();
  }
}

/** Parse the first JSON object or array out of model text (tolerates code fences and preamble). */
export function extractJson(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Convenience: one JSON-mode call returning the parsed object (or null). */
export async function chatJson(opts) {
  const res = await chat({ ...opts, json: opts.json ?? true });
  return { ...res, data: extractJson(res.content) };
}

/** Test hook. */
export function _resetLlmState() {
  catalogCache = { url: null, data: null, expiry: 0 };
  semaphores.clear();
  degradedUntil.clear();
  exemptWarned.clear();
}
