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
import { acquireLane, runtimeRedis } from './prompts/lanes.js';
import { resolveInline, captureStack } from './prompts/inline.js';
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

// The PRD's names for the two model tiers, and the config role that picks each one's model.
// The agent role (tool calling) is Tier 2 work on its own model key.
export const TIER_INFO = Object.freeze({
  reflex: Object.freeze({ role: 'fast', label: 'Tier 1 Reflex', short: 'Reflex' }),
  reasoning: Object.freeze({ role: 'long', label: 'Tier 2 Reasoning', short: 'Reasoning' }),
});
const ROLE_TIER = { fast: 'reflex', long: 'reasoning', agent: 'reasoning' };
const TIER_ROLE = { reflex: 'fast', reasoning: 'long' };
/** The tier a config role belongs to. */
export const roleTier = (role) => ROLE_TIER[role] || 'reflex';

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
                                    prompt_id, prompt_version, prompt_hash, lane, tier, workflow, job_id, prompt_text, output_text, fell_back, escalated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [entry.userId || null, entry.feature, entry.pluginId || null, entry.model, entry.reasoning || null,
        entry.promptTokens ?? null, entry.completionTokens ?? null, entry.latencyMs ?? null, entry.ok, entry.error ? String(entry.error).slice(0, 500) : null,
        entry.prompt?.id || null, entry.prompt?.version || null, entry.prompt?.hash || null, entry.lane || null, entry.prompt?.tier || entry.tier || null,
        entry.workflow || null, currentJobId(),
        keep && entry.messages ? JSON.stringify(entry.messages).slice(0, TRANSCRIPT_MAX_CHARS) : null,
        keep && typeof entry.output === 'string' ? entry.output.slice(0, TRANSCRIPT_MAX_CHARS) : null,
        entry.fellBack === true, entry.escalated === true],
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

// ── Model health and fallback ───────────────────────────────────────────────
// When llm.fallbackModel is set, a call whose primary model gives no first token within the lane's
// wait (llm.lanes.interactive.fallbackAfterMs for interactive calls, llm.fallbackAfterMs for
// background ones), or fails with a 5xx or connection error, is retried once on the fallback.
//
// A model is DEGRADED when:
//   - the periodic probe (probeModels, a tiny completion with llm.probe.timeoutMs, scheduled in the
//     worker every llm.probe.everySec) got no answer llm.probe.degradeAfter times in a row, or the
//     catalog lists it offline (source 'probe' / 'catalog'); it stays degraded until
//     llm.probe.recoverAfter probes in a row answer;
//   - or a real call just timed out or failed on it (source 'call'), for llm.fallbackCooldownSec
//     or until the probe sees it answer again, whichever comes first.
// While the primary is degraded, calls go straight to the fallback, so no call pays the wait.
// Health is kept per process and mirrored in Redis (hedwig:model-health:<model>), so the worker's
// probe and the API's /status agree and a call that fails in one process spares the other.
const health = new Map(); // model -> record (see blankHealth)
const HEALTH_KEY = 'hedwig:model-health:';
const HEALTH_TTL_SEC = 1800;
const HEALTH_SYNC_MS = 5000;
let lastHealthSync = 0;
const probing = new Map(); // model -> in-flight probe promise
let lastProbeRun = 0;

function blankHealth(model) {
  return {
    model, degraded: false, source: null, reason: null, since: 0, until: 0,
    checkedAt: 0, probedAt: 0, latencyMs: null, okStreak: 0, failStreak: 0, lastOkAt: 0, lastError: null, updatedAt: 0,
  };
}

function healthOf(model) {
  let h = health.get(model);
  if (!h) { h = blankHealth(model); health.set(model, h); }
  return h;
}

/** Is this model degraded right now (probe verdict, catalog, or a recent failed call)? */
export function primaryDegraded(model, now = Date.now()) {
  const h = health.get(model);
  if (!h || !h.degraded) return false;
  if (h.source === 'call') return h.until > now;
  return true;
}

function publishHealth(h) {
  const record = JSON.stringify(h);
  runtimeRedis({ waitMs: 0 })
    .then((c) => (c && typeof c.set === 'function' ? c.set(HEALTH_KEY + h.model, record, { EX: HEALTH_TTL_SEC }) : null))
    .catch(() => {});
}

