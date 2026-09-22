// The per-plugin capability facade handed to a v2 plugin's activate(hedwig). It is the whole of
// what a plugin can do: every capability takes the acting userId first and checks, at call time,
// that this user activated the plugin, that the manifest declares the permission and that the user
// granted it (access.js). The object is deep-frozen so a plugin cannot swap a capability for
// another plugin or widen its own.
import { query } from '../../services/db.js';
import { chat, chatJson, llmAvailable, extractJson } from '../llm.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { addressesOf, domainOf, messageText } from '../text.js';
import { assertAllowed, getAccess } from './access.js';
import { PermissionError, PluginInputError } from './errors.js';
import { HEDWIG_PLUGIN_API } from './manifest.js';
import * as mail from './mail.js';
import { storageGet, storageSet, storageList, storageDelete, settingsGet, settingsSet } from './store.js';
import { assertNetHost, pluginFetch } from './net.js';
import { createPluginRouter } from './router.js';

const MAX_LLM_CHARS = 48_000;

function text(v, name, max = MAX_LLM_CHARS) {
  if (typeof v !== 'string' || !v.trim()) throw new PluginInputError(`${name} must be a non-empty string`);
  return v.length > max ? v.slice(0, max) : v;
}

function makeLogger(pluginId) {
  const tag = `[plugin ${pluginId}]`;
  const fmt = (args) => args.map((a) => (a instanceof Error ? a.message : a));
  return Object.freeze({
    debug: (...a) => { if (process.env.HEDWIG_PLUGIN_DEBUG) console.debug(tag, ...fmt(a)); },
    info: (...a) => console.log(tag, ...fmt(a)),
    warn: (...a) => console.warn(tag, ...fmt(a)),
    error: (...a) => console.error(tag, ...fmt(a)),
  });
}

async function loadContextService() {
  try {
    return await import('../context/service.js');
  } catch {
    throw new PluginInputError('the context engine is not available on this server');
  }
}

