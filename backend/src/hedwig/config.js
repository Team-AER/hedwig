// Hedwig configuration.
//
// Every knob Hedwig has is declared once in SCHEMA below. A value resolves in this order:
//   1. per-user override   (hedwig_user_settings.settings, only for keys with scope 'user')
//   2. admin override      (system_settings key 'hedwig_config', edited in Settings → Hedwig)
//   3. environment         (HEDWIG_<KEY_IN_UPPER_SNAKE>, e.g. llm.baseUrl → HEDWIG_LLM_BASE_URL)
//   4. the schema default
//
// The schema is also what the settings UI renders, so adding a knob here is enough to make it
// editable. Values are validated and coerced on write; reads never throw.
import { query } from '../services/db.js';
import { encrypt, decrypt, isEncrypted } from '../services/encryption.js';

const CACHE_TTL_MS = 30_000;

/**
 * @typedef {{ key: string, type: 'string'|'number'|'boolean'|'enum'|'json'|'secret',
 *   default: any, group: string, label: string, help?: string, scope?: 'system'|'user',
 *   options?: string[], min?: number, max?: number }} ConfigField
 */

/** @type {ConfigField[]} */
export const SCHEMA = [
  // ── Master switches ────────────────────────────────────────────────────────
  { key: 'enabled', type: 'boolean', default: true, group: 'general', label: 'Hedwig intelligence enabled', help: 'Off: Hedwig behaves exactly like upstream MailFlow.' },
  { key: 'features.context', type: 'boolean', default: true, group: 'general', label: 'Context engine (people, topics, commitments, facts)', scope: 'user' },
  { key: 'features.triage', type: 'boolean', default: true, group: 'general', label: 'Learning triage (Needs you, Waiting on)', scope: 'user' },
  { key: 'features.insights', type: 'boolean', default: true, group: 'general', label: 'Insights and briefings', scope: 'user' },
  { key: 'features.agent', type: 'boolean', default: true, group: 'general', label: 'Agent and automations', scope: 'user' },
  { key: 'features.extraction', type: 'boolean', default: true, group: 'general', label: 'Model-based extraction of commitments and facts', scope: 'user' },

  // ── Model gateway ──────────────────────────────────────────────────────────
  { key: 'llm.baseUrl', type: 'string', default: 'http://llm-proxy.cls/v1', group: 'models', label: 'OpenAI-compatible base URL', help: 'Leave empty to disable every model feature.' },
  { key: 'llm.apiKey', type: 'secret', default: '', group: 'models', label: 'API key (optional)' },
  { key: 'llm.catalogUrl', type: 'string', default: 'http://llm-proxy.cls/catalog.json', group: 'models', label: 'Model catalog URL', help: 'Optional. Used to list models and the reasoning levels each supports.' },
  { key: 'llm.models.fast', type: 'string', default: 'Qwen/Qwen3.8-Flash-Next', group: 'models', label: 'Fast model (triage, extraction, labels)' },
  { key: 'llm.models.long', type: 'string', default: 'Qwen/Qwen3.8-Flash-Next', group: 'models', label: 'Long model (summaries, ask, briefings)' },
  { key: 'llm.models.agent', type: 'string', default: 'Qwen/Qwen3.8-Flash-Next', group: 'models', label: 'Agent model (tool calling)' },
  { key: 'llm.reasoning.fast', type: 'enum', default: 'off', options: ['off', 'low', 'medium', 'high', 'xhigh'], group: 'models', label: 'Fast model reasoning effort' },
  { key: 'llm.reasoning.long', type: 'enum', default: 'low', options: ['off', 'low', 'medium', 'high', 'xhigh'], group: 'models', label: 'Long model reasoning effort' },
  { key: 'llm.reasoning.agent', type: 'enum', default: 'low', options: ['off', 'low', 'medium', 'high', 'xhigh'], group: 'models', label: 'Agent reasoning effort' },
  { key: 'llm.offSpelling', type: 'string', default: 'none', group: 'models', label: 'Wire value sent for "off"', help: 'LiteLLM accepts "none"; some servers want "off".' },
  { key: 'llm.timeoutMs', type: 'number', default: 120000, min: 5000, max: 600000, group: 'models', label: 'Request timeout (ms)' },
  { key: 'llm.concurrency', type: 'number', default: 4, min: 1, max: 64, group: 'models', label: 'Concurrent requests per model' },
  { key: 'llm.dailyBudget.triage', type: 'number', default: 400, min: 0, max: 100000, group: 'budgets', label: 'Triage stage-3 calls per user per day' },
  { key: 'llm.dailyBudget.extraction', type: 'number', default: 600, min: 0, max: 100000, group: 'budgets', label: 'Extraction calls per user per day' },
  { key: 'llm.dailyBudget.summary', type: 'number', default: 300, min: 0, max: 100000, group: 'budgets', label: 'Summary calls per user per day' },
  { key: 'llm.dailyBudget.ask', type: 'number', default: 200, min: 0, max: 100000, group: 'budgets', label: 'Ask calls per user per day' },
  { key: 'llm.dailyBudget.agent', type: 'number', default: 400, min: 0, max: 100000, group: 'budgets', label: 'Agent model calls per user per day' },
  { key: 'llm.dailyBudget.insights', type: 'number', default: 40, min: 0, max: 10000, group: 'budgets', label: 'Insight calls per user per day' },
  { key: 'llm.dailyBudget.plugins', type: 'number', default: 300, min: 0, max: 100000, group: 'budgets', label: 'Calls per plugin per user per day' },

  // ── Embeddings ─────────────────────────────────────────────────────────────
  { key: 'embeddings.provider', type: 'enum', default: 'openai', options: ['openai', 'hash', 'off'], group: 'embeddings', label: 'Embedding provider', help: 'openai = any /v1/embeddings server (TEI, gateway). hash = built-in lexical vectors, no model.' },
  { key: 'embeddings.baseUrl', type: 'string', default: 'http://embed:80/v1', group: 'embeddings', label: 'Embeddings base URL' },
  { key: 'embeddings.apiKey', type: 'secret', default: '', group: 'embeddings', label: 'Embeddings API key (optional)' },
  { key: 'embeddings.model', type: 'string', default: 'BAAI/bge-small-en-v1.5', group: 'embeddings', label: 'Embedding model' },
  { key: 'embeddings.dims', type: 'number', default: 384, min: 16, max: 4096, group: 'embeddings', label: 'Embedding dimensions' },
  { key: 'embeddings.batchSize', type: 'number', default: 16, min: 1, max: 256, group: 'embeddings', label: 'Batch size' },
  { key: 'embeddings.maxChars', type: 'number', default: 2000, min: 200, max: 20000, group: 'embeddings', label: 'Characters embedded per message' },

  // ── Pipeline ───────────────────────────────────────────────────────────────
  { key: 'pipeline.scanIntervalSec', type: 'number', default: 15, min: 2, max: 3600, group: 'pipeline', label: 'Scan for new mail every (s)' },
  { key: 'pipeline.batchSize', type: 'number', default: 50, min: 1, max: 1000, group: 'pipeline', label: 'Messages per scan batch' },
  { key: 'pipeline.backfillDays', type: 'number', default: 365, min: 0, max: 10000, group: 'pipeline', label: 'Backfill history (days)', help: 'Older mail is indexed for people but not embedded or extracted.' },
  { key: 'pipeline.workerConcurrency', type: 'number', default: 4, min: 1, max: 64, group: 'pipeline', label: 'Worker job concurrency' },
  { key: 'pipeline.excludeSpecialUse', type: 'json', default: ['\\Junk', '\\Trash', '\\Drafts', '\\All', '\\Flagged', '\\Important'], group: 'pipeline', label: 'Skip folders with these IMAP special-use flags' },
  { key: 'pipeline.excludeFolders', type: 'json', default: [], group: 'pipeline', label: 'Also skip these folder paths' },

  // ── Context engine ─────────────────────────────────────────────────────────
  { key: 'context.topicThreshold', type: 'number', default: 0.78, min: 0.3, max: 0.99, group: 'context', label: 'Topic join similarity' },
  { key: 'context.topicMinMessages', type: 'number', default: 3, min: 2, max: 100, group: 'context', label: 'Messages before a topic is labelled' },
  { key: 'context.askTopK', type: 'number', default: 12, min: 3, max: 60, group: 'context', label: 'Messages retrieved per question' },
  { key: 'context.summaryRefreshHours', type: 'number', default: 24, min: 1, max: 720, group: 'context', label: 'Refresh card summaries after (h)' },
  { key: 'context.extractMinConfidence', type: 'number', default: 0.6, min: 0, max: 1, group: 'context', label: 'Hide extractions below confidence' },
  { key: 'context.freemailDomains', type: 'json', default: ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'fastmail.com', 'aol.com', 'gmx.com', 'gmx.de', 'zoho.com', 'yandex.com', 'hey.com'], group: 'context', label: 'Personal mail domains (not organisations)' },

  // ── Triage ─────────────────────────────────────────────────────────────────
  { key: 'triage.llmLow', type: 'number', default: 0.35, min: 0, max: 1, group: 'triage', label: 'Ask the model above confidence', scope: 'user' },
  { key: 'triage.llmHigh', type: 'number', default: 0.65, min: 0, max: 1, group: 'triage', label: 'Ask the model below confidence', scope: 'user' },
  { key: 'triage.needsYouThreshold', type: 'number', default: 0.5, min: 0, max: 1, group: 'triage', label: 'Needs-you threshold', scope: 'user' },
  { key: 'triage.minSamples', type: 'number', default: 40, min: 5, max: 10000, group: 'triage', label: 'Labelled messages before the classifier takes over' },
  { key: 'triage.retrainHour', type: 'number', default: 3, min: 0, max: 23, group: 'triage', label: 'Nightly retrain hour (server time)' },
  { key: 'triage.implicitAfterHours', type: 'number', default: 48, min: 1, max: 720, group: 'triage', label: 'Learn from behaviour after (h)' },
  { key: 'triage.waitingOnDays', type: 'number', default: 3, min: 1, max: 60, group: 'triage', label: 'Waiting-on after no reply for (days)', scope: 'user' },
  { key: 'triage.modelWeight', type: 'number', default: 0.65, min: 0, max: 1, group: 'triage', label: 'Weight of your classifier vs rules once trained' },
  { key: 'triage.modelPromote', type: 'number', default: 0.8, min: 0, max: 1, group: 'triage', label: 'Classifier confidence needed to lift digest/notifications into Needs you' },
  { key: 'triage.llmMaxAgeDays', type: 'number', default: 14, min: 0, max: 365, group: 'triage', label: 'Ask the model only about mail newer than (days)' },
  { key: 'triage.waitingOnMaxDays', type: 'number', default: 60, min: 1, max: 365, group: 'triage', label: 'Stop tracking waiting-on after (days)' },
  { key: 'triage.implicitWindowDays', type: 'number', default: 30, min: 1, max: 365, group: 'triage', label: 'Learn from behaviour on mail up to (days) old' },
  { key: 'triage.pushJunkToProvider', type: 'boolean', default: false, group: 'triage', label: 'Move spam verdicts to the provider Junk folder', scope: 'user' },

  // ── Insights and agent ─────────────────────────────────────────────────────
  { key: 'insights.briefingTime', type: 'string', default: '07:00', group: 'insights', label: 'Daily briefing time (HH:MM, in your timezone)', scope: 'user' },
  { key: 'insights.weeklyDay', type: 'number', default: 1, min: 0, max: 6, group: 'insights', label: 'Weekly review day (0=Sun)', scope: 'user' },
  { key: 'insights.timezone', type: 'string', default: 'UTC', group: 'insights', label: 'Timezone (IANA)', scope: 'user' },
  { key: 'agent.maxSteps', type: 'number', default: 8, min: 1, max: 40, group: 'agent', label: 'Max tool steps per run' },
  { key: 'agent.requireConfirmation', type: 'boolean', default: true, group: 'agent', label: 'Confirm before any action that changes mail', scope: 'user' },
  { key: 'agent.systemPrompt', type: 'string', default: '', group: 'agent', label: 'Extra instructions for the agent', scope: 'user' },

  // ── Plugins ────────────────────────────────────────────────────────────────
  { key: 'plugins.dir', type: 'string', default: '/plugins', group: 'plugins', label: 'External plugin directory' },
  { key: 'plugins.allowGit', type: 'boolean', default: true, group: 'plugins', label: 'Allow installing plugins from git URLs' },
  { key: 'plugins.directoryUrl', type: 'string', default: 'https://raw.githubusercontent.com/Team-AER/hedwig/main/plugins/directory.json', group: 'plugins', label: 'Plugin directory index URL' },

  // ── UI ─────────────────────────────────────────────────────────────────────
  { key: 'ui.defaultTemplate', type: 'enum', default: 'triage', options: ['triage', 'research', 'focused', 'compact', 'comfortable', 'wide', 'vertical'], group: 'ui', label: 'Default layout template', scope: 'user' },
];

