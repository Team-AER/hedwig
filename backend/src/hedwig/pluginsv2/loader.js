// Plugin runtime v2: discovers, validates, pins, activates, reloads and uninstalls plugins.
//
// Sources:
//   bundled — first-party plugins in backend/src/plugins/<name>/ (tier 1), imported statically
//   dir     — each subdirectory of config `plugins.dir` holding a hedwig.plugin.json (tier 2)
//   git     — an admin install: `git clone --depth 1` into plugins.dir/<id> (tier 2)
//
// Each plugin registers one shim into upstream's pluginRegistry under its upstream-mapped id
// (dots → '-'), so Hedwig hook sites and upstream hook sites reach it through the same registry,
// and /api/plugins plus the old Settings → Plugins tab list and toggle it. The shim's hooks are
// swapped in place on reload (the registry has no unregister). Every hook handler re-checks, per
// call, that the user in the hook's ctx activated the plugin and granted the hook's permission.
//
// Runs in both processes. The API mounts routers and runs API-side actions (mail writes, drafts);
// the worker defines plugin jobs and schedules. A plugin that fails to load is recorded with status
// 'error' and never takes the process down.
import { randomBytes } from 'crypto';
import { readFile, readdir, stat, rm, rename, mkdir, realpath, lstat } from 'fs/promises';
import { join, resolve, sep, basename } from 'path';
import { pathToFileURL } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query } from '../../services/db.js';
import { pluginRegistry as defaultRegistry } from '../../plugins/registry.js';
import { registerTool as defaultRegisterTool, unregisterPluginTools as defaultUnregisterTools } from '../agent/toolRegistry.js';
import { defineJob as defaultDefineJob, enqueue } from '../jobs.js';
import { defineSchedule as defaultDefineSchedule } from '../schedule.js';
import { getConfig } from '../config.js';
import { HOOKS, validateManifest, upstreamIdFor, toolPrefix } from './manifest.js';
import { ManifestError, PluginInputError } from './errors.js';
import { createFacade } from './facade.js';
import { assertAllowed, getAccess, usersWith } from './access.js';
import { checkPluginDir, hashPluginDir as sha256Dir } from './boundary.js';
import { isPluginRouter } from './router.js';
import * as mail from './mail.js';
import { createDraftNow } from './drafts.js';

const execFileP = promisify(execFile);
const RETURN_KEYS = new Set(['hooks', 'router', 'tools', 'jobs', 'schedules', 'collectInsights']);
const NAME_RE = /^[a-z][a-z0-9_-]{0,40}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const ACTIVATE_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
export const ACTION_JOB = 'pluginsv2.action';

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}

