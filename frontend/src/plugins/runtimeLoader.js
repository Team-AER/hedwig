// Plugin runtime v2 — browser half.
//
// initPluginRuntime() (called by hedwig/index.js when a user session starts) fetches
// GET /api/hedwig/plugins and, for every plugin the user activated that ships a frontend bundle,
// imports that bundle as an ES module. A bundle never imports anything: it receives the host API
// as `window.hedwig`, scoped to that plugin while its module evaluates:
//
//   { React, h, registerView, registerCommand, registerSlot, api, stream, useHedwig, tokens,
//     pluginId, SettingsForm }
//
// registerView/registerCommand ids are forced under the plugin's namespace and are removed again
// when the user deactivates the plugin. It re-runs whenever activation changes (the Plugins
// settings, the old Settings → Plugins tab, or enablePlugin/disablePlugin below).
//
// First-party plugins are bundled by Vite instead (plugins/index.js imports them); they gate their
// registrations on activation with whenActivated().
//
// A plugin bundle is same-origin script: it can do whatever the signed-in user can do in this
// browser. That is why only an admin can install one and the server serves it only to users who
// activated the plugin (see docs/hedwig/PLUGINS.md, "Security model").
import React, { useEffect, useState } from 'react';
import { registerView, registerCommand } from '../hedwig/registry.js';
import { hedwigApi, hedwigStream } from '../hedwig/api.js';
import { useHedwig } from '../hedwig/store.js';
import { useStore } from '../store/index.js';
import { registerSlot } from './registry.js';
import { tr } from '../hedwig/views/i18n.js';

const h = React.createElement;

/** CSS variable names for the Hedwig design tokens (hedwig/theme/tokens.js). Use as `var(${tokens.ink})`. */
export const TOKENS = Object.freeze({
  ground: '--hw-ground', surface: '--hw-surface', raised: '--hw-raised', border: '--hw-border',
  ink: '--hw-ink', muted: '--hw-muted', faint: '--hw-faint', tint: '--hw-tint',
  teal: '--hw-teal', tealTint: '--hw-teal-tint', tealText: '--hw-teal-text',
  amber: '--hw-amber', amberTint: '--hw-amber-tint', amberText: '--hw-amber-text',
  red: '--hw-red', redTint: '--hw-red-tint', shadow: '--hw-shadow',
  fontDisplay: '--hw-font-display', fontBody: '--hw-font-body', fontMono: '--hw-font-mono',
});

/** The activation key upstream stores in users.preferences.enabledPlugins: dots become dashes. */
export function activationKey(pluginId) {
  return String(pluginId).replace(/\./g, '-');
}

/** Plugin API client scoped to /api/hedwig/p/<pluginId>. */
export function pluginApi(pluginId) {
  const base = `/p/${encodeURIComponent(pluginId)}`;
  return Object.freeze({
    get: (path) => hedwigApi.get(base + path),
    post: (path, body) => hedwigApi.post(base + path, body),
    put: (path, body) => hedwigApi.put(base + path, body),
    patch: (path, body) => hedwigApi.patch(base + path, body),
    del: (path) => hedwigApi.del(base + path),
    url: (path) => `/api/hedwig${base}${path}`,
  });
}

// ── Activation gating for first-party (bundled) plugins ─────────────────────
/**
 * Run `register` while the plugin is activated for the signed-in user and undo it when it is not.
 * `register` returns the unregister functions from registerView/registerCommand.
 */
export function whenActivated(pluginId, register) {
  const key = activationKey(pluginId);
  let undo = null;
  const apply = (enabled) => {
    // The server stores the activation key; accept the public id too, as views may add either.
    const on = Array.isArray(enabled) && (enabled.includes(key) || enabled.includes(pluginId));
    if (on && !undo) {
      const out = register();
      undo = Array.isArray(out) ? out.filter((f) => typeof f === 'function') : [];
    } else if (!on && undo) {
      for (const f of undo) { try { f(); } catch { /* already gone */ } }
      undo = null;
    }
  };
  apply(useStore.getState().enabledPlugins);
  return useStore.subscribe((s, prev) => { if (s.enabledPlugins !== prev?.enabledPlugins) apply(s.enabledPlugins); });
}

// ── Enable / disable from Hedwig views ──────────────────────────────────────
function setActivatedLocally(pluginId, on) {
  const key = activationKey(pluginId);
  useStore.setState((s) => {
    const next = new Set(s.enabledPlugins || []);
    if (on) next.add(key); else next.delete(key);
    return { enabledPlugins: [...next] };
  });
}

/** POST /plugins/:id/enable with the grants the user ticked, then load its UI. Returns PluginInfo. */
export async function enablePlugin(pluginId, grants) {
  const info = await hedwigApi.post(`/plugins/${encodeURIComponent(pluginId)}/enable`, { grants });
  setActivatedLocally(pluginId, true);
  window.dispatchEvent(new CustomEvent('hedwig:plugins-changed', { detail: { id: pluginId, activated: true } }));
  return info;
}