const BY_KEY = new Map(SCHEMA.map((f) => [f.key, f]));

export function envNameFor(key) {
  return 'HEDWIG_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\./g, '_').toUpperCase();
}

export function coerce(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  switch (field.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
      return Boolean(raw);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return undefined;
      let v = n;
      if (field.min !== undefined) v = Math.max(field.min, v);
      if (field.max !== undefined) v = Math.min(field.max, v);
      return v;
    }
    case 'enum': {
      const s = String(raw).trim();
      return field.options.includes(s) ? s : undefined;
    }
    case 'json':
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return undefined; }
      }
      return raw;
    case 'secret': {
      const str = String(raw);
      if (str && isEncrypted(str)) {
        try { return decrypt(str); } catch { return undefined; }
      }
      return str;
    }
    default:
      return String(raw);
  }
}

function envValue(field, env = process.env) {
  const name = envNameFor(field.key);
  return name in env ? coerce(field, env[name]) : undefined;
}

let systemCache = null; // { values, expiry }
const userCache = new Map(); // userId -> { values, expiry }

async function loadSystemOverrides() {
  if (systemCache && systemCache.expiry > Date.now()) return systemCache.values;
  let values = {};
  try {
    const { rows } = await query("SELECT value FROM system_settings WHERE key = 'hedwig_config'");
    if (rows.length) values = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
  } catch {
    values = {};
  }
  systemCache = { values: values || {}, expiry: Date.now() + CACHE_TTL_MS };
  return systemCache.values;
}