/** A plain, bounded copy of a hook ctx: no functions, engines, account rows or class instances. */
export function plainClone(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (depth > 6) return undefined;
  if (typeof v === 'string') return v.length > 200_000 ? v.slice(0, 200_000) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return undefined;
  if (v instanceof Set) return [...v].slice(0, 1000).map((x) => plainClone(x, depth + 1));
  if (v instanceof Map) return plainClone(Object.fromEntries(v), depth);
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => plainClone(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const c = plainClone(x, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

const CTX_DROP = new Set(['imapManager', 'mgr', 'account', 'getConfig', 'client', 'engine', 'db', 'req', 'res']);
const LITE_KEYS = ['id', 'account_id', 'folder', 'subject', 'from_name', 'from_email', 'sender_email', 'to_addresses',
  'cc_addresses', 'date', 'snippet', 'is_read', 'has_attachments', 'thread_key', 'is_bulk', 'category', 'is_outgoing', 'in_reply_to'];

/** Reduce a message row to headers and snippet: hooks that need the body call mail.getMessage. */
function liteRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of LITE_KEYS) if (row[k] !== undefined) out[k] = row[k];
  if (row.list_unsubscribe !== undefined) out.has_list_unsubscribe = Boolean(row.list_unsubscribe);
  return out;
}

export function sanitizeHookCtx(hook, ctx, userId) {
  if (hook === 'onSentMessage') {
    return Object.freeze({ userId, accountId: ctx?.account?.id ?? null, messageIdHeader: ctx?.messageId ?? null });
  }
  const src = {};
  for (const [k, v] of Object.entries(ctx || {})) {
    if (CTX_DROP.has(k)) continue;
    src[k] = (k === 'message' || k === 'row') && (hook === 'beforeTriage' || hook === 'afterTriage') ? liteRow(v) : v;
  }
  if (ctx?.account?.id && src.accountId === undefined) src.accountId = ctx.account.id;
  src.userId = userId;
  const clone = plainClone(src);
  return Object.freeze(clone);
}

function str(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

export function normaliseHookResult(hook, res, pluginId) {
  if (res === undefined || res === null) return undefined;
  switch (hook) {
    case 'beforeSend': {
      if (typeof res !== 'object') return undefined;
      const block = res.block === true;
      const warn = str(res.warn, 500);
      if (!block && !warn) return undefined;
      return { block, warn, reason: str(res.reason, 500) || (block ? warn : undefined), pluginId, findings: plainClone(res.findings) };
    }
    case 'beforeTriage': {
      if (typeof res !== 'object') return undefined;
      const out = { pluginId };
      if (res.features && typeof res.features === 'object') {
        out.features = {};
        for (const [k, v] of Object.entries(res.features).slice(0, 50)) if (Number.isFinite(v)) out.features[`${pluginId}:${k}`.slice(0, 120)] = v;
      }
      if (res.verdict && typeof res.verdict === 'object' && typeof res.verdict.category === 'string') {
        out.verdict = { category: res.verdict.category.slice(0, 40), reason: str(res.verdict.reason, 200) || `Set by ${pluginId}` };
      }
      return out.features || out.verdict ? out : undefined;
    }
    case 'collectInsights': {
      const cards = (Array.isArray(res) ? res : [res]).filter((c) => c && typeof c === 'object' && str(c.title, 200)).slice(0, 10);
      if (!cards.length) return undefined;
      return cards.map((c) => ({
        title: str(c.title, 200),
        body: str(c.body, 4000) || '',
        severity: ['info', 'warn', 'alert'].includes(c.severity) ? c.severity : 'info',
        data: plainClone(c.data) ?? null,
        sources: Array.isArray(c.sources) ? c.sources.filter((s) => mail.isUuid(s)).slice(0, 50) : [],
        pluginId,
      }));
    }
    default:
      return undefined; // run-hooks: results are ignored
  }
}

async function readManifestFile(dir) {
  const p = join(dir, 'hedwig.plugin.json');
  const info = await stat(p).catch(() => null);
  if (!info?.isFile()) throw new ManifestError(['hedwig.plugin.json not found'], dir);
  if (info.size > MAX_MANIFEST_BYTES) throw new ManifestError(['hedwig.plugin.json is larger than 64 KB'], dir);
  let raw;
  try { raw = JSON.parse(await readFile(p, 'utf8')); } catch (err) { throw new ManifestError([`invalid JSON: ${err.message}`], 'hedwig.plugin.json'); }
  return raw;
}

export class PluginRuntime {
  /**
   * @param {object} [o]
   * @param {'api'|'worker'|'test'} [o.processKind]
   * @param {object} [o.registry] upstream plugin registry
   * @param {Array<{ manifest, activate }>} [o.bundled] first-party plugins
   * @param {string} [o.pluginsDir] overrides config plugins.dir
   * @param {boolean} [o.useDb] record external plugins in hedwig_plugins (default true)
   */
  constructor(o = {}) {
    this.processKind = o.processKind || 'test';
    this.registry = o.registry || defaultRegistry;
    this.bundled = o.bundled || [];
    this.pluginsDirOverride = o.pluginsDir || null;
    this.useDb = o.useDb !== false;
    this.registerTool = o.registerTool || defaultRegisterTool;
    this.unregisterPluginTools = o.unregisterPluginTools || defaultUnregisterTools;
    this.defineJob = o.defineJob || defaultDefineJob;
    this.defineSchedule = o.defineSchedule || defaultDefineSchedule;
    this.engine = null;
    this.entries = new Map(); // id -> entry
    this.shims = new Map(); // upstreamId -> shim
    this.definedKinds = new Set();
    this.definedSchedules = new Set();
    this.rtServices = {
      mailAction: (plugin, userId, action, args) => this.mailAction(plugin, userId, action, args),
      broadcast: (plugin, userId, payload) => this.broadcast(plugin, userId, payload),
      jobNames: (id) => new Set(Object.keys(this.entries.get(id)?.instance?.jobs || {})),
    };
  }

  // ── lookup ────────────────────────────────────────────────────────────────
  get(id) { return this.entries.get(id) || null; }
  list() { return [...this.entries.values()]; }
  ids() { return [...this.entries.keys()]; }

  setEngine(engine) {
    this.engine = engine;
    mail.setEngineAvailability(() => Boolean(this.engine));
  }

  async pluginsDir() {
    if (this.pluginsDirOverride) return this.pluginsDirOverride;
    const cfg = await getConfig();
    return cfg['plugins.dir'] || null;
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  async loadAll() {
    for (const b of this.bundled) await this.loadBundled(b);
    await this.scanDir();
    return this.list();
  }

  async loadBundled({ manifest: raw, activate }) {
    let entry;
    try {
      const manifest = validateManifest(raw, { tier: 1, source: `bundled plugin ${raw?.id}` });
      entry = this.entryFor(manifest, { source: 'bundled', location: `backend/src/plugins/${manifest.id.split('.').pop()}`, dir: null });
      entry.activateFn = activate;
      await this.activateEntry(entry);
    } catch (err) {
      this.recordError(entry || { id: raw?.id || 'unknown', manifest: raw }, err, { source: 'bundled' });
    }
  }

  async scanDir() {
    const dir = await this.pluginsDir();
    if (!dir) return;
    let names;
    try { names = await readdir(dir); } catch { return; } // no plugins dir: nothing external
    const rows = await this.dbRows();
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      const info = await stat(full).catch(() => null);
      if (!info?.isDirectory()) continue;
      if (!(await stat(join(full, 'hedwig.plugin.json')).catch(() => null))) continue;
      await this.loadExternal(full, { row: rows.get(name) || null });
    }
  }

  async dbRows() {
    const map = new Map();
    if (!this.useDb) return map;
    try {
      const { rows } = await query('SELECT id, source, location, manifest, sha256, status, error, installed_by, installed_at, updated_at FROM hedwig_plugins');
      for (const r of rows) map.set(r.id, r);
    } catch (err) {
      console.warn('[pluginsv2] could not read hedwig_plugins:', err.message);
    }
    return map;
  }

  /**
   * Load one external plugin directory.
   * @param {string} dir
   * @param {{ row?: object, accept?: boolean, source?: string, location?: string, installedBy?: string }} o
   *   accept: trust the directory's current sha256 (admin install or reload); otherwise the files
   *   must match the sha256 recorded at install.
   */
  async loadExternal(dir, o = {}) {
    let entry = null;
    let id = basename(dir);
    try {
      const raw = await readManifestFile(dir);
      id = typeof raw?.id === 'string' ? raw.id : id;
      const manifest = validateManifest(raw, { tier: 2, source: `${basename(dir)}/hedwig.plugin.json` });
      if (basename(dir) !== manifest.id) throw new PluginInputError(`directory name "${basename(dir)}" must equal the plugin id "${manifest.id}"`);
      const existing = this.entries.get(manifest.id);
      if (existing?.source === 'bundled') throw new PluginInputError(`id ${manifest.id} is taken by a bundled plugin`);
      const problems = await checkPluginDir(dir, manifest);
      if (problems.length) throw new PluginInputError(`boundary check failed: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? ` (+${problems.length - 10} more)` : ''}`);
      const sha256 = await sha256Dir(dir);
      const row = o.row === undefined ? (await this.dbRows()).get(manifest.id) || null : o.row;
      const source = o.source || row?.source || 'dir';
      entry = this.entryFor(manifest, { source, location: o.location || row?.location || dir, dir, sha256 });
      if (row?.sha256 && row.sha256 !== sha256 && !o.accept) {
        throw new PluginInputError(`files changed since install (sha256 ${sha256.slice(0, 12)} ≠ pinned ${row.sha256.slice(0, 12)}); an admin must reload it to accept the change`);
      }
      if (!row && !o.accept && this.processKind === 'worker') {
        entry.status = 'pending';
        entry.error = 'waiting for the API process to record this plugin';
        return entry;
      }
      if (this.processKind !== 'worker') await this.recordRow(entry, { installedBy: o.installedBy, pin: Boolean(o.accept || !row) });
      if (manifest.backend) {
        const url = `${pathToFileURL(resolve(dir, manifest.backend)).href}?v=${sha256.slice(0, 16)}-${Date.now().toString(36)}`;
        const mod = await withTimeout(import(url), ACTIVATE_TIMEOUT_MS, `import of ${manifest.id}`);
        if (typeof mod.default !== 'function') throw new PluginInputError(`${manifest.backend} must default-export activate(hedwig)`);
        entry.activateFn = mod.default;
      } else {
        entry.activateFn = () => ({});
      }
      await this.activateEntry(entry);
      if (this.processKind !== 'worker') await this.recordRow(entry, {});
    } catch (err) {
      this.recordError(entry || { id, manifest: null, dir }, err, { source: o.source || 'dir', dir });
      if (entry && this.processKind !== 'worker') await this.recordRow(entry, {}).catch(() => {});
    }
    return this.entries.get(id) || entry;
  }

  entryFor(manifest, { source, location, dir, sha256 = null }) {
    const prev = this.entries.get(manifest.id);
    const entry = {
      id: manifest.id,
      upstreamId: upstreamIdFor(manifest.id),
      manifest,
      tier: manifest.tier,
      source,
      location,
      dir,
      sha256,
      status: 'loading',
      error: null,
      instance: null,
      facade: null,
      toolNames: [],
      loadedAt: null,
      previous: prev || null,
    };
    this.entries.set(manifest.id, entry);
    return entry;
  }

  recordError(entry, err, { source, dir } = {}) {
    const message = err instanceof ManifestError ? err.message : (err?.message || String(err));
    console.warn(`[pluginsv2] plugin ${entry.id} failed to load: ${message}`);
    const e = this.entries.get(entry.id) || entry;
    if (e.previous) this.teardown(e.previous);
    this.teardown(e);
    Object.assign(e, {
      id: entry.id,
      upstreamId: e.upstreamId || upstreamIdFor(entry.id),
      source: e.source || source,
      dir: e.dir || dir || null,
      status: 'error',
      error: message.slice(0, 2000),
      instance: null,
    });
    e.previous = null;
    this.entries.set(e.id, e);
  }

  // ── activation ────────────────────────────────────────────────────────────
  async activateEntry(entry) {
    const plugin = Object.freeze({ id: entry.id, upstreamId: entry.upstreamId, manifest: entry.manifest, tier: entry.tier });
    this.ensureShim(entry);
    const facade = createFacade(plugin, this.rtServices);
    const result = await withTimeout(entry.activateFn(facade), ACTIVATE_TIMEOUT_MS, `activate() of ${entry.id}`);
    const instance = this.normaliseInstance(entry, result);
    // Only now replace a previous version: a failed reload leaves the plugin in 'error', never half-swapped.
    if (entry.previous) this.teardown(entry.previous);
    entry.previous = null;
    entry.plugin = plugin;
    entry.facade = facade;
    entry.instance = instance;
    this.installHooks(entry);
    this.installTools(entry);
    if (this.processKind === 'worker') this.installJobsAndSchedules(entry);
    entry.status = 'loaded';
    entry.error = null;
    entry.loadedAt = new Date().toISOString();
  }

  normaliseInstance(entry, result) {
    const m = entry.manifest;
    const r = result === undefined || result === null ? {} : result;
    if (typeof r !== 'object') throw new PluginInputError('activate() must return an object');
    for (const k of Object.keys(r)) if (!RETURN_KEYS.has(k)) throw new PluginInputError(`activate() returned unknown key "${k}"`);
    const hooks = {};
    for (const [name, fn] of Object.entries(r.hooks || {})) {
      if (typeof fn !== 'function') throw new PluginInputError(`hook ${name} must be a function`);
      if (!m.hooks.includes(name)) throw new PluginInputError(`hook ${name} is not listed in the manifest "hooks"`);
      hooks[name] = fn;
    }
    if (r.collectInsights) {
      if (typeof r.collectInsights !== 'function') throw new PluginInputError('collectInsights must be a function');
      if (!m.hooks.includes('collectInsights')) throw new PluginInputError('collectInsights is not listed in the manifest "hooks"');
      hooks.collectInsights = r.collectInsights;
    }
    for (const h of m.hooks) if (!hooks[h]) throw new PluginInputError(`manifest lists hook ${h} but activate() did not return it`);

    if (r.router !== undefined && !isPluginRouter(r.router)) throw new PluginInputError('router must come from hedwig.router()');

    const tools = [];
    if (r.tools !== undefined) {
      if (!Array.isArray(r.tools)) throw new PluginInputError('tools must be an array');
      if (r.tools.length && !m.permissions.some((p) => p.name === 'agent.tools')) throw new PluginInputError('tools need the "agent.tools" permission');
      for (const t of r.tools) {
        if (!t || typeof t.handler !== 'function' || typeof t.description !== 'string') throw new PluginInputError('each tool needs { name, description, handler }');
        const name = `${toolPrefix(entry.id)}${t.name}`;
        if (!TOOL_NAME_RE.test(name)) throw new PluginInputError(`tool name ${name} must match ${TOOL_NAME_RE}`);
        if (t.permission && !m.permissions.some((p) => p.name === t.permission)) throw new PluginInputError(`tool ${t.name} needs undeclared permission ${t.permission}`);
        tools.push({ ...t, fullName: name });
      }
    }

    const jobs = {};
    for (const [name, fn] of Object.entries(r.jobs || {})) {
      if (!NAME_RE.test(name) || typeof fn !== 'function') throw new PluginInputError(`job ${name} must be a function with a name matching ${NAME_RE}`);
      jobs[name] = fn;
    }

    const schedules = new Map();
    if (r.schedules !== undefined) {
      if (!Array.isArray(r.schedules)) throw new PluginInputError('schedules must be an array');
      if (r.schedules.length && !m.permissions.some((p) => p.name === 'schedule')) throw new PluginInputError('schedules need the "schedule" permission');
      for (const s of r.schedules) {
        if (!s || !NAME_RE.test(s.name || '') || typeof s.run !== 'function') throw new PluginInputError(`each schedule needs { name, everySec, run } with a name matching ${NAME_RE}`);
        if (!(Number(s.everySec) >= 60)) throw new PluginInputError(`schedule ${s.name}: everySec must be at least 60`);
        schedules.set(s.name, { name: s.name, everySec: Math.floor(Number(s.everySec)), run: s.run });
      }
    }
    return { hooks, router: r.router || null, tools, jobs, schedules };
  }

  ensureShim(entry) {
    let shim = this.shims.get(entry.upstreamId);
    if (shim) {
      if (shim.__v2Id !== entry.id) throw new PluginInputError(`id ${entry.id} collides with ${shim.__v2Id} (both register upstream as ${entry.upstreamId})`);
      return shim;
    }
    if (this.registry.has(entry.upstreamId)) throw new PluginInputError(`id ${entry.id} collides with the upstream plugin "${entry.upstreamId}"`);
    const rt = this;
    const id = entry.id;
    shim = {
      id: entry.upstreamId,
      get name() { return rt.entries.get(id)?.manifest?.name || id; },
      get version() { return rt.entries.get(id)?.manifest?.version || '0.0.0'; },
      tier: entry.tier,
      hooks: {},
    };
    Object.defineProperty(shim, '__v2Id', { value: id, enumerable: false });
    this.registry.register(shim);
    this.shims.set(entry.upstreamId, shim);
    return shim;
  }

  installHooks(entry) {
    const shim = this.shims.get(entry.upstreamId);
    for (const k of Object.keys(shim.hooks)) delete shim.hooks[k];
    for (const [name, fn] of Object.entries(entry.instance.hooks)) {
      const def = HOOKS[name];
      shim.hooks[def.registry] = this.wrapHook(entry, name, fn);
    }
  }

  wrapHook(entry, name, fn) {
    const def = HOOKS[name];
    return async (ctx) => {
      const current = this.entries.get(entry.id);
      if (current !== entry || entry.status !== 'loaded') return undefined;
      const userId = ctx?.userId || ctx?.account?.user_id;
      if (!userId) return undefined;
      const acc = await getAccess(userId, entry.id);
      if (!acc.active) return undefined;
      if (def.permission && !acc.grants.has(def.permission)) return undefined;
      try {
        const res = await withTimeout(fn(sanitizeHookCtx(name, ctx, userId)), def.timeoutMs, `hook ${name}`);
        return normaliseHookResult(name, res, entry.id);
      } catch (err) {
        entry.lastHookError = { hook: name, at: new Date().toISOString(), message: String(err?.message || err).slice(0, 500) };
        console.warn(`[pluginsv2] ${entry.id} hook ${name} failed:`, err?.message || err);
        return undefined;
      }
    };
  }

  installTools(entry) {
    this.unregisterPluginTools(entry.id);
    entry.toolNames = [];
    for (const t of entry.instance.tools) {
      const plugin = entry.plugin;
      this.registerTool({
        name: t.fullName,
        description: t.description.slice(0, 1000),
        parameters: t.parameters && typeof t.parameters === 'object' ? plainClone(t.parameters) : { type: 'object', properties: {} },
        mutates: t.mutates === true,
        pluginId: entry.id,
        permission: 'agent.tools',
        summarize: typeof t.summarize === 'function'
          ? (args) => { try { return String(t.summarize(plainClone(args)) || '').slice(0, 300); } catch { return t.fullName; } }
          : undefined,
        handler: async (args, ctx) => {
          await assertAllowed(plugin, ctx?.userId, 'agent.tools');
          if (t.permission) await assertAllowed(plugin, ctx.userId, t.permission);
          const res = await withTimeout(t.handler(plainClone(args) || {}, Object.freeze({ userId: ctx.userId, runId: ctx.runId || null })), 60_000, `tool ${t.fullName}`);
          return plainClone(res);
        },
      });
      entry.toolNames.push(t.fullName);
    }
  }

  installJobsAndSchedules(entry) {
    for (const name of Object.keys(entry.instance.jobs)) {
      const kind = `plugin.${entry.id}.${name}`;
      if (this.definedKinds.has(kind)) continue;
      this.definedKinds.add(kind);
      this.defineJob(kind, async (payload) => {
        const e = this.entries.get(entry.id);
        const fn = e?.status === 'loaded' ? e.instance.jobs[name] : null;
        if (!fn) throw Object.assign(new Error(`plugin ${entry.id} is not loaded or no longer defines job ${name}`), { permanent: true });
        await assertAllowed(e.plugin, payload?.userId, null);
        return fn(plainClone(payload?.payload) ?? {}, Object.freeze({ userId: payload.userId }));
      }, { timeoutMs: 5 * 60_000 });
    }
    for (const s of entry.instance.schedules.values()) {
      const name = `plugin.${entry.id}.${s.name}`;
      if (this.definedSchedules.has(name)) continue;
      this.definedSchedules.add(name);
      this.defineSchedule({ name, everySec: s.everySec, run: () => this.runSchedule(entry.id, s.name) });
    }
  }

  /** Run one plugin schedule once per user who activated the plugin and granted `schedule`. */
  async runSchedule(id, scheduleName) {
    const e = this.entries.get(id);
    const s = e?.status === 'loaded' ? e.instance.schedules.get(scheduleName) : null;
    if (!s) return 0;
    const users = await usersWith(id, 'schedule');
    let ran = 0;
    for (const userId of users) {
      try {
        await withTimeout(s.run(Object.freeze({ userId })), 5 * 60_000, `schedule ${scheduleName}`);
        ran++;
      } catch (err) {
        e.lastHookError = { hook: `schedule:${scheduleName}`, at: new Date().toISOString(), message: String(err?.message || err).slice(0, 500) };
        console.warn(`[pluginsv2] ${id} schedule ${scheduleName} failed for a user:`, err?.message || err);
      }
    }
    return ran;
  }

  teardown(entry) {
    if (!entry) return;
    const shim = this.shims.get(entry.upstreamId || upstreamIdFor(entry.id));
    if (shim && this.entries.get(entry.id) === entry) for (const k of Object.keys(shim.hooks)) delete shim.hooks[k];
    if (entry.toolNames?.length || entry.instance?.tools?.length) this.unregisterPluginTools(entry.id);
    entry.toolNames = [];
  }

  // ── API-side services for the facade ─────────────────────────────────────
  async mailAction(plugin, userId, action, args) {
    if (!this.engine) {
      const jobId = await enqueue(ACTION_JOB, { pluginId: plugin.id, userId, action, args: plainClone(args) }, { userId, priority: 4, maxAttempts: 3 });
      return { queued: true, jobId };
    }
    return this.runAction(plugin, userId, action, args);
  }

  async runAction(plugin, userId, action, args = {}) {
    switch (action) {
      case 'applyLabel':
        await assertAllowed(plugin, userId, 'mail.write');
        return mail.applyLabelNow(userId, args.messageId, args.labelFolder);
      case 'archive':
        await assertAllowed(plugin, userId, 'mail.write');
        return mail.archiveNow(userId, args.messageId);
      case 'createDraft':
        await assertAllowed(plugin, userId, 'compose.draft');
        return createDraftNow(userId, args.input, this.engine);
      default:
        throw new PluginInputError(`unknown action ${action}`);
    }
  }

  /** The API-side job that runs mail writes queued from the worker. Permission is re-checked. */
  async actionJob(payload) {
    const e = this.entries.get(payload?.pluginId);
    if (!e || e.status !== 'loaded') throw Object.assign(new Error(`plugin ${payload?.pluginId} is not loaded`), { permanent: true });
    try {
      return await this.runAction(e.plugin, payload.userId, payload.action, payload.args);
    } catch (err) {
      if (err?.code === 'plugin_permission' || err?.code === 'plugin_input') err.permanent = true;
      throw err;
    }
  }

  broadcast(plugin, userId, payload) {
    if (!this.engine?.broadcast) return false;
    this.engine.broadcast({ type: 'hedwig.plugin', pluginId: plugin.id, payload }, userId);
    return true;
  }

  // ── admin operations ─────────────────────────────────────────────────────
  /**
   * Upsert the plugin's hedwig_plugins row. `pin` records the directory's current sha256 as the
   * trusted one (install, admin reload, first sight); without it an existing pin is kept, so a
   * load that failed on a mismatch can never re-pin the changed files.
   */
  async recordRow(entry, { installedBy, pin = false } = {}) {
    if (!this.useDb || entry.source === 'bundled') return;
    await query(
      `INSERT INTO hedwig_plugins (id, source, location, manifest, sha256, status, error, installed_by, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, location = EXCLUDED.location,
         manifest = CASE WHEN $9 THEN EXCLUDED.manifest ELSE hedwig_plugins.manifest END,
         sha256 = CASE WHEN $9 THEN EXCLUDED.sha256 ELSE hedwig_plugins.sha256 END,
         status = EXCLUDED.status, error = EXCLUDED.error,
         installed_by = COALESCE(EXCLUDED.installed_by, hedwig_plugins.installed_by), updated_at = NOW()`,
      [entry.id, entry.source, entry.location || null, JSON.stringify(entry.manifest || {}), entry.sha256 || null,
        entry.status === 'loaded' ? 'installed' : entry.status, entry.error, installedBy || null, pin === true],
    );
  }

  async install({ source, location, ref, installedBy }) {
    const dir = await this.pluginsDir();
    if (!dir) throw new PluginInputError('plugins.dir is not configured');
    await mkdir(dir, { recursive: true });
    const root = await realpath(dir);
    if (source === 'dir') {
      if (typeof location !== 'string' || !location || location.length > 300) throw new PluginInputError('location must be a directory inside plugins.dir');
      const target = await realpath(resolve(root, location)).catch(() => null);
      if (!target || !target.startsWith(root + sep) || resolve(target, '..') !== root) throw new PluginInputError(`location must be a direct subdirectory of ${root}`);
      const entry = await this.loadExternal(target, { accept: true, source: 'dir', location: basename(target), installedBy });
      return entry;
    }
    if (source !== 'git') throw new PluginInputError("source must be 'git' or 'dir'");
    const cfg = await getConfig();
    if (!cfg['plugins.allowGit']) throw new PluginInputError('installing from git is disabled (plugins.allowGit)');
    const { url, branch } = parseGitLocation(location, ref);
    const staging = join(root, `.staging-${randomBytes(6).toString('hex')}`);
    try {
      await execFileP('git', [
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.symlinks=false',
        '-c', 'submodule.recurse=false', 'clone', '--depth', '1', '--no-tags', '--single-branch',
        ...(branch ? ['--branch', branch] : []), '--', url, staging,
      ], { timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: 'echo' } });
      const { stdout: commit } = await execFileP('git', ['-C', staging, 'rev-parse', 'HEAD'], { timeout: 10_000 });
      await rm(join(staging, '.git'), { recursive: true, force: true });
      const manifest = validateManifest(await readManifestFile(staging), { tier: 2 });
      if (this.entries.get(manifest.id)?.source === 'bundled') throw new PluginInputError(`id ${manifest.id} is taken by a bundled plugin`);
      const problems = await checkPluginDir(staging, manifest);
      if (problems.length) throw new PluginInputError(`boundary check failed: ${problems.slice(0, 10).join('; ')}`);
      const target = join(root, manifest.id);
      if (await lstat(target).catch(() => null)) throw new PluginInputError(`${manifest.id} is already installed; uninstall it first or reload it`);
      await rename(staging, target);
      console.log(`[pluginsv2] installed ${manifest.id} from ${url} at ${commit.trim()}`);
      return this.loadExternal(target, { accept: true, source: 'git', location: `${url}#${commit.trim()}`, installedBy });
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (err?.code === 'ENOENT' && err.path === 'git') throw new PluginInputError('git is not installed on the server');
      if (err?.stderr) throw new PluginInputError(`git clone failed: ${String(err.stderr).trim().slice(0, 300)}`);
      throw err;
    }
  }

  async reload(id) {
    const e = this.entries.get(id);
    if (!e) throw new PluginInputError(`unknown plugin ${id}`);
    if (e.source === 'bundled') {
      const b = this.bundled.find((x) => x.manifest?.id === id);
      if (!b) throw new PluginInputError(`bundled plugin ${id} is missing`);
      await this.loadBundled(b);
    } else {
      if (!e.dir) throw new PluginInputError(`plugin ${id} has no directory`);
      await this.loadExternal(e.dir, { accept: this.processKind !== 'worker', source: e.source, location: e.location });
    }
    return this.entries.get(id);
  }

  async uninstall(id) {
    const e = this.entries.get(id);
    const rows = await this.dbRows();
    const row = rows.get(id);
    if (!e && !row) throw new PluginInputError(`unknown plugin ${id}`);
    if (e?.source === 'bundled') throw new PluginInputError('bundled plugins cannot be uninstalled; disable them instead');
    if (e) this.teardown(e);
    this.unregisterPluginTools(id);
    this.entries.delete(id);
    if (this.useDb) {
      await query('DELETE FROM plugin_data WHERE plugin_id = $1', [id]);
      await query('DELETE FROM hedwig_plugin_grants WHERE plugin_id = $1', [id]);
      await query('DELETE FROM hedwig_facts WHERE plugin_id = $1', [id]);
      await query(
        `UPDATE users SET preferences = jsonb_set(preferences, '{enabledPlugins}', (preferences->'enabledPlugins') - $1)
          WHERE jsonb_typeof(preferences->'enabledPlugins') = 'array' AND (preferences->'enabledPlugins') ? $1`,
        [upstreamIdFor(id)],
      );
      await query('DELETE FROM hedwig_plugins WHERE id = $1', [id]);
    }
    const dir = e?.dir;
    const source = e?.source || row?.source;
    if (dir && source === 'git') {
      const root = await realpath(await this.pluginsDir()).catch(() => null);
      const target = await realpath(dir).catch(() => null);
      if (root && target && target.startsWith(root + sep)) await rm(target, { recursive: true, force: true });
    }
    return { ok: true };
  }

  /** Worker: follow installs, reloads and uninstalls the API recorded in hedwig_plugins. */
  async syncFromDb() {
    const rows = await this.dbRows();
    const dir = await this.pluginsDir();
    for (const e of this.list()) {
      if (e.source === 'bundled') continue;
      const row = rows.get(e.id);
      if (!row) { this.teardown(e); this.unregisterPluginTools(e.id); this.entries.delete(e.id); continue; }
      if (row.sha256 && row.sha256 !== e.sha256 && e.dir) await this.loadExternal(e.dir, { row, accept: true });
      else if (e.status === 'pending' && e.dir) await this.loadExternal(e.dir, { row });
    }
    for (const [id, row] of rows) {
      if (this.entries.has(id) || !dir) continue;
      const full = join(dir, id);
      if (await stat(join(full, 'hedwig.plugin.json')).catch(() => null)) await this.loadExternal(full, { row, accept: Boolean(row.sha256) });
    }
  }
}

export function parseGitLocation(location, ref) {
  if (typeof location !== 'string' || location.length > 500) throw new PluginInputError('location must be an https git URL');
  const [raw, frag] = location.split('#');
  let u;
  try { u = new URL(raw); } catch { throw new PluginInputError('location must be an https git URL'); }
  if (u.protocol !== 'https:') throw new PluginInputError('only https git URLs are allowed');
  if (u.username || u.password) throw new PluginInputError('credentials in the git URL are not allowed');
  if (u.search || !u.hostname) throw new PluginInputError('the git URL must not carry a query string');
  const branch = ref || frag || null;
  if (branch && (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.startsWith('-') || branch.includes('..'))) throw new PluginInputError('invalid git ref');
  return { url: u.toString(), branch };
}

/** First-party plugins shipped in this build (imported statically; see bundled.js). */
export { validateManifest };