/** Pull other processes' verdicts for these models from Redis (throttled; never throws). */
async function syncHealth(models, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastHealthSync < HEALTH_SYNC_MS) return;
  lastHealthSync = now;
  const list = [...new Set(models.filter(Boolean))];
  if (!list.length) return;
  try {
    const c = await runtimeRedis({ waitMs: 0 });
    if (!c || typeof c.mGet !== 'function') return;
    const values = await c.mGet(list.map((m) => HEALTH_KEY + m));
    (values || []).forEach((v, i) => {
      if (!v) return;
      let remote;
      try { remote = JSON.parse(v); } catch { return; }
      const h = healthOf(list[i]);
      if ((Number(remote.updatedAt) || 0) > h.updatedAt) Object.assign(h, remote, { model: list[i] });
    });
  } catch { /* health sharing is best effort */ }
}

function markDegraded(model, cooldownSec, reason) {
  const h = healthOf(model);
  const now = Date.now();
  if (!primaryDegraded(model, now)) h.since = now;
  h.degraded = true;
  if (h.source !== 'probe' && h.source !== 'catalog') h.source = 'call';
  h.until = Math.max(h.source === 'call' ? h.until : 0, now + (Number(cooldownSec) || 300) * 1000);
  h.reason = reason ? String(reason).slice(0, 200) : h.reason;
  h.okStreak = 0;
  h.updatedAt = now;
  publishHealth(h);
}

/** The models the probe watches: every configured role model, the fallback, and the enabled set. */
function probeTargets(cfg) {
  const enabled = Array.isArray(cfg['llm.models.enabled']) ? cfg['llm.models.enabled'] : [];
  return [...new Set([cfg['llm.models.fast'], cfg['llm.models.long'], cfg['llm.models.agent'], cfg['llm.fallbackModel'], ...enabled].filter((m) => typeof m === 'string' && m))];
}

const OFFLINE = /^(offline|disabled|error|down|unavailable)$/i;

