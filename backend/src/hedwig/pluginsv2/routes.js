// Plugins v2 HTTP routes (docs/hedwig/API.md "Plugins v2"). User routes are mounted under
// /api/hedwig (requireAuth applied by mountHedwig), admin routes under /api/hedwig/admin
// (requireAdmin applied).
import { readFile, realpath } from 'fs/promises';
import { resolve, sep, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pluginRegistry } from '../../plugins/registry.js';
import { safeFetch } from '../../services/safeFetch.js';
import { getConfig } from '../config.js';
import { getAccess, checkGrants, setGrants, setActivated } from './access.js';
import { describePermission, isHost } from './manifest.js';
import { settingsForClient, settingsSet } from './store.js';
import { dispatch } from './router.js';

const LOCAL_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '../../../../plugins/directory.json');

function sendError(res, err) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.warn('[pluginsv2] route failed:', err?.message || err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
}

/** The PluginInfo shape (API.md) for one runtime entry, from `userId`'s point of view. */
export async function pluginInfo(entry, userId) {
  const acc = userId ? await getAccess(userId, entry.id) : { active: false, grants: new Set() };
  const m = entry.manifest || null;
  const hasFrontend = Boolean(entry.source !== 'bundled' && m?.frontend && entry.status === 'loaded');
  return {
    id: entry.id,
    name: m?.name || entry.id,
    version: m?.version || null,
    tier: m?.tier ?? entry.tier ?? 2,
    source: entry.source || null,
    description: m?.description || '',
    author: m?.author || null,
    activated: acc.active,
    activationKey: entry.upstreamId,
    status: entry.status,
    error: entry.error || null,
    permissions: (m?.permissions || []).map((p) => ({
      name: p.name, description: describePermission(p.name), reason: p.reason, granted: acc.grants.has(p.name), optional: p.optional,
    })),
    hooks: m?.hooks ? [...m.hooks] : [],
    views: m?.views ? [...m.views] : [],
    tools: [...(entry.toolNames || [])],
    commands: m?.commands ? [...m.commands] : [],
    net: m?.net ? [...m.net] : [],
    hasFrontend,
    frontendUrl: hasFrontend ? `/api/hedwig/plugins/${encodeURIComponent(entry.id)}/frontend.js?v=${(entry.sha256 || entry.loadedAt || '').slice(0, 12)}` : null,
    settingsSchema: m?.settings || null,
  };
}

function byName(a, b) {
  return String(a.manifest?.name || a.id).localeCompare(String(b.manifest?.name || b.id));
}

async function fireActivationHook(userId, entry, activated) {
  // Same event the upstream PATCH /api/plugins/:id fires, so upstream-style listeners see v2 toggles.
  await pluginRegistry.runHook('onPluginActivationChanged', { userId, pluginId: entry.upstreamId, activated }).catch(() => {});
}

export function userRoutes(r, runtime) {
  const loaded = (req, res) => {
    const e = runtime.get(req.params.id);
    if (!e) { res.status(404).json({ error: 'Unknown plugin' }); return null; }
    return e;
  };

  r.get('/plugins', async (req, res) => {
    try {
      const list = runtime.list().sort(byName);
      res.json(await Promise.all(list.map((e) => pluginInfo(e, req.session.userId))));
    } catch (err) { sendError(res, err); }
  });

  r.post('/plugins/:id/enable', async (req, res) => {
    const e = loaded(req, res); if (!e) return;
    try {
      if (e.status !== 'loaded') return res.status(409).json({ error: `Plugin ${e.id} is not loaded: ${e.error || e.status}` });
      const grants = checkGrants(e.manifest, req.body?.grants ?? [], { requireAll: true });
      await setGrants(req.session.userId, e.id, grants);
      await setActivated(req.session.userId, e.id, true);
      await fireActivationHook(req.session.userId, e, true);
      res.json(await pluginInfo(e, req.session.userId));
    } catch (err) { sendError(res, err); }
  });

  r.post('/plugins/:id/disable', async (req, res) => {
    const e = loaded(req, res); if (!e) return;
    try {
      await setActivated(req.session.userId, e.id, false);
      // Disabling withdraws every grant: re-enabling asks again rather than silently restoring access.
      await setGrants(req.session.userId, e.id, []);
      await fireActivationHook(req.session.userId, e, false);
      res.json(await pluginInfo(e, req.session.userId));
    } catch (err) { sendError(res, err); }
  });

  r.patch('/plugins/:id/grants', async (req, res) => {
    const e = loaded(req, res); if (!e) return;
    try {
      if (!e.manifest) return res.status(409).json({ error: `Plugin ${e.id} has no valid manifest` });
      const grants = checkGrants(e.manifest, req.body?.grants ?? [], { requireAll: true });
      await setGrants(req.session.userId, e.id, grants);
      res.json(await pluginInfo(e, req.session.userId));
    } catch (err) { sendError(res, err); }
  });

  r.get('/plugins/:id/frontend.js', async (req, res) => {
    const e = runtime.get(req.params.id);
    try {
      const acc = e ? await getAccess(req.session.userId, e.id) : null;
      if (!e || e.source === 'bundled' || e.status !== 'loaded' || !e.manifest?.frontend || !e.dir || !acc?.active) {
        return res.status(404).json({ error: 'No frontend bundle for this plugin' });
      }
      const root = await realpath(e.dir);
      const file = await realpath(resolve(root, e.manifest.frontend));
      if (!file.startsWith(root + sep)) return res.status(404).json({ error: 'No frontend bundle for this plugin' });
      const body = await readFile(file);
      res.set('Content-Type', 'application/javascript; charset=utf-8');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, max-age=300');
      res.send(body);
    } catch (err) { sendError(res, err); }
  });

  r.get('/plugins/:id/settings', async (req, res) => {
    const e = loaded(req, res); if (!e) return;
    try {
      if (!e.manifest?.settings) return res.json({});
      res.json(await settingsForClient(e.manifest, req.session.userId));
    } catch (err) { sendError(res, err); }
  });

  r.put('/plugins/:id/settings', async (req, res) => {
    const e = loaded(req, res); if (!e) return;
    try {
      if (!e.manifest) return res.status(409).json({ error: `Plugin ${e.id} has no valid manifest` });
      await settingsSet(e.manifest, req.session.userId, req.body || {});
      res.json(await settingsForClient(e.manifest, req.session.userId));
    } catch (err) { sendError(res, err); }
  });

  // A plugin's own routes. Activation is checked per request; the plugin's handlers get a frozen
  // plain request (never Express's req/res), see router.js.
  r.use('/p/:pluginId', async (req, res) => {
    const e = runtime.get(req.params.pluginId);
    if (!e || e.status !== 'loaded' || !e.instance?.router) return res.status(404).json({ error: 'Unknown plugin route' });
    try {
      const acc = await getAccess(req.session.userId, e.id);
      if (!acc.active) return res.status(403).json({ error: `Plugin ${e.id} is not activated` });
      const handled = await dispatch(e.instance.router, req, res, { userId: req.session.userId, pluginId: e.id, logger: e.facade?.logger });
      if (!handled) res.status(404).json({ error: 'Not found' });
    } catch (err) { sendError(res, err); }
  });
}

