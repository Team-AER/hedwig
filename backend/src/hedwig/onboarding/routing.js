// Admin: the per-feature routing table (tier, escalation, cadence, budget), the models users may
// pick from, and a household summary (counts only, never mail). The table is assembled from the
// registered prompts (listPrompts) and config; edits write existing config keys.
import { query } from '../../services/db.js';
import { getConfig, saveSystemConfig, SCHEMA } from '../config.js';
import { listPrompts, TIERS } from '../prompts/index.js';
import { getCatalog } from '../llm.js';

const KEYS = new Set(SCHEMA.map((f) => f.key));
const TIER_VALUES = ['auto', 'reflex', 'reasoning'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Prompts whose calls are charged to another feature (sort/deps.js runs spam.reflex as 'sort').
const FEATURE_OF_PROMPT = { spam: 'sort' };

// The escalation rule a feature has, if any: the first key is what PUT escalateBelow writes.
const ESCALATE = {
  sort: [
    { key: 'sort.escalateBelow', label: 'Reflex confidence below this goes to the reasoning model' },
    { key: 'spam.phishingEscalateBelow', label: 'Suspected phishing below this confidence goes to the reasoning model' },
  ],
};

const CADENCE = {
  sort: (c) => `Each new message; history ${c['sort.backfillBatch']} messages a minute`,
  labels: (c) => `Behaviour every ${Math.round(c['labels.behaviourEverySec'] / 60)} min; judge nightly at ${c['labels.judgeHour']}:00`,
  ask: () => 'When you ask',
  cards: (c) => `Newly sorted mail every ${c['cards.scanEverySec']} s`,
  work: () => 'When you open a thread or ask for a draft',
  profile: (c) => `Weekly, ${DAY_NAMES[c['profile.weekday']] || c['profile.weekday']} at ${c['profile.hour']}:00`,
};

export const featureOf = (prompt) => FEATURE_OF_PROMPT[prompt.feature] || prompt.feature;

/**
 * The routing table. Pure given the prompt list and a config view.
 * @returns {{ models: { reflex, reasoning }, features: object[] }}
 */
export function buildRoutingTable(prompts, cfg) {
  const byFeature = new Map();
  for (const p of prompts) {
    const f = featureOf(p);
    if (!byFeature.has(f)) byFeature.set(f, []);
    byFeature.get(f).push(p);
  }
  for (const f of Object.keys(CADENCE)) if (!byFeature.has(f)) byFeature.set(f, []);
  const features = [...byFeature.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([feature, list]) => {
    const tierKey = `routing.${feature}.tier`;
    const override = KEYS.has(tierKey) ? cfg[tierKey] : 'auto';
    const routed = Object.hasOwn(TIERS, String(override)) ? override : null;
    const tiers = [...new Set(list.map((p) => p.tier))];
    const defaultTier = tiers.length === 1 ? tiers[0] : tiers.length ? 'mixed' : null;
    const budgetKey = `llm.tokenBudget.${feature}`;
    const escalate = (ESCALATE[feature] || []).map((e) => ({ ...e, value: cfg[e.key] }));
    return {
      feature,
      tier: routed || defaultTier,
      override,
      defaultTier,
      tierKey: KEYS.has(tierKey) ? tierKey : null,
      escalateBelow: escalate[0]?.value ?? null,
      escalateKey: escalate[0]?.key ?? null,
      escalate,
      cadence: CADENCE[feature] ? CADENCE[feature](cfg) : null,
      budget: KEYS.has(budgetKey) ? cfg[budgetKey] : null,
      budgetKey: KEYS.has(budgetKey) ? budgetKey : null,
      prompts: list.map((p) => ({ id: p.id, version: p.version, tier: p.tier, effectiveTier: routed || p.tier, maxTokens: p.maxTokens })),
    };
  });
  return { models: { reflex: cfg['llm.models.fast'], reasoning: cfg['llm.models.long'] }, features };
}

/** GET /admin/routing (userId null) and GET /routing (with the user's tokens spent today). */
export async function routingTable({ userId = null } = {}) {
  const cfg = await getConfig(userId);
  const table = buildRoutingTable(await listPrompts(), cfg);
  if (!userId) return table;
  const { rows } = await query(
    `SELECT feature, COALESCE(SUM(COALESCE(prompt_tokens,0) + COALESCE(completion_tokens,0)),0)::bigint AS tokens
       FROM hedwig_ai_calls WHERE user_id = $1 AND created_at >= date_trunc('day', NOW()) GROUP BY feature`,
    [userId],
  );
  const used = new Map(rows.map((r) => [r.feature, Number(r.tokens) || 0]));
  return {
    ...table,
    readOnly: true,
    // The user's own role models (their overrides included) and what they may pick from.
    myModels: { fast: cfg['llm.models.fast'], long: cfg['llm.models.long'], agent: cfg['llm.models.agent'] },
    modelChoices: Array.isArray(cfg['llm.models.enabled']) ? cfg['llm.models.enabled'] : [],
    features: table.features.map((f) => ({ ...f, usedToday: used.get(f.feature) || 0 })),
  };
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Map a PUT /admin/routing body to config keys. Pure (validates against the table).
 * body: { <feature>: { tier?: 'auto'|'reflex'|'reasoning'|null, escalateBelow?: number|null, budget?: number|null } }
 */
export function routingPatch(body, table) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be { feature: { tier, escalateBelow, budget } }');
  const byName = new Map(table.features.map((f) => [f.feature, f]));
  const patch = {};
  for (const [feature, change] of Object.entries(body)) {
    const f = byName.get(feature);
    if (!f) throw bad(`unknown feature ${feature}`);
    if (!change || typeof change !== 'object') throw bad(`${feature}: expected { tier, escalateBelow, budget }`);
    for (const k of Object.keys(change)) if (!['tier', 'escalateBelow', 'budget'].includes(k)) throw bad(`${feature}: unknown field ${k}`);
    if (change.tier !== undefined) {
      if (!f.tierKey) throw bad(`${feature} has no tier setting`);
      if (change.tier !== null && !TIER_VALUES.includes(change.tier)) throw bad(`${feature}: tier must be auto, reflex or reasoning`);
      patch[f.tierKey] = change.tier;
    }
    if (change.escalateBelow !== undefined) {
      if (!f.escalateKey) throw bad(`${feature} has no escalation rule`);
      const n = change.escalateBelow === null ? null : Number(change.escalateBelow);
      if (n !== null && !(n >= 0 && n <= 1)) throw bad(`${feature}: escalateBelow must be between 0 and 1`);
      patch[f.escalateKey] = n;
    }
    if (change.budget !== undefined) {
      if (!f.budgetKey) throw bad(`${feature} has no token budget`);
      const n = change.budget === null ? null : Number(change.budget);
      if (n !== null && !(Number.isFinite(n) && n >= 0)) throw bad(`${feature}: budget must be a number of tokens`);
      patch[f.budgetKey] = n === null ? null : Math.round(n);
    }
  }
  return patch;
}

/** PUT /admin/routing */
export async function updateRouting(body) {
  const patch = routingPatch(body, await routingTable());
  if (Object.keys(patch).length) await saveSystemConfig(patch);
  return { ...(await routingTable()), changed: Object.keys(patch) };
}

/** Chat models in the catalog (embeddings-only entries left out). */
async function catalogModels() {
  const cat = await getCatalog();
  return (cat?.models || [])
    .filter((m) => m?.id && !(Array.isArray(m.capabilities) && m.capabilities.length && !m.capabilities.includes('chat')))
    .map((m) => ({ id: m.id, displayName: m.display_name || m.id, status: m.status || null, maxOutputTokens: m.max_output_tokens ?? null }));
}

/** GET /admin/models/enabled */
export async function enabledModels() {
  const cfg = await getConfig(null);
  return {
    models: Array.isArray(cfg['llm.models.enabled']) ? cfg['llm.models.enabled'] : [],
    defaults: { fast: cfg['llm.models.fast'], long: cfg['llm.models.long'], agent: cfg['llm.models.agent'] },
    catalog: await catalogModels(),
  };
}

/** PUT /admin/models/enabled { models }: a subset of the catalog (checked when the catalog lists any). */
export async function setEnabledModels(body = {}) {
  const list = body.models;
  if (!Array.isArray(list) || list.some((m) => typeof m !== 'string' || !m.trim() || m.length > 200)) throw bad('models must be a list of model ids');
  const models = [...new Set(list.map((m) => m.trim()))];
  const catalog = await catalogModels();
  if (catalog.length) {
    const known = new Set(catalog.map((m) => m.id));
    const unknown = models.filter((m) => !known.has(m));
    if (unknown.length) throw bad(`not in the model catalog: ${unknown.join(', ')}`);
  }
  await saveSystemConfig({ 'llm.models.enabled': models });
  return enabledModels();
}

/** GET /admin/users/summary: per user, counts only (accounts, index coverage, sorting, questions, tokens). */
export async function usersSummary() {
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, COALESCE(u.is_admin, false) AS is_admin,
            (SELECT COUNT(*) FROM email_accounts a WHERE a.user_id = u.id)::int AS accounts,
            (SELECT COALESCE(SUM(c.seen), 0) FROM hedwig_index_coverage c WHERE c.user_id = u.id)::bigint AS indexed,
            (SELECT COALESCE(SUM(c.total), 0) FROM hedwig_index_coverage c WHERE c.user_id = u.id)::bigint AS total,
            (SELECT COUNT(*) FROM hedwig_sort s WHERE s.user_id = u.id)::bigint AS sorted,
            (SELECT COUNT(*) FROM hedwig_questions q WHERE q.user_id = u.id AND q.answered_at IS NOT NULL)::int AS questions_answered,
            (SELECT COALESCE(SUM(COALESCE(x.prompt_tokens, 0) + COALESCE(x.completion_tokens, 0)), 0) FROM hedwig_ai_calls x
              WHERE x.user_id = u.id AND x.created_at >= date_trunc('day', NOW()))::bigint AS tokens_today
       FROM users u ORDER BY u.username`,
  );
  return {
    users: rows.map((r) => {
      const indexed = Number(r.indexed) || 0;
      const total = Number(r.total) || 0;
      return {
        userId: r.id,
        username: r.username,
        displayName: r.display_name || null,
        isAdmin: Boolean(r.is_admin),
        accounts: Number(r.accounts) || 0,
        indexed,
        total,
        indexedPct: total ? Math.round((Math.min(indexed, total) / total) * 1000) / 10 : null,
        sorted: Number(r.sorted) || 0,
        questionsAnswered: Number(r.questions_answered) || 0,
        tokensToday: Number(r.tokens_today) || 0,
      };
    }),
  };
}