function deepFreeze(o) {
  if (o && (typeof o === 'object' || typeof o === 'function') && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * @param {{ id: string, upstreamId: string, manifest: object, tier: number }} plugin
 * @param {object} rt runtime services owned by the loader:
 *   mailAction(plugin, userId, action, args) → result | { queued, jobId }
 *   broadcast(plugin, userId, payload) → boolean
 *   jobNames(pluginId) → Set of job names the plugin returned from activate()
 */
export function createFacade(plugin, rt) {
  const { id: pluginId, manifest } = plugin;
  const guard = (permission, fn) => async (userId, ...args) => {
    await assertAllowed(plugin, userId, permission);
    return fn(userId, ...args);
  };

  const hedwig = {
    pluginId,
    apiVersion: HEDWIG_PLUGIN_API,
    manifest,
    PermissionError,
    logger: makeLogger(pluginId),

    /** Whether the user has this plugin activated (no permission needed). */
    isActive: async (userId) => (await getAccess(userId, pluginId)).active,

    mail: {
      listAccounts: guard('mail.read', (u) => mail.listAccounts(u)),
      search: guard('mail.read', (u, opts) => mail.search(u, opts || {})),
      getMessage: guard('mail.read', (u, messageId, opts) => mail.getMessage(u, messageId, { html: opts?.html === true })),
      getThread: guard('mail.read', (u, messageId) => mail.getThread(u, messageId)),
      findByMessageId: guard('mail.read', (u, header, opts) => mail.findByMessageId(u, header, { html: opts?.html === true })),
      applyLabel: guard('mail.write', (u, messageId, labelFolder) => rt.mailAction(plugin, u, 'applyLabel', { messageId, labelFolder })),
      archive: guard('mail.write', (u, messageId) => rt.mailAction(plugin, u, 'archive', { messageId })),
    },

    context: {
      search: guard('context.read', async (u, opts) => {
        const svc = await loadContextService();
        const o = { ...(opts || {}) };
        o.limit = Math.max(1, Math.min(50, Number(o.limit) || 10));
        return svc.searchMessages(u, o);
      }),
      getPerson: guard('context.read', async (u, idOrEmail) => {
        const svc = await loadContextService();
        if (typeof idOrEmail !== 'string' || !idOrEmail) throw new PluginInputError('getPerson needs an entity id or an email address');
        if (idOrEmail.includes('@')) {
          const r = await svc.resolveEntityByEmail(u, idOrEmail.trim().toLowerCase());
          if (!r) return null;
          if (r.entity) return r;
          return r.id ? svc.getEntityCard(u, r.id) : null;
        }
        return mail.isUuid(idOrEmail) ? svc.getEntityCard(u, idOrEmail) : null;
      }),
      listCommitments: guard('context.read', async (u, opts) => (await loadContextService()).listCommitments(u, opts || {})),
      addFact: guard('context.write', (u, fact) => addFact(pluginId, u, fact)),
    },

    triage: {
      get: guard('triage.hook', (u, messageId) => getTriage(u, messageId)),
    },

    llm: {
      available: async (userId) => { await assertAllowed(plugin, userId, null); return llmAvailable(userId); },
      summarize: guard('llm.summarize', async (u, input, opts = {}) => {
        const body = text(typeof input === 'string' ? input : input?.text, 'text');
        const maxWords = Math.max(5, Math.min(200, Number(opts.maxWords) || 40));
        const res = await chat({
          userId: u, feature: 'summary', pluginId, role: opts.role === 'fast' ? 'fast' : 'long', maxTokens: 600,
          messages: [
            { role: 'system', content: `Summarize the text the user sends in at most ${maxWords} words. ${opts.instructions ? String(opts.instructions).slice(0, 500) + ' ' : ''}Reply with the summary only, no preamble.` },
            { role: 'user', content: body },
          ],
        });
        return (res.content || '').trim();
      }),
      extract: guard('llm.extract', async (u, input = {}) => {
        const body = text(input.text, 'text');
        const schema = input.schema && typeof input.schema === 'object' ? input.schema : null;
        const system = `${input.instructions ? String(input.instructions).slice(0, 2000) : 'Extract the requested fields from the text.'} `
          + 'Reply with a single JSON object only. Use null for anything the text does not state.'
          + (schema ? ` The object must match this JSON schema: ${JSON.stringify(schema).slice(0, 4000)}` : '');
        const res = await chatJson({
          userId: u, feature: 'extraction', pluginId, role: 'fast', maxTokens: 1200, json: schema ? { name: 'extract', schema } : true,
          messages: [{ role: 'system', content: system }, { role: 'user', content: body }],
        });
        return res.data ?? null;
      }),
      chat: guard('llm.chat', async (u, input = {}) => {
        const msgs = input.messages;
        if (!Array.isArray(msgs) || !msgs.length || msgs.length > 50) throw new PluginInputError('messages must be an array of 1–50 { role, content }');
        let total = 0;
        const clean = msgs.map((m, i) => {
          if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new PluginInputError(`messages[${i}] must be { role: system|user|assistant, content: string }`);
          total += m.content.length;
          return { role: m.role, content: m.content };
        });
        if (total > MAX_LLM_CHARS * 2) throw new PluginInputError('messages are too long');
        const res = await chat({
          userId: u, feature: 'plugin', pluginId, role: input.role === 'fast' ? 'fast' : 'long', messages: clean,
          json: input.json === true ? true : undefined,
          maxTokens: Math.max(16, Math.min(4000, Number(input.maxTokens) || 1000)),
          temperature: Number.isFinite(input.temperature) ? input.temperature : undefined,
        });
        return { content: res.content, data: input.json === true ? extractJson(res.content) : undefined };
      }),
    },

    compose: {
      /** Create a draft (never sends). Returns { created, uid, folder } or { queued, jobId } from the worker. */
      createDraft: guard('compose.draft', (u, input) => rt.mailAction(plugin, u, 'createDraft', { input })),
    },

    storage: {
      get: guard('storage', (u, key) => storageGet(pluginId, u, key)),
      set: guard('storage', (u, key, value) => storageSet(pluginId, u, key, value)),
      list: guard('storage', (u, opts) => storageList(pluginId, u, opts || {})),
      delete: guard('storage', (u, key) => storageDelete(pluginId, u, key)),
    },

    settings: {
      get: guard(null, (u) => settingsGet(manifest, u)),
      set: guard(null, (u, patch) => settingsSet(manifest, u, patch)),
    },

    net: {
      fetch: async (userId, url, init) => {
        await assertAllowed(plugin, userId, null);
        const settings = await settingsGet(manifest, userId);
        const permission = assertNetHost(plugin, url, settings);
        await assertAllowed(plugin, userId, permission);
        return pluginFetch(pluginId, url, init || {});
      },
    },

    jobs: {
      enqueue: guard(null, async (u, name, payload = {}, opts = {}) => {
        if (!rt.jobNames(pluginId).has(name)) throw new PluginInputError(`job "${name}" is not declared by ${pluginId}`);
        const json = JSON.stringify(payload ?? {});
        if (json.length > 64 * 1024) throw new PluginInputError('job payload larger than 64 KB');
        return enqueue(`plugin.${pluginId}.${name}`, { userId: u, payload: JSON.parse(json) }, {
          userId: u,
          dedupeKey: opts.dedupeKey ? `plugin:${pluginId}:${u}:${String(opts.dedupeKey).slice(0, 200)}` : null,
          runAt: opts.runAt ? new Date(opts.runAt) : null,
          priority: 7,
          maxAttempts: 3,
        });
      }),
    },

    user: {
      timezone: guard(null, async (u) => (await getConfig(u))['insights.timezone'] || 'UTC'),
    },

    /** Push a realtime message to the user's open sessions as { type: 'hedwig.plugin', pluginId, payload }. */
    broadcast: guard(null, async (u, payload) => {
      const json = JSON.stringify(payload ?? null);
      if (json.length > 64 * 1024) throw new PluginInputError('broadcast payload larger than 64 KB');
      return rt.broadcast(plugin, u, JSON.parse(json));
    }),

    /**
     * A router for the plugin's own routes, mounted at /api/hedwig/p/<pluginId>/. Handlers get
     * (req, res) where req = { userId, method, path, params, query, body, headers } (frozen).
     */
    router: () => createPluginRouter(),

    util: { messageText, addressesOf, domainOf, extractJson },
  };
  return deepFreeze(hedwig);
}

async function addFact(pluginId, userId, fact) {
  if (!fact || typeof fact !== 'object') throw new PluginInputError('addFact needs { key, value }');
  const key = text(fact.key, 'key', 120);
  const value = text(String(fact.value ?? ''), 'value', 2000);
  const refs = [['entityId', 'hedwig_entities'], ['topicId', 'hedwig_topics']];
  for (const [field, table] of refs) {
    if (fact[field] === undefined || fact[field] === null) continue;
    if (!mail.isUuid(fact[field])) throw new PluginInputError(`${field} must be a uuid`);
    const { rows } = await query(`SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`, [fact[field], userId]);
    if (!rows.length) throw new PluginInputError(`${field} not found`);
  }
  if (fact.sourceMessageId !== undefined && fact.sourceMessageId !== null) {
    if (!(await mail.getMessage(userId, fact.sourceMessageId))) throw new PluginInputError('sourceMessageId not found');
  }
  const confidence = Number.isFinite(fact.confidence) ? Math.max(0, Math.min(1, fact.confidence)) : null;
  const { rows } = await query(
    `INSERT INTO hedwig_facts (user_id, entity_id, topic_id, key, value, source_message_id, confidence, plugin_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [userId, fact.entityId || null, fact.topicId || null, key, value, fact.sourceMessageId || null, confidence, pluginId],
  );
  return { id: rows[0]?.id ?? null };
}

async function getTriage(userId, messageId) {
  if (!mail.isUuid(messageId)) return null;
  const { rows } = await query(
    `SELECT COALESCE(override_category, category) AS category, priority, needs_you, confidence, stage,
            reason_label, reasons, overridden, decided_at
       FROM hedwig_triage WHERE message_id = $1 AND user_id = $2`,
    [messageId, userId],
  );
  return rows[0] || null;
}
