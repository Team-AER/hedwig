// Admin API for the model runtime: which model serves each tier and with what effort, lanes,
// fallback, probe, budgets; the gateway catalog with capabilities and health; and usage per
// feature per tier per day from hedwig_ai_calls. Routes in ledger/routes.js (mounted by core under
// /api/hedwig/admin, requireAdmin applied). The per-feature routing table (routing.<feature>.tier,
// escalation, budgets) is onboarding/routing.js (GET/PUT /admin/routing), and the models users
// may pick is GET/PUT /admin/models/enabled there too; this file does not duplicate them.
import { query } from '../../services/db.js';
import { getConfig, describeConfig, saveSystemConfig, SCHEMA } from '../config.js';
import { getCatalog, clampEffort, modelHealth, tierStatus, TIER_INFO } from '../llm.js';

const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];
const ROLE_OF = { reflex: 'fast', reasoning: 'long', agent: 'agent' };
const labelOf = (tier) => (tier === 'agent' ? 'Agent (Tier 2, tool calling)' : TIER_INFO[tier].label);

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const normEffort = (e) => (e === 'none' ? 'off' : e);

/**
 * GET /admin/models/catalog: the catalog, one entry per model, with capabilities spelled out and
 * the admin's view of it (roles, fallback, enabled, health). A superset of GET /admin/catalog.
 */
export async function catalogView({ refresh = false, cfg: given = null } = {}) {
  const cfg = given || await getConfig(null);
  const cat = await getCatalog({ force: refresh });
  const models = (cat?.models || []).filter((m) => m && m.id);
  const enabled = new Set(Array.isArray(cfg['llm.models.enabled']) ? cfg['llm.models.enabled'].map(String) : []);
  const health = await modelHealth(models.map((m) => m.id));
  return {
    generatedAt: cat?.generated_at || null,
    models: models.map((m) => {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      const roles = ['fast', 'long', 'agent'].filter((r) => cfg[`llm.models.${r}`] === m.id);
      return {
        // The raw catalog fields first (display_name, reasoning_efforts, max_output_tokens, …), so
        // this is a superset of GET /admin/catalog and a client written for either shape works.
        ...m,
        id: m.id,
        displayName: m.display_name || m.id,
        node: m.node || null,
        status: m.status || null,
        disabledAt: m.disabled_at || null,
        capabilities: caps,
        chat: caps.length ? caps.includes('chat') : true,
        tools: caps.includes('tools'),
        reasoning: caps.includes('reasoning'),
        streaming: caps.includes('streaming'),
        embeddings: caps.includes('embeddings'),
        contextWindow: m.context_window ?? null,
        maxOutputTokens: m.max_output_tokens ?? null,
        reasoningEfforts: [...new Set((Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : []).map(normEffort))].filter((e) => EFFORTS.includes(e)),
        defaultReasoningEffort: m.default_reasoning_effort ? normEffort(m.default_reasoning_effort) : null,
        roles,
        tiers: roles.map((r) => (r === 'fast' ? 'reflex' : r === 'long' ? 'reasoning' : 'agent')),
        fallback: cfg['llm.fallbackModel'] === m.id,
        enabled: enabled.has(m.id),
        health: health[m.id] || null,
      };
    }),
  };
}

function budgetFeatures() {
  const out = new Map();
  for (const f of SCHEMA) {
    const m = /^llm\.(tokenBudget|dailyBudget)\.(.+)$/.exec(f.key);
    if (!m) continue;
    if (!out.has(m[2])) out.set(m[2], {});
    out.get(m[2])[m[1] === 'tokenBudget' ? 'tokensKey' : 'callsKey'] = f.key;
  }
  return out;
}

/**
 * GET /admin/runtime: everything the admin decides about the runtime, with where each value came
 * from (default | env | admin) so the settings page can offer "reset".
 */