/** One probe: a tiny completion outside the lanes, not logged to hedwig_ai_calls. */
async function probeOne(model, cfg, catalog, fetchFn) {
  const info = (catalog?.models || []).find((m) => m.id === model) || null;
  const timeoutMs = Number(cfg['llm.probe.timeoutMs']) || 10_000;
  const started = Date.now();
  healthOf(model).probedAt = started;
  let ok = false; let error = null; let source = 'probe';
  // The catalog is a hint, never a verdict: on 2026-09-24 it listed Gemma as offline while the model
  // answered in 200 ms, and Tier 1 fell back to rules for hours. So a model the catalog calls
  // offline is still probed, and an answer wins; the catalog's word only labels a failed probe.
  const catalogSaysOffline = Boolean(info && ((info.status && OFFLINE.test(String(info.status))) || info.disabled_at));
  {
    // The smallest request that proves the model answers: one output token, no reasoning, streamed,
    // and the connection dropped after the first chunk. It measures time to the first token (the
    // PRD's Tier 2 target), and a probe that gives up closes its request. A gateway may still leave
    // an abandoned request queued on a busy model server, so degraded models are probed less often
    // (probeDue, llm.probe.degradedEverySec).
    const body = { model, messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 1, temperature: 0, stream: true };
    const effort = clampEffort('off', info, cfg['llm.offSpelling']);
    if (effort) body.reasoning_effort = effort;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { name: 'ProbeTimeout' })), timeoutMs);
    try {
      const res = await fetchFn(`${cfg['llm.baseUrl'].replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: authHeaders(cfg['llm.apiKey'], gatewayHeaders('runtime.probe')),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        await reader.read(); // the first chunk, or the end of an empty answer: either way it answered
        reader.cancel().catch(() => {});
        ok = true;
      } else {
        await res.text().catch(() => '');
        // A 4xx other than not-found/overloaded means the model answered and disliked the probe.
        ok = res.ok || (res.status >= 400 && res.status < 500 && ![404, 408, 429].includes(res.status));
        if (!ok) error = `answered ${res.status}`;
      }
    } catch (err) {
      error = controller.signal.aborted ? `no answer within ${timeoutMs} ms` : errorText(err);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (!ok && catalogSaysOffline) {
      error = `the gateway catalog lists it as ${info.status || 'disabled'} and it did not answer (${error})`;
      source = 'catalog';
    }
  }
  const now = Date.now();
  const latencyMs = now - started;
  const h = healthOf(model);
  h.checkedAt = now;
  h.updatedAt = now;
  if (ok) {
    h.latencyMs = latencyMs; h.okStreak++; h.failStreak = 0; h.lastOkAt = now; h.lastError = null;
    const recoverAfter = Math.max(1, Number(cfg['llm.probe.recoverAfter']) || 2);
    if (h.degraded && (h.okStreak >= recoverAfter || (h.source === 'call' && h.until <= now))) {
      console.warn(`[hedwig] model ${model} answers again (${latencyMs} ms); traffic returns to it`);
      Object.assign(h, { degraded: false, source: null, reason: null, since: 0, until: 0 });
    }
  } else {
    h.latencyMs = null; h.failStreak++; h.okStreak = 0; h.lastError = error;
    const degradeAfter = Math.max(1, Number(cfg['llm.probe.degradeAfter']) || 1);
    if (h.failStreak >= degradeAfter) {
      const was = primaryDegraded(model, now);
      if (!was) h.since = now;
      if (!was || h.source === 'call') {
        console.warn(`[hedwig] model ${model} degraded (${error}); calls go to the fallback until it answers again`);
      }
      Object.assign(h, { degraded: true, source, reason: error, until: 0 });
    }
  }
  publishHealth(h);
  return { model, ok, latencyMs: ok ? latencyMs : null, error, degraded: primaryDegraded(model, now) };
}

/**
 * How often a model is expected to be probed: every llm.probe.everySec, but a degraded model whose
 * last probe (or call) failed only every llm.probe.degradedEverySec. On a saturated server an
 * abandoned probe can still queue and run, so probing it every minute would add to the queue that
 * made it slow. A degraded model that answered its last probe is probed at the normal pace, so
 * recovery (llm.probe.recoverAfter answers in a row) is not slowed down.
 */
function probeEveryMs(model, cfg, now = Date.now()) {
  const every = (Number(cfg['llm.probe.everySec']) || 60) * 1000;
  const h = health.get(model);
  if (!h || !primaryDegraded(model, now) || h.source === 'catalog' || h.okStreak > 0) return every;
  return Math.max(every, (Number(cfg['llm.probe.degradedEverySec']) || 300) * 1000);
}

/**
 * Is a probe of this model due? Measured from when the last probe started (another process's
 * probe, shared through Redis, counts), so the API's opportunistic probe and the worker's schedule
 * never double up, and a degraded model backs off (probeEveryMs). The worker's schedule ticks every
 * 15 s (ledger/schedules.js) and this decides, so an admin change to llm.probe.everySec applies
 * without a restart; the slack absorbs the worker loop's tick jitter.
 */
function probeDue(model, cfg, now = Date.now()) {
  const h = health.get(model);
  const last = h ? (h.probedAt || h.checkedAt) : 0;
  if (!last) return true;
  return now - last >= probeEveryMs(model, cfg, now) - 3000;
}

/**
 * Probe every watched model that is due (the worker schedules this every llm.probe.everySec; see
 * probeDue for the back-off). `force` (the admin's "probe now") probes every model. Concurrent
 * calls share the probe in flight per model. Never throws.
 * @returns {Promise<{ at?: string, models?: Array<{ model, ok, latencyMs, error, degraded, skipped? }>, skipped?: string }>}
 */
export async function probeModels({ fetchFn = fetch, force = false } = {}) {
  let cfg;
  try { cfg = await getConfig(); } catch (err) { return { skipped: errorText(err) }; }
  if (!cfg.enabled || !cfg['llm.baseUrl']) return { skipped: 'model features are disabled' };
  if (cfg['llm.probe.enabled'] === false && !force) return { skipped: 'llm.probe.enabled is off' };
  const targets = probeTargets(cfg);
  await syncHealth(targets, { force: true });
  const catalog = await getCatalog({ fetchFn }).catch(() => ({ models: [] }));
  const now = Date.now();
  const models = await Promise.all(targets.map((model) => {
    if (probing.has(model)) return probing.get(model);
    if (!force && !probeDue(model, cfg, now)) {
      const h = health.get(model);
      return { model, ok: null, latencyMs: h?.latencyMs ?? null, error: h?.lastError ?? null, degraded: primaryDegraded(model, now), skipped: primaryDegraded(model, now) ? 'backoff' : 'recent' };
    }
    const p = probeOne(model, cfg, catalog, fetchFn).finally(() => probing.delete(model));
    probing.set(model, p);
    return p;
  }));
  lastProbeRun = Date.now();
  return { at: new Date(lastProbeRun).toISOString(), models };
}

/** Before the first verdict on a model exists anywhere (this process or Redis), probe once. */
async function firstProbe(model, cfg, fetchFn) {
  if (!model || cfg['llm.probe.enabled'] !== true) return;
  if (health.get(model)?.checkedAt) return;
  await syncHealth([model], { force: true });
  if (health.get(model)?.checkedAt) return;
  await probeModels(fetchFn ? { fetchFn } : {}).catch(() => {});
}

/** Health records for these models (after a Redis sync), for admin pages. */
export async function modelHealth(models) {
  await syncHealth(models);
  const now = Date.now();
  return Object.fromEntries(models.map((m) => {
    const h = health.get(m) || blankHealth(m);
    return [m, {
      degraded: primaryDegraded(m, now), source: primaryDegraded(m, now) ? h.source : null, reason: primaryDegraded(m, now) ? h.reason : null,
      since: h.since && primaryDegraded(m, now) ? new Date(h.since).toISOString() : null,
      checkedAt: h.checkedAt ? new Date(h.checkedAt).toISOString() : null, latencyMs: h.latencyMs, lastError: h.lastError,
      lastOkAt: h.lastOkAt ? new Date(h.lastOkAt).toISOString() : null,
    }];
  }));
}

/** Which model currently serves each role, for status pages. Shape kept for the v2 settings page. */
export async function activeModels(userId) {
  const cfg = await getConfig(userId);
  const fallback = cfg['llm.fallbackModel'];
  await syncHealth(probeTargets(cfg));
  return Object.fromEntries(ROLES.map((role) => {
    const primary = cfg[`llm.models.${role}`];
    const degraded = primaryDegraded(primary);
    const usable = Boolean(fallback) && fallback !== primary;
    return [role, { primary, fallback: fallback || null, active: degraded && usable ? fallback : primary, degraded }];
  }));
}

function tierNotice(reflex, reasoning) {
  if (reasoning.degraded && reasoning.active !== reasoning.model) {
    return { level: 'warning', tier: 'reasoning', text: 'Tier 2 is slow; using the lighter model', detail: `${reasoning.model}: ${reasoning.reason || 'not answering'}. ${reasoning.active} answers Tier 2 work until it recovers.` };
  }
  if (reasoning.degraded) return { level: 'warning', tier: 'reasoning', text: 'Tier 2 is not answering', detail: `${reasoning.model}: ${reasoning.reason || 'not answering'}. No fallback model is set.` };
  if (reflex.degraded) return { level: 'error', tier: 'reflex', text: 'Tier 1 is not answering; rules and classifiers sort until it is back', detail: `${reflex.model}: ${reflex.reason || 'not answering'}.` };
  return null;
}

/**
 * What serves each tier right now, for /api/hedwig/status and the admin pages:
 *   { reflex:    { tier, label, role, model, fallback, active, degraded, lighterModel, reason, since, checkedAt, latencyMs },
 *     reasoning: { … }, agent: { … }, notice: { level, tier, text, detail } | null,
 *     probe: { enabled, everySec, timeoutMs, lastRunAt } }
 * `lighterModel` is true when Tier 2 work is being answered by the fallback. When the probe is on
 * and no process has probed recently (the worker is down, or a dev box), this kicks one off in the
 * background so the next read is current.
 */
export async function tierStatus(userId = null, { fetchFn } = {}) {
  const cfg = await getConfig(userId);
  const targets = probeTargets(cfg);
  await syncHealth(targets);
  const now = Date.now();
  const fallback = cfg['llm.fallbackModel'] || null;
  const describe = (tier, role, label) => {
    const model = cfg[`llm.models.${role}`] || null;
    const fb = fallback && fallback !== model ? fallback : null;
    const h = health.get(model) || blankHealth(model);
    const degraded = primaryDegraded(model, now);
    const active = degraded && fb ? fb : model;
    return {
      tier, label, role, model, fallback: fb, active, degraded,
      lighterModel: tier === 'reasoning' && active !== model,
      reason: degraded ? h.reason : null,
      source: degraded ? h.source : null,
      since: degraded && h.since ? new Date(h.since).toISOString() : null,
      checkedAt: h.checkedAt ? new Date(h.checkedAt).toISOString() : null,
      latencyMs: h.latencyMs ?? null,
    };
  };
  const reflex = describe('reflex', 'fast', TIER_INFO.reflex.label);
  const reasoning = describe('reasoning', 'long', TIER_INFO.reasoning.label);
  const agent = describe('reasoning', 'agent', 'Agent (Tier 2, tool calling)');
  const everySec = Number(cfg['llm.probe.everySec']) || 60;
  const enabled = cfg['llm.probe.enabled'] !== false && Boolean(cfg.enabled && cfg['llm.baseUrl']);
  // Only when the key is really on (the schema default), not merely absent from a test's config.
  if (enabled && cfg['llm.probe.enabled'] === true && targets.some((m) => !((health.get(m)?.checkedAt || 0) > now - 3 * probeEveryMs(m, cfg, now)))) {
    probeModels(fetchFn ? { fetchFn } : {}).catch(() => {});
  }
  const probedAt = Math.max(lastProbeRun, ...targets.map((m) => health.get(m)?.checkedAt || 0));
  return {
    reflex, reasoning, agent,
    notice: tierNotice(reflex, reasoning),
    probe: { enabled, everySec, timeoutMs: Number(cfg['llm.probe.timeoutMs']) || 10_000, lastRunAt: probedAt ? new Date(probedAt).toISOString() : null },
  };
}

/**
 * Everything a call needs decided before it goes out: config, budget, lane, the prompt it records,
 * the role (after routing), and the attempts in order.
 */
async function prepare(opts) {
  const { userId, feature, pluginId, model: explicitModel, reasoning, lane: requestedLane, fetchFn, budgetExempt } = opts;
  let role = opts.role || 'fast';
  const cfg = await getConfig(userId);
  if (!cfg.enabled) throw new LlmDisabledError('Hedwig intelligence is disabled');
  if (!cfg['llm.baseUrl']) throw new LlmDisabledError('no model gateway configured');
  if (!ROLES.includes(role)) throw new LlmError(`unknown model role ${role}`, { status: 400 });
  await checkBudget(cfg, userId, feature, pluginId, budgetExempt);
  const lane = currentLane(requestedLane);

  // Provenance for callers that did not pass a registered prompt (prompts/inline.js). Their tier
  // follows routing.<feature>.tier like registered prompts do, then the inline entry's own tier,
  // then the role the caller asked for. Plugins, explicit models and the agent role keep theirs.
  let prompt = opts.prompt || null;
  if (!prompt) {
    const site = resolveInline({ feature, pluginId, workflow: opts.workflow, messages: opts.messages, stack: opts.stack });
    if (!explicitModel && !pluginId && role !== 'agent') {
      const override = cfg[`routing.${feature}.tier`];
      const tier = override === 'reflex' || override === 'reasoning' ? override : site.tier;
      if (tier && TIER_ROLE[tier]) role = TIER_ROLE[tier];
    }
    prompt = { id: site.id, version: site.version, hash: site.hash, tier: roleTier(role), inline: true };
  }
  const tier = prompt.tier || roleTier(role);

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
  // Right after a start nothing has probed yet, and "never checked" reads as healthy: a Tier 2 call
  // would pay the whole first-token wait on a model that is not answering and leave its request
  // queued there. Wait for the first probe (bounded by llm.probe.timeoutMs) instead.
  if (!explicitModel && (opts.noFallback || (cfg['llm.fallbackModel'] && cfg['llm.fallbackModel'] !== primary))) {
    await firstProbe(primary, cfg, fetchFn);
  }
  // noFallback: the caller needs this tier's own model (the labels judge must be a different model
  // from Reflex), so a degraded primary fails at once with tier_degraded instead of the fallback
  // answering or the call waiting out the first-token wait.
  if (opts.noFallback && !explicitModel) {
    await syncHealth([primary]);
    if (primaryDegraded(primary)) {
      const h = health.get(primary);
      throw new LlmError(`${TIER_INFO[roleTier(role)]?.label || role} model ${primary} is degraded (${h?.reason || 'not answering'})`, { status: 503, code: 'tier_degraded' });
    }
  }
  let fallback = !explicitModel && !opts.noFallback && cfg['llm.fallbackModel'] && cfg['llm.fallbackModel'] !== primary ? cfg['llm.fallbackModel'] : null;
  // A call that offers tools cannot fall back to a model the catalog says has no tool calling
  // (Gemma): with a degraded primary it fails at once instead of waiting out llm.timeoutMs.
  if (fallback && Array.isArray(opts.tools) && opts.tools.length) {
    const caps = (catalog.models || []).find((m) => m.id === fallback)?.capabilities;
    if (Array.isArray(caps) && caps.length && !caps.includes('tools')) {
      fallback = null;
      await syncHealth([primary]);
      if (primaryDegraded(primary)) {
        throw new LlmError(`model ${primary} is degraded (${health.get(primary)?.reason || 'not answering'}) and the fallback ${cfg['llm.fallbackModel']} cannot call tools`, { status: 503, code: 'tier_degraded' });
      }
    }
  }
  if (fallback) await syncHealth([primary, fallback]);
  // Attempts in order. A degraded primary is skipped until the probe (or its cooldown) clears it.
  const attempts = fallback
    ? (primaryDegraded(primary) ? [plan(fallback)] : [{ ...plan(primary), firstByteMs }, plan(fallback)])
    : [plan(primary)];
  const workflow = opts.workflow || (pluginId ? `plugin.${pluginId}` : prompt.id || feature);
  return { cfg, attempts, primary, lane, prompt, tier, role, catalog, workflow, lighterModelFor: cfg['llm.models.fast'] };
}

/** The tier whose configured model produced an answer, and whether Tier 2 work got the lighter model. */
function servedBy(ctx, model) {
  const fellBack = model !== ctx.primary;
  const servedTier = model === ctx.cfg['llm.models.long'] || model === ctx.cfg['llm.models.agent'] ? 'reasoning'
    : model === ctx.cfg['llm.models.fast'] ? 'reflex' : ctx.tier;
  return { tier: ctx.tier, servedTier, fellBack, lighterModel: ctx.tier === 'reasoning' && fellBack };
}

/** Stream internally when a first-token wait applies, so a slow answer is not mistaken for no answer. */
function wantsStream(ctx) {
  const first = ctx.attempts[0];
  if (!first?.firstByteMs || ctx.attempts.length < 2) return false;
  if (ctx.cfg['llm.stream.firstToken'] === false) return false;
  const info = (ctx.catalog?.models || []).find((m) => m.id === first.model);
  return Array.isArray(info?.capabilities) && info.capabilities.includes('streaming');
}

// How long a call waits for a lane slot when llm.lanes.<lane>.waitMs is not set.
export const LANE_WAIT_DEFAULTS = { interactive: 30_000, background: 20 * 60_000 };

/**
 * Hold a lane slot for the duration of one chat()/chatStream() call. The lease covers every attempt
 * the call may make (primary, then fallback), each bounded by llm.timeoutMs, plus 30 s of slack, so
 * a slow primary followed by a slow fallback never outlives its slot. Time spent waiting for the
 * slot is reported to the running job (ledger/context.js laneWait) so it does not count against the
 * job's timeout (jobs.js runJob).
 *
 * The wait is bounded by llm.lanes.<lane>.waitMs: 30 s for interactive calls (a person is waiting;
 * the call then fails fast with lane_busy, 503 — the fallback model shares the lane, so switching
 * models would not find a slot either), 20 min for background calls (a job then gets lane_busy,
 * which runJob turns into a deferral, attempts untouched).
 */
async function takeLane(cfg, lane, signal, attemptCount = 1) {
  const limit = cfg[`llm.lanes.${lane}.concurrency`] ?? (lane === 'interactive' ? 2 : 1);
  const timeoutMs = cfg['llm.timeoutMs'] ?? 240_000;
  const leaseMs = Math.max((cfg['llm.lanes.leaseSec'] ?? 300) * 1000, timeoutMs * Math.max(1, attemptCount) + 30_000);
  const configured = Number(cfg[`llm.lanes.${lane}.waitMs`]);
  const maxWaitMs = Number.isFinite(configured) && configured > 0 ? configured : (LANE_WAIT_DEFAULTS[lane] ?? timeoutMs);
  const laneWait = currentContext()?.laneWait;
  laneWait?.pause();
  try {
    return await acquireLane(lane, { limit, leaseMs, maxWaitMs, signal });
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
 * With `untilFirstChunk` (streams) the first-byte timer keeps running after the headers until the
 * caller calls `firstChunk()`: a server that sends headers at once and then queues the request
 * (vLLM without LiteLLM in front, the mock gateway) still falls back when no token comes.
 * @returns {Promise<{ res: Response, firstChunk: () => void, timedOut: () => boolean }>}
 */
async function openAttempt({ cfg, attempt, body, signal, fetchFn, workflow, untilFirstChunk = false }) {
  const overall = AbortSignal.timeout(cfg['llm.timeoutMs']);
  const firstByte = new AbortController();
  const signals = [overall, firstByte.signal];
  if (signal) signals.push(signal);
  let timer = null;
  const stop = () => { clearTimeout(timer); timer = null; };
  if (attempt.firstByteMs) timer = setTimeout(() => firstByte.abort(new FirstByteTimeout(attempt.firstByteMs)), attempt.firstByteMs);
  let keep = false;
  try {
    const res = await fetchFn(`${cfg['llm.baseUrl'].replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(cfg['llm.apiKey'], gatewayHeaders(workflow)),
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    keep = untilFirstChunk && res.ok;
    return { res, firstChunk: stop, timedOut: () => firstByte.signal.aborted };
  } catch (err) {
    if (firstByte.signal.aborted) throw firstByte.signal.reason;
    throw err;
  } finally {
    if (!keep) stop();
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
 * @param {string} [opts.workflow] X-Workflow header (default: prompt id, else the inline prompt id)
 * @param {{id, version, hash, tier}} [opts.prompt] provenance recorded with the call; without it the
 *   call is resolved to an inline prompt (prompts/inline.js) and routed by routing.<feature>.tier
 * @param {boolean} [opts.escalated] recorded on the call (runPrompt sets it for escalations)
 * @param {boolean} [opts.noFallback] never answer from the fallback model; a degraded primary
 *   throws LlmError code 'tier_degraded' (503) at once, which jobs defer rather than fail
 * @param {AbortSignal} [opts.signal] aborts the call; combined with the running job's signal
 * @param {string} [opts.budgetExempt] only for callers where no user can exist: why the call may
 *   run outside the per-user budget (see checkBudget). Ignored when userId is set.
 * @returns {Promise<{content: string|null, toolCalls: Array, usage: object, model: string, finishReason: string, fellBack: boolean,
 *   aiCallId: number|null, lane: string, tier: string, servedTier: string, lighterModel: boolean}>}
 */
export async function chat(opts) {
  const stack = opts.prompt ? null : captureStack();
  const { userId, feature, pluginId, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, fetchFn = fetch } = opts;
  const signal = callSignal(opts.signal);
  const ctx = await prepare({ ...opts, stack });
  const { cfg, attempts, lane, prompt, workflow } = ctx;
  if (wantsStream(ctx)) {
    // Same call, streamed: the fallback wait then measures the first token, not the whole answer.
    let done = null;
    for await (const ev of runStream(opts, ctx, signal)) if (ev.type === 'done') done = ev;
    if (!done) throw new LlmError('the model stream ended without a result');
    const result = { ...done };
    delete result.type;
    return result;
  }
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
        const { res } = await openAttempt({ cfg, attempt, body, signal, fetchFn, workflow });
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
          lane,
          ...servedBy(ctx, model),
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
        fellBack: model !== ctx.primary, escalated: opts.escalated,
      });
      if (result) return { ...result, aiCallId };
      if (more) {
        markDegraded(model, cfg['llm.fallbackCooldownSec'], error);
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
 * a final { type: 'done', content, toolCalls, usage, finishReason, model, fellBack, aiCallId, lane,
 * tier, servedTier, lighterModel }.
 * Falls back only before the first response byte; a stream that has started is never switched.
 */
export async function* chatStream(opts) {
  const stack = opts.prompt ? null : captureStack();
  const signal = callSignal(opts.signal);
  const ctx = await prepare({ ...opts, stack });
  yield* runStream(opts, ctx, signal);
}

async function* runStream(opts, ctx, signal) {
  const { userId, feature, pluginId, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, fetchFn = fetch } = opts;
  const { cfg, attempts, lane, prompt, workflow } = ctx;
  const releaseLane = await takeLane(cfg, lane, signal, attempts.length);
  const logBase = { userId, feature: pluginId ? 'plugin' : feature, pluginId, prompt, lane, workflow, keepTranscripts: cfg['llm.keepTranscripts'], messages, escalated: opts.escalated };
  try {
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const { model, effort } = attempt;
      const fellBack = model !== ctx.primary;
      const body = buildBody({ model, effort, messages, tools, toolChoice, json, responseFormat, maxTokens, temperature, stream: true });
      const releaseSlot = await acquire(model, cfg['llm.concurrency']);
      const started = Date.now();
      let res; let firstChunk = () => {}; let timedOut = () => false;
      try {
        ({ res, firstChunk, timedOut } = await openAttempt({ cfg, attempt, body, signal, fetchFn, workflow, untilFirstChunk: true }));
        if (!res.ok) {
          const text = await res.text();
          throw new LlmError(`gateway ${res.status}: ${text.slice(0, 300)}`, { status: res.status >= 500 ? 502 : res.status });
        }
      } catch (err) {
        const error = errorText(err);
        lastErr = err;
        releaseSlot();
        await logCall({ ...logBase, model, reasoning: effort, latencyMs: Date.now() - started, ok: false, error, fellBack });
        if (i < attempts.length - 1 && !signal?.aborted && retryable(err)) {
          markDegraded(model, cfg['llm.fallbackCooldownSec'], error);
          console.warn(`[hedwig] model ${model} unavailable (${error}); falling back to ${attempts[i + 1].model} for ${cfg['llm.fallbackCooldownSec']} s`);
          continue;
        }
        if (err instanceof LlmError) throw err;
        throw new LlmError(error);
      }

      let raw = '';
      let usage = {};
      let ok = false; let error = null; let settled = false; let yielded = false; let retry = false;
      const toolAcc = new Map();
      const filter = createThinkFilter();
      let finishReason = 'stop';
      try {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          if (!yielded) firstChunk();
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
              if (visible) { yielded = true; yield { type: 'delta', text: visible }; }
            }
            for (const tc of delta.tool_calls || []) {
              const k = tc.index ?? 0;
              const acc = toolAcc.get(k) || { id: tc.id, function: { name: '', arguments: '' } };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (tc.function?.arguments) {
                acc.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
              }
              toolAcc.set(k, acc);
            }
          }
        }
        const tail = filter.flush();
        if (tail) yield { type: 'delta', text: tail };
        ok = true;
        settled = true;
      } catch (err) {
        // Headers came but no token did within the first-token wait: nothing reached the caller
        // yet, so the fallback may still answer.
        const noToken = timedOut() && !yielded;
        error = noToken ? `no first token within ${attempt.firstByteMs} ms` : errorText(err);
        lastErr = noToken ? new FirstByteTimeout(attempt.firstByteMs) : err;
        retry = noToken && i < attempts.length - 1 && !signal?.aborted;
        settled = true;
      } finally {
        firstChunk();
        releaseSlot();
        // The consumer stopped reading mid-stream (client went away): still record the call.
        if (!settled) {
          recordUsage(usage);
          logCall({ ...logBase, model, reasoning: effort, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, latencyMs: Date.now() - started, ok: false, error: 'stream abandoned by the caller', output: raw, fellBack });
        }
      }
      recordUsage(usage);
      const aiCallId = await logCall({
        ...logBase, model, reasoning: effort, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        latencyMs: Date.now() - started, ok, error, output: raw, fellBack,
      });
      if (!ok && retry) {
        markDegraded(model, cfg['llm.fallbackCooldownSec'], error);
        console.warn(`[hedwig] model ${model} unavailable (${error}); falling back to ${attempts[i + 1].model} for ${cfg['llm.fallbackCooldownSec']} s`);
        continue;
      }
      if (!ok) {
        if (lastErr instanceof LlmError) throw lastErr;
        throw new LlmError(error);
      }
      const content = /<\/?think>/i.test(raw) ? stripThinking(raw) : raw;
      yield {
        type: 'done', content, toolCalls: [...toolAcc.values()].map(normaliseToolCall), usage, finishReason, model, aiCallId, lane,
        ...servedBy(ctx, model),
      };
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
  health.clear();
  probing.clear();
  lastHealthSync = 0;
  lastProbeRun = 0;
  exemptWarned.clear();
}