export async function disablePlugin(pluginId) {
  const info = await hedwigApi.post(`/plugins/${encodeURIComponent(pluginId)}/disable`, {});
  setActivatedLocally(pluginId, false);
  window.dispatchEvent(new CustomEvent('hedwig:plugins-changed', { detail: { id: pluginId, activated: false } }));
  return info;
}

// ── External bundles ─────────────────────────────────────────────────────────
const loaded = new Map(); // pluginId -> { url, cleanups: [], error? }
let loadSeq = 0;
let unsubscribe = null;
let running = null;
let rerun = false;
let lastList = [];

function scopedHost(p, cleanups) {
  const ns = `${p.id}.`;
  const scopeId = (id) => (String(id || '').startsWith(ns) ? id : `${ns}${id}`);
  return Object.freeze({
    React,
    h,
    registerView: (view) => {
      const un = registerView({ group: 'plugins', ...view, id: scopeId(view?.id), pluginId: p.id });
      cleanups.push(un);
      return un;
    },
    registerCommand: (cmd) => {
      const un = registerCommand({ group: p.name, ...cmd, id: scopeId(cmd?.id), pluginId: p.id });
      cleanups.push(un);
      return un;
    },
    // Slots have no unregister; the slot registry hides them while the plugin is not activated.
    registerSlot: (name, contribution) => registerSlot(name, { ...contribution, pluginId: p.activationKey || activationKey(p.id) }),
    api: hedwigApi,
    pluginApi: pluginApi(p.id),
    stream: hedwigStream,
    useHedwig,
    tokens: TOKENS,
    pluginId: p.id,
    SettingsForm,
  });
}

async function loadBundle(p) {
  const cleanups = [];
  // A fresh URL per load: an ES module evaluates once per URL, and a re-activated plugin must run
  // its registrations again.
  const url = `${p.frontendUrl}${p.frontendUrl.includes('?') ? '&' : '?'}load=${++loadSeq}`;
  window.hedwig = scopedHost(p, cleanups);
  try {
    await import(/* @vite-ignore */ url);
    loaded.set(p.id, { url: p.frontendUrl, cleanups });
  } catch (err) {
    for (const f of cleanups) { try { f(); } catch { /* ignore */ } }
    loaded.set(p.id, { url: p.frontendUrl, cleanups: [], error: err?.message || String(err) });
    console.warn(`[hedwig] plugin ${p.id} frontend failed to load:`, err?.message || err);
  }
}

function unload(id) {
  const rec = loaded.get(id);
  if (!rec) return;
  for (const f of rec.cleanups) { try { f(); } catch { /* ignore */ } }
  loaded.delete(id);
}

async function syncBundles() {
  let list;
  try {
    list = await hedwigApi.get('/plugins');
  } catch (err) {
    console.warn('[hedwig] could not list plugins:', err?.message || err);
    return lastList;
  }
  lastList = Array.isArray(list) ? list : [];
  const wanted = new Map(lastList.filter((p) => p.activated && p.hasFrontend && p.frontendUrl && p.status === 'loaded').map((p) => [p.id, p]));
  for (const [id, rec] of [...loaded]) {
    if (!wanted.has(id) || wanted.get(id).frontendUrl !== rec.url) unload(id);
  }
  // Sequential on purpose: window.hedwig is scoped to one plugin while its module evaluates.
  for (const p of wanted.values()) if (!loaded.has(p.id)) await loadBundle(p);
  return lastList;
}

/** Re-read the plugin list and load/unload bundles. Coalesces overlapping calls. */
export function refreshPluginRuntime() {
  if (running) { rerun = true; return running; }
  running = (async () => {
    let list;
    do { rerun = false; list = await syncBundles(); } while (rerun);
    return list;
  })().finally(() => { running = null; });
  return running;
}

/**
 * Start the runtime for the signed-in user. Resolves once every activated plugin's bundle has
 * loaded (or failed). Safe to call again (e.g. after a user switch): it resyncs.
 */
export function initPluginRuntime() {
  if (!unsubscribe) {
    const unsub = useStore.subscribe((s, prev) => {
      if (s.enabledPlugins !== prev?.enabledPlugins) refreshPluginRuntime();
      if (s.user?.id !== prev?.user?.id) { for (const id of [...loaded.keys()]) unload(id); }
    });
    // Settings → Plugins announces enable/disable/reload/uninstall with this event.
    const onChanged = () => refreshPluginRuntime();
    window.addEventListener('hedwig:plugins-changed', onChanged);
    unsubscribe = () => { unsub(); window.removeEventListener('hedwig:plugins-changed', onChanged); };
  }
  return refreshPluginRuntime();
}