export async function runtimeSettings() {
  const cfg = await getConfig(null);
  const described = new Map((await describeConfig(null)).map((f) => [f.key, f]));
  const src = (key) => described.get(key)?.source || 'default';
  const cat = await getCatalog();
  const info = (id) => (cat?.models || []).find((m) => m.id === id) || null;
  const tiers = {};
  for (const tier of ['reflex', 'reasoning', 'agent']) {
    const role = ROLE_OF[tier];
    const model = cfg[`llm.models.${role}`];
    const m = info(model);
    const effort = cfg[`llm.reasoning.${role}`];
    tiers[tier] = {
      label: labelOf(tier), role,
      modelKey: `llm.models.${role}`, model, modelSource: src(`llm.models.${role}`),
      effortKey: `llm.reasoning.${role}`, effort, effortSource: src(`llm.reasoning.${role}`),
      efforts: m && Array.isArray(m.reasoning_efforts) ? [...new Set(m.reasoning_efforts.map(normEffort))].filter((e) => EFFORTS.includes(e)) : EFFORTS,
      wireEffort: clampEffort(effort, m, cfg['llm.offSpelling']) ?? null,
      inCatalog: Boolean(m) || !(cat?.models || []).length,
    };
  }
  const budgets = {};
  for (const [feature, keys] of budgetFeatures()) {
    budgets[feature] = {
      tokens: keys.tokensKey ? cfg[keys.tokensKey] : null, tokensKey: keys.tokensKey || null,
      calls: keys.callsKey ? cfg[keys.callsKey] : null, callsKey: keys.callsKey || null,
    };
  }
  return {
    tiers,
    fallback: {
      model: cfg['llm.fallbackModel'] || null, modelKey: 'llm.fallbackModel', modelSource: src('llm.fallbackModel'),
      afterMs: { interactive: Math.min(cfg['llm.lanes.interactive.fallbackAfterMs'] ?? cfg['llm.fallbackAfterMs'], cfg['llm.fallbackAfterMs']), background: cfg['llm.fallbackAfterMs'] },
      cooldownSec: cfg['llm.fallbackCooldownSec'],
    },
    lanes: {
      interactive: { concurrency: cfg['llm.lanes.interactive.concurrency'], waitMs: cfg['llm.lanes.interactive.waitMs'], fallbackAfterMs: cfg['llm.lanes.interactive.fallbackAfterMs'] },
      background: { concurrency: cfg['llm.lanes.background.concurrency'], waitMs: cfg['llm.lanes.background.waitMs'], fallbackAfterMs: cfg['llm.fallbackAfterMs'] },
    },
    probe: {
      enabled: cfg['llm.probe.enabled'] !== false, everySec: cfg['llm.probe.everySec'], timeoutMs: cfg['llm.probe.timeoutMs'],
      degradeAfter: cfg['llm.probe.degradeAfter'], recoverAfter: cfg['llm.probe.recoverAfter'], degradedEverySec: cfg['llm.probe.degradedEverySec'],
    },
    streamFirstToken: cfg['llm.stream.firstToken'] !== false,
    enabledModels: Array.isArray(cfg['llm.models.enabled']) ? cfg['llm.models.enabled'] : [],
    budgets,
    status: await tierStatus(null),
  };
}

const LANE_FIELDS = {
  interactive: { concurrency: 'llm.lanes.interactive.concurrency', waitMs: 'llm.lanes.interactive.waitMs', fallbackAfterMs: 'llm.lanes.interactive.fallbackAfterMs' },
  background: { concurrency: 'llm.lanes.background.concurrency', waitMs: 'llm.lanes.background.waitMs', fallbackAfterMs: 'llm.fallbackAfterMs' },
};
const PROBE_FIELDS = { enabled: 'llm.probe.enabled', everySec: 'llm.probe.everySec', timeoutMs: 'llm.probe.timeoutMs', degradeAfter: 'llm.probe.degradeAfter', recoverAfter: 'llm.probe.recoverAfter', degradedEverySec: 'llm.probe.degradedEverySec' };
const MODEL_FIELDS = { fast: 'llm.models.fast', long: 'llm.models.long', agent: 'llm.models.agent', fallback: 'llm.fallbackModel' };
const TIER_ALIASES = { reflex: 'fast', reasoning: 'long' };