async function loadUserOverrides(userId) {
  if (!userId) return {};
  const cached = userCache.get(userId);
  if (cached && cached.expiry > Date.now()) return cached.values;
  let values;
  try {
    const { rows } = await query('SELECT settings FROM hedwig_user_settings WHERE user_id = $1', [userId]);
    values = rows[0]?.settings || {};
  } catch {
    values = {};
  }
  userCache.set(userId, { values, expiry: Date.now() + CACHE_TTL_MS });
  return values;
}

export function invalidateConfigCache(userId) {
  systemCache = null;
  if (userId) userCache.delete(userId);
  else userCache.clear();
}

/** Resolve one field from the layers. Exported for tests. */
export function resolveField(field, { user = {}, system = {}, env = process.env } = {}) {
  if (field.scope === 'user' && user[field.key] !== undefined) {
    const v = coerce(field, user[field.key]);
    if (v !== undefined) return v;
  }
  if (system[field.key] !== undefined) {
    const v = coerce(field, system[field.key]);
    if (v !== undefined) return v;
  }
  const e = envValue(field, env);
  if (e !== undefined) return e;
  return field.default;
}

/**
 * The effective config as a flat object keyed by dotted key, plus a `get(key)` helper.
 * @param {string} [userId]
 */
export async function getConfig(userId) {
  const [system, user] = await Promise.all([loadSystemOverrides(), loadUserOverrides(userId)]);
  const values = {};
  for (const field of SCHEMA) values[field.key] = resolveField(field, { user, system });
  return makeView(values);
}