/** The last plugin list the runtime fetched (PluginInfo[]), and each bundle's load error. */
export function pluginRuntimeState() {
  return { plugins: lastList, bundles: [...loaded].map(([id, r]) => ({ id, error: r.error || null })) };
}

// ── Settings form (schema-driven; also offered to bundles as window.hedwig.SettingsForm) ─────────
const fieldStyle = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6,
  border: `1px solid var(${TOKENS.border})`, background: `var(${TOKENS.surface})`, color: `var(${TOKENS.ink})`,
  fontFamily: `var(${TOKENS.fontBody})`, fontSize: 13,
};

function Field({ name, prop, value, onChange }) {
  const id = `plugin-setting-${name}`;
  const label = prop.title || name;
  const help = prop.description ? h('div', { style: { fontSize: 12, color: `var(${TOKENS.muted})`, marginTop: 3 } }, prop.description) : null;
  if (prop.type === 'boolean') {
    return h('div', { style: { margin: '10px 0' } },
      h('label', { htmlFor: id, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
        h('input', { id, type: 'checkbox', checked: Boolean(value), onChange: (e) => onChange(e.target.checked) }), label),
      help);
  }
  let input;
  if (Array.isArray(prop.enum)) {
    input = h('select', { id, value: value ?? '', onChange: (e) => onChange(e.target.value), style: fieldStyle },
      prop.enum.map((o) => h('option', { key: String(o), value: o }, String(o))));
  } else if (prop.type === 'number' || prop.type === 'integer') {
    input = h('input', {
      id, type: 'number', value: value ?? '', min: prop.minimum, max: prop.maximum, step: prop.type === 'integer' ? 1 : 'any',
      onChange: (e) => onChange(e.target.value === '' ? null : Number(e.target.value)), style: fieldStyle,
    });
  } else if (prop.format === 'multiline') {
    input = h('textarea', { id, value: value ?? '', rows: 4, onChange: (e) => onChange(e.target.value), style: fieldStyle });
  } else {
    const secret = prop.secret || prop.format === 'secret';
    input = h('input', {
      id, type: secret ? 'password' : (prop.format === 'url' ? 'url' : 'text'), value: value ?? '',
      autoComplete: secret ? 'new-password' : 'off', maxLength: prop.maxLength, spellCheck: false,
      onChange: (e) => onChange(e.target.value), style: fieldStyle,
    });
  }
  return h('div', { style: { margin: '10px 0' } },
    h('label', { htmlFor: id, style: { display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: `var(${TOKENS.ink})` } }, label),
    input, help);
}

/** Edits a plugin's per-user settings (GET/PUT /api/hedwig/plugins/:id/settings) from its schema. */
export function SettingsForm({ pluginId, schema, onSaved }) {
  const [values, setValues] = useState(null);
  const [status, setStatus] = useState({ busy: false, error: null, saved: false });
  const [loadedSchema, setLoadedSchema] = useState(schema || null);

  useEffect(() => {
    let alive = true;
    hedwigApi.get(`/plugins/${encodeURIComponent(pluginId)}/settings`)
      .then((v) => { if (alive) setValues(v || {}); })
      .catch((err) => { if (alive) setStatus({ busy: false, error: err.message, saved: false }); });
    if (!schema) {
      hedwigApi.get('/plugins').then((list) => {
        if (alive) setLoadedSchema((Array.isArray(list) ? list : []).find((p) => p.id === pluginId)?.settingsSchema || null);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [pluginId, schema]);

  const props = loadedSchema?.properties || {};
  if (!values) return h('div', { style: { fontSize: 13, color: `var(${TOKENS.muted})` } }, status.error || tr('plugins.settings.loading', 'Loading settings…'));

  const save = async (e) => {
    e.preventDefault();
    setStatus({ busy: true, error: null, saved: false });
    try {
      const next = await hedwigApi.put(`/plugins/${encodeURIComponent(pluginId)}/settings`, values);
      setValues(next);
      setStatus({ busy: false, error: null, saved: true });
      onSaved?.(next);
    } catch (err) {
      setStatus({ busy: false, error: err.message, saved: false });
    }
  };

  return h('form', { onSubmit: save, style: { maxWidth: 520 } },
    Object.entries(props).map(([name, prop]) => h(Field, {
      key: name, name, prop, value: values[name], onChange: (v) => { setValues((cur) => ({ ...cur, [name]: v })); setStatus((s) => ({ ...s, saved: false })); },
    })),
    h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 } },
      h('button', { type: 'submit', disabled: status.busy, className: 'hw-btn' }, status.busy ? tr('plugins.settings.saving', 'Saving…') : tr('plugins.settings.save', 'Save settings')),
      status.saved && h('span', { role: 'status', style: { fontSize: 12, color: `var(${TOKENS.tealText})` } }, tr('plugins.settings.saved', 'Saved')),
      status.error && h('span', { role: 'alert', style: { fontSize: 12, color: `var(${TOKENS.red})` } }, status.error)));
}