async function adminInfo(runtime, entry, row) {
  const info = entry ? await pluginInfo(entry, null) : {
    id: row.id, name: row.manifest?.name || row.id, version: row.manifest?.version || null, tier: 2, source: row.source,
    description: row.manifest?.description || '', author: row.manifest?.author || null, activated: false, status: 'missing',
    error: 'recorded as installed but not found in plugins.dir', permissions: [], hooks: [], views: [], tools: [], commands: [],
    hasFrontend: false, frontendUrl: null, settingsSchema: null,
  };
  delete info.activated;
  info.install = {
    location: row?.location || entry?.location || null,
    dir: entry?.dir || null,
    sha256: entry?.sha256 || null,
    pinnedSha256: row?.sha256 || null,
    installedAt: row?.installed_at || null,
    installedBy: row?.installed_by || null,
    loadedAt: entry?.loadedAt || null,
    lastHookError: entry?.lastHookError || null,
  };
  return info;
}

function cleanDirectory(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string').slice(0, 500).map((p) => ({
    id: p.id.slice(0, 64),
    name: String(p.name).slice(0, 80),
    description: String(p.description || '').slice(0, 500),
    source: ['bundled', 'git'].includes(p.source) ? p.source : 'git',
    location: String(p.location || '').slice(0, 500),
    version: String(p.version || '').slice(0, 40),
    author: p.author ? String(p.author).slice(0, 200) : null,
    permissions: Array.isArray(p.permissions) ? p.permissions.filter((x) => typeof x === 'string').slice(0, 40) : [],
  }));
}

export async function readDirectory({ fetchFn = safeFetch } = {}) {
  const cfg = await getConfig();
  const url = cfg['plugins.directoryUrl'];
  if (url) {
    try {
      const host = new URL(url).hostname;
      if (!isHost(host)) throw new Error('bad host');
      const res = await fetchFn(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      if (res.ok) {
        const body = await res.json();
        return { source: url, plugins: cleanDirectory(body?.plugins ?? body) };
      }
    } catch { /* fall back to the copy shipped with this build */ }
  }
  try {
    const body = JSON.parse(await readFile(LOCAL_DIRECTORY, 'utf8'));
    return { source: 'bundled', plugins: cleanDirectory(body?.plugins ?? body) };
  } catch {
    return { source: null, plugins: [] };
  }
}

export function adminRoutes(r, runtime) {
  r.get('/plugins', async (req, res) => {
    try {
      const rows = await runtime.dbRows();
      const out = [];
      for (const e of runtime.list().sort(byName)) out.push(await adminInfo(runtime, e, rows.get(e.id)));
      for (const [id, row] of rows) if (!runtime.get(id)) out.push(await adminInfo(runtime, null, row));
      res.json(out);
    } catch (err) { sendError(res, err); }
  });

  r.post('/plugins/install', async (req, res) => {
    try {
      const { source, location, ref } = req.body || {};
      const entry = await runtime.install({ source, location, ref, installedBy: req.session.userId });
      const rows = await runtime.dbRows();
      const info = await adminInfo(runtime, entry, rows.get(entry.id));
      res.status(entry.status === 'loaded' ? 201 : 422).json(info);
    } catch (err) { sendError(res, err); }
  });

  r.post('/plugins/:id/reload', async (req, res) => {
    try {
      const entry = await runtime.reload(req.params.id);
      const rows = await runtime.dbRows();
      res.json(await adminInfo(runtime, entry, rows.get(entry.id)));
    } catch (err) { sendError(res, err); }
  });

  r.delete('/plugins/:id', async (req, res) => {
    try {
      res.json(await runtime.uninstall(req.params.id));
    } catch (err) { sendError(res, err); }
  });

  r.get('/plugins/directory', async (req, res) => {
    try {
      const { plugins } = await readDirectory();
      res.json(plugins.map((p) => ({ ...p, installed: Boolean(runtime.get(p.id)) })));
    } catch (err) { sendError(res, err); }
  });
}