function makeView(values) {
  return Object.freeze({
    ...values,
    get(key) {
      if (!BY_KEY.has(key)) throw new Error(`unknown hedwig config key: ${key}`);
      return values[key];
    },
  });
}

/** Where each value came from — for the settings UI. Secrets are masked. */
export async function describeConfig(userId) {
  const [system, user] = await Promise.all([loadSystemOverrides(), loadUserOverrides(userId)]);
  return SCHEMA.map((field) => {
    let source = 'default';
    if (field.scope === 'user' && user[field.key] !== undefined) source = 'user';
    else if (system[field.key] !== undefined) source = 'admin';
    else if (envValue(field) !== undefined) source = 'env';
    let value = resolveField(field, { user, system });
    if (field.type === 'secret') value = value ? '••••••••' : '';
    return { ...field, value, source, env: envNameFor(field.key) };
  });
}

function validatePatch(patch, { allowScope }) {
  const out = {};
  const errors = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    const field = BY_KEY.get(key);
    if (!field) { errors.push(`unknown key ${key}`); continue; }
    if (allowScope === 'user' && field.scope !== 'user') { errors.push(`${key} is not a per-user setting`); continue; }
    if (raw === null) { out[key] = null; continue; } // null = clear the override
    if (field.type === 'secret' && raw === '••••••••') continue; // unchanged mask
    const v = coerce(field, raw);
    if (v === undefined) { errors.push(`invalid value for ${key}`); continue; }
    out[key] = v;
  }
  return { out, errors };
}

/** Merge an admin patch into system overrides. `null` clears a key. */
export async function saveSystemConfig(patch) {
  const { out, errors } = validatePatch(patch, { allowScope: 'system' });
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const current = { ...(await loadSystemOverrides()) };
  for (const [k, v] of Object.entries(out)) {
    if (v === null) delete current[k];
    else current[k] = BY_KEY.get(k).type === 'secret' && v ? encrypt(v) : v;
  }
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('hedwig_config', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(current)],
  );
  invalidateConfigCache();
  return current;
}

/** Merge a per-user patch. Only keys with scope 'user' are accepted. */
export async function saveUserConfig(userId, patch) {
  const { out, errors } = validatePatch(patch, { allowScope: 'user' });
  if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; throw e; }
  const current = { ...(await loadUserOverrides(userId)) };
  for (const [k, v] of Object.entries(out)) {
    if (v === null) delete current[k]; else current[k] = v;
  }
  await query(
    `INSERT INTO hedwig_user_settings (user_id, settings, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET settings = $2, updated_at = NOW()`,
    [userId, JSON.stringify(current)],
  );
  invalidateConfigCache(userId);
  return current;
}