function onlyKeys(obj, allowed, where) {
  if (obj === undefined) return false;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad(`${where} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw bad(`${where}: unknown field ${k}`);
  return true;
}

/**
 * Map a PUT /admin/runtime body onto config keys. Pure given the catalog and current config.
 * Model ids are checked against the catalog's chat models (when it lists any); the agent model must
 * advertise tool calling; efforts must be on the ladder and are reported with the value each model
 * will actually get (`notes`). `null` clears an override (back to env, then default).
 * @returns {{ patch: object, notes: string[] }}
 */
export function runtimePatch(body, { catalog = { models: [] }, cfg = {} } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
  onlyKeys(body, ['models', 'effort', 'lanes', 'fallback', 'probe', 'budgets', 'enabledModels', 'streamFirstToken'], 'body');
  const patch = {};
  const notes = [];
  const models = (catalog?.models || []).filter((m) => m && m.id);
  const byId = new Map(models.map((m) => [m.id, m]));
  const caps = (m) => (Array.isArray(m?.capabilities) ? m.capabilities : []);

  if (onlyKeys(body.models, [...Object.keys(MODEL_FIELDS), ...Object.keys(TIER_ALIASES)], 'models')) {
    for (const [rawRole, id] of Object.entries(body.models)) {
      const role = TIER_ALIASES[rawRole] || rawRole;
      const key = MODEL_FIELDS[role];
      if (id === null || (role === 'fallback' && id === '')) { patch[key] = role === 'fallback' && id === '' ? '' : null; continue; }
      if (typeof id !== 'string' || !id.trim() || id.length > 200) throw bad(`models.${rawRole} must be a model id`);
      const m = byId.get(id.trim());
      if (models.length) {
        if (!m) throw bad(`models.${rawRole}: ${id} is not in the gateway catalog`);
        if (caps(m).length && !caps(m).includes('chat')) throw bad(`models.${rawRole}: ${id} is not a chat model`);
        if (role === 'agent' && caps(m).length && !caps(m).includes('tools')) throw bad(`models.agent: ${id} does not support tool calling`);
        if (m.disabled_at || /^(offline|disabled)$/i.test(String(m.status || ''))) notes.push(`${id} is ${m.status || 'disabled'} in the catalog; the probe will mark it degraded`);
      }
      patch[key] = id.trim();
    }
  }
  const modelFor = (role) => byId.get(patch[MODEL_FIELDS[role]] ?? cfg[MODEL_FIELDS[role]]) || null;

  if (onlyKeys(body.effort, ['fast', 'long', 'agent', 'reflex', 'reasoning'], 'effort')) {
    for (const [rawRole, effort] of Object.entries(body.effort)) {
      const role = TIER_ALIASES[rawRole] || rawRole;
      const key = `llm.reasoning.${role}`;
      if (effort === null) { patch[key] = null; continue; }
      const e = normEffort(String(effort));
      if (!EFFORTS.includes(e)) throw bad(`effort.${rawRole} must be one of ${EFFORTS.join(', ')}`);
      patch[key] = e;
      const m = modelFor(role);
      if (m) {
        const wire = clampEffort(e, m, cfg['llm.offSpelling'] || 'none');
        const spoken = wire === (cfg['llm.offSpelling'] || 'none') ? 'off' : wire;
        if (wire === undefined) notes.push(`${m.id} does not do reasoning; effort is not sent to it`);
        else if (spoken !== e) notes.push(`${m.id} accepts ${(m.reasoning_efforts || []).join('/')}; ${e} is sent as ${wire}`);
      }
    }
  }

  if (onlyKeys(body.lanes, Object.keys(LANE_FIELDS), 'lanes')) {
    for (const [lane, fields] of Object.entries(body.lanes)) {
      onlyKeys(fields, Object.keys(LANE_FIELDS[lane]), `lanes.${lane}`);
      for (const [f, v] of Object.entries(fields)) {
        if (v !== null && !Number.isFinite(Number(v))) throw bad(`lanes.${lane}.${f} must be a number`);
        patch[LANE_FIELDS[lane][f]] = v === null ? null : Number(v);
      }
    }
  }
  if (onlyKeys(body.fallback, ['cooldownSec', 'model'], 'fallback')) {
    if (body.fallback.cooldownSec !== undefined) {
      const v = body.fallback.cooldownSec;
      if (v !== null && !Number.isFinite(Number(v))) throw bad('fallback.cooldownSec must be a number');
      patch['llm.fallbackCooldownSec'] = v === null ? null : Number(v);
    }
    if (body.fallback.model !== undefined) Object.assign(patch, runtimePatch({ models: { fallback: body.fallback.model } }, { catalog, cfg }).patch);
  }
  if (onlyKeys(body.probe, Object.keys(PROBE_FIELDS), 'probe')) {
    for (const [f, v] of Object.entries(body.probe)) {
      if (f === 'enabled') { if (v !== null && typeof v !== 'boolean') throw bad('probe.enabled must be true or false'); patch[PROBE_FIELDS.enabled] = v; continue; }
      if (v !== null && !Number.isFinite(Number(v))) throw bad(`probe.${f} must be a number`);
      patch[PROBE_FIELDS[f]] = v === null ? null : Number(v);
    }
  }
  if (body.streamFirstToken !== undefined) {
    if (body.streamFirstToken !== null && typeof body.streamFirstToken !== 'boolean') throw bad('streamFirstToken must be true or false');
    patch['llm.stream.firstToken'] = body.streamFirstToken;
  }
  if (body.budgets !== undefined) {
    if (!body.budgets || typeof body.budgets !== 'object' || Array.isArray(body.budgets)) throw bad('budgets must be { feature: { tokens, calls } }');
    const features = budgetFeatures();
    for (const [feature, change] of Object.entries(body.budgets)) {
      const keys = features.get(feature);
      if (!keys) throw bad(`budgets: unknown feature ${feature}`);
      onlyKeys(change, ['tokens', 'calls'], `budgets.${feature}`);
      for (const [f, v] of Object.entries(change)) {
        const key = f === 'tokens' ? keys.tokensKey : keys.callsKey;
        if (!key) throw bad(`budgets.${feature} has no ${f} budget`);
        if (v !== null && !(Number.isFinite(Number(v)) && Number(v) >= 0)) throw bad(`budgets.${feature}.${f} must be a non-negative number`);
        patch[key] = v === null ? null : Math.round(Number(v));
      }
    }
  }
  if (body.enabledModels !== undefined) {
    const list = body.enabledModels;
    if (!Array.isArray(list) || list.some((m) => typeof m !== 'string' || !m.trim() || m.length > 200)) throw bad('enabledModels must be a list of model ids');
    const ids = [...new Set(list.map((m) => m.trim()))];
    if (models.length) {
      const unknown = ids.filter((m) => !byId.has(m));
      if (unknown.length) throw bad(`enabledModels: not in the gateway catalog: ${unknown.join(', ')}`);
    }
    patch['llm.models.enabled'] = ids;
  }
  const known = new Set(SCHEMA.map((f) => f.key));
  for (const k of Object.keys(patch)) if (!known.has(k)) throw bad(`unknown config key ${k}`);
  return { patch, notes };
}

/** PUT /admin/runtime */
export async function updateRuntime(body) {
  const cfg = await getConfig(null);
  const catalog = await getCatalog();
  const { patch, notes } = runtimePatch(body, { catalog, cfg });
  if (Object.keys(patch).length) await saveSystemConfig(patch);
  return { ...(await runtimeSettings()), changed: Object.keys(patch), notes };
}

const round = (n, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);

/**
 * GET /admin/usage?days=7&userId=: calls, tokens, latency, errors, fallbacks and escalations per
 * feature per tier per day, from hedwig_ai_calls (the same rows the gateway attributes by
 * X-Workflow). Rows written before the runtime audit have no tier ('unknown').
 */
export async function usageReport({ days = 7, userId = null } = {}) {
  const d = Math.max(1, Math.min(90, Math.round(Number(days)) || 7));
  const uid = typeof userId === 'string' && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
  const params = [d, uid];
  const where = `created_at >= date_trunc('day', NOW()) - make_interval(days => $1::int - 1) AND ($2::uuid IS NULL OR user_id = $2)`;
  const [daily, features] = await Promise.all([
    query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, feature, COALESCE(tier, 'unknown') AS tier, model,
              COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE NOT ok)::int AS errors,
              COUNT(*) FILTER (WHERE fell_back)::int AS fell_back, COUNT(*) FILTER (WHERE escalated)::int AS escalated,
              COALESCE(SUM(prompt_tokens), 0)::bigint AS tokens_in, COALESCE(SUM(completion_tokens), 0)::bigint AS tokens_out,
              COALESCE(AVG(latency_ms), 0)::int AS avg_latency_ms,
              COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms
         FROM hedwig_ai_calls WHERE ${where}
        GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC, 5 DESC`,
      params,
    ),
    query(
      `SELECT feature, COALESCE(tier, 'unknown') AS tier,
              COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE NOT ok)::int AS errors,
              COUNT(*) FILTER (WHERE fell_back)::int AS fell_back, COUNT(*) FILTER (WHERE escalated)::int AS escalated,
              COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0)::bigint AS tokens,
              COALESCE(AVG(latency_ms), 0)::int AS avg_latency_ms,
              COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms
         FROM hedwig_ai_calls WHERE ${where}
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      params,
    ),
  ]);
  const tiers = {};
  let total = 0; let escalated = 0;
  const featureRows = features.rows.map((r) => {
    const calls = Number(r.calls) || 0;
    total += calls; escalated += Number(r.escalated) || 0;
    const t = tiers[r.tier] || (tiers[r.tier] = { calls: 0, errors: 0, fellBack: 0, tokens: 0 });
    t.calls += calls; t.errors += Number(r.errors) || 0; t.fellBack += Number(r.fell_back) || 0; t.tokens += Number(r.tokens) || 0;
    return {
      feature: r.feature, tier: r.tier, calls, errors: Number(r.errors) || 0, fellBack: Number(r.fell_back) || 0, escalated: Number(r.escalated) || 0,
      tokens: Number(r.tokens) || 0, avgLatencyMs: Number(r.avg_latency_ms) || 0, p95LatencyMs: Number(r.p95_latency_ms) || 0,
      errorRate: round(calls ? (Number(r.errors) || 0) / calls : 0),
      fallbackRate: round(calls ? (Number(r.fell_back) || 0) / calls : 0),
      escalationRate: round(calls ? (Number(r.escalated) || 0) / calls : 0),
    };
  });
  return {
    days: d,
    userId: uid,
    daily: daily.rows.map((r) => ({
      day: r.day, feature: r.feature, tier: r.tier, model: r.model, calls: Number(r.calls) || 0, errors: Number(r.errors) || 0,
      fellBack: Number(r.fell_back) || 0, escalated: Number(r.escalated) || 0, tokensIn: Number(r.tokens_in) || 0, tokensOut: Number(r.tokens_out) || 0,
      avgLatencyMs: Number(r.avg_latency_ms) || 0, p95LatencyMs: Number(r.p95_latency_ms) || 0,
    })),
    features: featureRows,
    tiers,
    escalation: { escalated, calls: total, rate: round(total ? escalated / total : 0) },
  };
}
