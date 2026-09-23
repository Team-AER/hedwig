// Shell state: the pane tree on screen, its persistence, pane focus, the overlay drawer,
// pop-out windows and the phone view stack. Views never touch this directly — they ask for a
// view with useHedwig.openView and the shell decides where it goes.
import { create } from 'zustand';
import { hedwigApi } from '../api.js';
import { useHedwig } from '../store.js';
import { useStore } from '../../store/index.js';
import * as M from './model.js';
import { buildTemplate, getTemplate } from './templates.js';
import { pickLayout, savedLayoutsFor, isPreV2Layout } from './layouts.js';

const SAVE_DELAY_MS = 800;
const LOAD_TIMEOUT_MS = 4000;

function cacheKey(device) {
  const uid = useStore.getState().user?.id || 'anon';
  return `hedwig_layout_${uid}_${device}`;
}

function readCache(device) {
  try {
    const raw = JSON.parse(localStorage.getItem(cacheKey(device)) || 'null');
    const tree = raw && M.normalise(raw.tree);
    // A layout cached before v2 is not painted: the server's answer decides (and moves it to Classic).
    if (!tree || !M.validTree(tree) || isPreV2Layout(tree)) return null;
    return { name: raw.name || 'Layout', templateId: raw.templateId || null, tree };
  } catch { return null; }
}

function writeCache(device, { name, templateId, tree }) {
  try { localStorage.setItem(cacheKey(device), JSON.stringify({ name, templateId, tree })); } catch { /* storage full or blocked */ }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

let saveTimer = null;
let initSeq = 0;
let warnedSave = false;

export const useShell = create((set, get) => ({
  device: 'desktop',
  ready: false,
  tree: null,
  name: 'Streams',
  templateId: 'streams',
  openPalette: null,      // set by the shell that owns the palette (HedwigShell / MobileShell)
  rows: [],               // saved layouts from the server, every device
  saveState: 'idle',      // 'idle' | 'pending' | 'saving' | 'error'
  focused: null,          // pane key
  flash: null,            // pane key briefly highlighted after a keyboard focus move
  arrange: false,         // pane headers and chrome visible for rearranging
  transient: {},          // pane key → props from view requests (not persisted)
  overlay: null,          // { key, id, props }
  popouts: [],            // { key, id, props, rect, z }
  pluginsSettled: false,  // plugin bundles attempted; before this, unknown views render blank

  // Phone
  mobileTab: 'people',     // 'screener' | 'people' | 'reading' | 'records' | 'brief'
  stacks: {},              // tab → [{ key, id, props }]; seeded with the tab's root view on first show

  // ── Loading and saving ────────────────────────────────────────────────────
  async init(device) {
    const seq = ++initSeq;
    const cached = readCache(device);
    set({ device, ...(cached ? { tree: cached.tree, name: cached.name, templateId: cached.templateId, ready: true } : { ready: false }) });

    let rows = null;
    try { rows = await withTimeout(hedwigApi.get('/layouts'), LOAD_TIMEOUT_MS); } catch (err) {
      console.warn('[hedwig] could not load saved layouts:', err.message);
    }
    let status = useHedwig.getState().status;
    if (!status) {
      try { await withTimeout(useHedwig.getState().loadStatus(), LOAD_TIMEOUT_MS); } catch { /* status stays null */ }
      status = useHedwig.getState().status;
    }
    if (seq !== initSeq) return; // a newer init (device change) superseded this one

    const pick = pickLayout(rows || [], device, status?.ui?.defaultTemplate);
    if (Array.isArray(rows)) set({ rows });
    if (pick.source === 'saved') {
      if (!cached || !M.sameShape(cached.tree, pick.tree)) get().setTree(pick.tree, { name: pick.name, templateId: pick.templateId, save: false });
    } else if (pick.source === 'migrate') {
      get().setTree(pick.tree, { name: pick.name, templateId: pick.templateId, save: false });
      await get().keepClassic(pick.classic, rows);
      if (seq !== initSeq) return;
      await get().flushSave();
    } else if (!cached) {
      get().setTree(pick.tree, { name: pick.name, templateId: pick.templateId, save: false });
    } else if (Array.isArray(rows)) {
      // The server has nothing active for this device but this browser does: keep it and save.
      get().scheduleSave();
    }
    set({ ready: true });
  },

  setTree(tree, { name, templateId, save = true } = {}) {
    let next = tree ? M.normalise(tree) : null;
    if (!next || !M.validTree(next)) next = M.normalise(M.view('core.picker'));
    next = { ...next, version: M.LAYOUT_VERSION };
    const patch = { tree: next };
    if (name !== undefined) patch.name = name;
    if (templateId !== undefined) patch.templateId = templateId;
    set(patch);
    const s = get();
    writeCache(s.device, { name: s.name, templateId: s.templateId, tree: next });
    useHedwig.getState().setActiveLayout({ name: s.name, device: s.device, tree: next });
    if (save) get().scheduleSave();
  },

  scheduleSave() {
    clearTimeout(saveTimer);
    set({ saveState: 'pending' });
    saveTimer = setTimeout(() => get().flushSave(), SAVE_DELAY_MS);
  },

  async flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const { tree, name, device } = get();
    if (!tree || !M.validTree(tree)) return;
    set({ saveState: 'saving' });
    try {
      const row = await hedwigApi.put('/layouts', { name: String(name || 'Layout').slice(0, 80), device, tree, active: true });
      set((s) => ({
        saveState: 'idle',
        rows: [...s.rows.filter((r) => !(r.device === row.device && r.name === row.name)).map((r) => (r.device === row.device ? { ...r, is_active: false } : r)), row],
      }));
      warnedSave = false;
    } catch (err) {
      set({ saveState: 'error' });
      if (!warnedSave) console.warn('[hedwig] layout not saved:', err.message);
      warnedSave = true;
    }
  },

  // The layout a user had before v2, kept under "Classic" (stamped, so it is never moved again)
  // in place of the row it came from. The streams template is saved as active by the caller.
  async keepClassic(classic, rows) {
    if (!classic?.tree) return;
    const { device } = get();
    const from = (rows || []).find((r) => r.is_active && r.device === device);
    try {
      const row = await hedwigApi.put('/layouts', { name: classic.name, device, tree: { ...classic.tree, version: M.LAYOUT_VERSION }, active: false });
      if (from && from.id !== row.id && from.name !== classic.name) {
        await hedwigApi.del(`/layouts/${from.id}`).catch((err) => console.warn('[hedwig] could not remove the old layout row:', err.message));
      }
      set((s) => ({ rows: [...s.rows.filter((r) => r.id !== row.id && r.id !== from?.id), row] }));
    } catch (err) {
      console.warn('[hedwig] could not keep the old layout as Classic:', err.message);
    }
  },

  savedLayouts() {
    const { rows, device } = get();
    return savedLayoutsFor(rows, device);
  },

  applyTemplate(id) {
    const t = getTemplate(id);
    if (!t) return;
    const prev = get().tree;
    let tree = buildTemplate(id);
    if (prev?.density) tree = M.setMeta(tree, { density: prev.density });
    if (prev?.headers) tree = M.setMeta(tree, { headers: prev.headers });
    get().setTree(tree, { name: t.label, templateId: id });
    if (t.upstreamLayout && useStore.getState().layout !== t.upstreamLayout) useStore.getState().setLayout(t.upstreamLayout);
    set({ overlay: null, focused: null });
  },

  async applySaved(row) {
    const tree = M.normalise(row.tree);
    if (!tree || !M.validTree(tree)) return;
    get().setTree(tree, { name: row.name, templateId: getTemplate(String(row.name).toLowerCase())?.id || null, save: false });
    set((s) => ({ rows: s.rows.map((r) => (r.device === row.device ? { ...r, is_active: r.id === row.id } : r)), overlay: null, focused: null }));
    // A row saved before v2 is saved again with the version stamp, or the next load would move it.
    if (row.id && row.device === get().device && !isPreV2Layout(row.tree)) {
      try { await hedwigApi.post(`/layouts/${row.id}/activate`); } catch (err) { console.warn('[hedwig] could not activate layout:', err.message); }
    } else {
      get().scheduleSave();
    }
  },

  async saveAs(name) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) return;
    set({ name: clean, templateId: getTemplate(clean.toLowerCase())?.id || null });
    writeCache(get().device, get());
    await get().flushSave();
  },

  async deleteSaved(row) {
    try {
      await hedwigApi.del(`/layouts/${row.id}`);
      set((s) => ({ rows: s.rows.filter((r) => r.id !== row.id) }));
    } catch (err) { console.warn('[hedwig] could not delete layout:', err.message); }
  },

  // ── Pane operations ───────────────────────────────────────────────────────
  edit(fn) {
    const { tree } = get();
    if (!tree) return;
    const next = fn(tree);
    if (next !== tree) get().setTree(next);
  },

  focus(key, { flash = false } = {}) {
    set({ focused: key, flash: flash ? key : null });
    if (typeof document === 'undefined') return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-pane-key="${CSS.escape(key)}"]`);
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
    if (flash) setTimeout(() => { if (get().flash === key) set({ flash: null }); }, 800);
  },

  focusNeighbour(delta) {
    const { tree, focused } = get();
    const next = M.neighbourPane(tree, focused, delta);
    if (next) get().focus(next, { flash: true });
  },

  targetPane() {
    const { tree, focused } = get();
    if (!tree) return null;
    if (focused && M.findNode(tree, focused)) return focused;
    const panes = M.listPanes(tree).filter((p) => p.visible);
    const main = panes.find((p) => p.node.id === 'core.thread') || panes[panes.length - 1];
    return main?.node.key || tree.key;
  },

  splitFocused(dir) {
    const key = get().targetPane();
    if (!key) return;
    const fresh = M.view('core.picker');
    get().edit((t) => M.splitPane(t, key, dir, fresh));
    if (M.findNode(get().tree, fresh.key)) get().focus(fresh.key, { flash: true });
  },

  closePane(key) {
    get().edit((t) => M.closePane(t, key) || M.normalise(M.view('core.picker')));
    set((s) => {
      const transient = { ...s.transient };
      delete transient[key];
      return { transient, focused: s.focused === key ? null : s.focused };
    });
  },

  replaceView(key, viewId, props) {
    get().edit((t) => M.replaceView(t, key, viewId, props));
    set((s) => {
      const transient = { ...s.transient };
      delete transient[key];
      return { transient };
    });
  },

  // Insert a view into the layout beside the focused pane (used by "dock" and the editor).
  dock(viewId, props) {
    const key = get().targetPane();
    const node = M.view(viewId, props && Object.keys(props).length ? { props } : {});
    if (!key) { get().setTree(node); return; }
    get().edit((t) => M.splitPane(t, key, 'row', node));
    get().focus(node.key, { flash: true });
  },

  // ── Overlay drawer and pop-outs ──────────────────────────────────────────
  openOverlay(id, props = {}) {
    set((s) => ({
      overlay: s.overlay?.id === id
        ? { ...s.overlay, props: { ...s.overlay.props, ...props } }
        : { key: M.newKey(), id, props },
    }));
  },

  closeOverlay() {
    const o = get().overlay;
    set({ overlay: null });
    if (o?.id === 'core.contacts' && useStore.getState().showContacts) useStore.getState().setShowContacts(false);
  },

  dockOverlay() {
    const o = get().overlay;
    if (!o) return;
    set({ overlay: null });
    get().dock(o.id, o.props);
  },

  popOut(key) {
    const { tree } = get();
    const hit = M.findNode(tree, key);
    if (!hit || hit.node.type !== 'view') return;
    const w = Math.min(640, Math.round(window.innerWidth * 0.5));
    const h = Math.min(720, Math.round(window.innerHeight * 0.75));
    const n = get().popouts.length;
    const rect = { x: Math.round((window.innerWidth - w) / 2) + n * 24, y: 72 + n * 24, w, h };
    const props = { ...(hit.node.props || {}), ...(get().transient[key] || {}) };
    get().closePane(key);
    set((s) => ({ popouts: [...s.popouts, { key: M.newKey(), id: hit.node.id, props, rect, z: Date.now() }] }));
  },

  raisePopout(pk) {
    set((s) => ({ popouts: s.popouts.map((p) => (p.key === pk ? { ...p, z: Date.now() } : p)) }));
  },

  movePopout(pk, rect) {
    set((s) => ({ popouts: s.popouts.map((p) => (p.key === pk ? { ...p, rect } : p)) }));
  },

  closePopout(pk) {
    set((s) => ({ popouts: s.popouts.filter((p) => p.key !== pk) }));
  },

  dockPopout(pk) {
    const p = get().popouts.find((x) => x.key === pk);
    if (!p) return;
    get().closePopout(pk);
    get().dock(p.id, p.props);
  },

  toggleArrange() { set((s) => ({ arrange: !s.arrange })); },

  // ── View requests (useHedwig.openView) ───────────────────────────────────
  handleViewRequest(req, { phone = false } = {}) {
    if (!req?.id) return;
    const props = req.props || {};
    if (phone) { get().pushView(req.id, props); return; }
    const { tree, popouts, overlay } = get();
    const hosting = M.panesHosting(tree, req.id);
    if (hosting.length) {
      const key = hosting.includes(get().focused) ? get().focused : hosting[0];
      const revealed = M.reveal(tree, key);
      if (revealed !== tree) get().setTree(revealed);
      set((s) => ({ transient: { ...s.transient, [key]: { ...(s.transient[key] || {}), ...props, _request: req.nonce } } }));
      get().focus(key, { flash: true });
      return;
    }
    const pop = popouts.find((p) => p.id === req.id);
    if (pop) {
      set((s) => ({ popouts: s.popouts.map((p) => (p.key === pop.key ? { ...p, props: { ...p.props, ...props, _request: req.nonce }, z: Date.now() } : p)) }));
      return;
    }
    if (overlay?.id === req.id) {
      set({ overlay: { ...overlay, props: { ...overlay.props, ...props, _request: req.nonce } } });
      return;
    }
    set({ overlay: { key: M.newKey(), id: req.id, props: { ...props, _request: req.nonce } } });
  },

  // ── Phone view stack ─────────────────────────────────────────────────────
  setMobileTab(tab) { set({ mobileTab: tab }); },

  setStack(tab, stack) { set((s) => ({ stacks: { ...s.stacks, [tab]: stack } })); },

  pushView(id, props = {}) {
    const tab = get().mobileTab;
    const stack = get().stacks[tab] || [];
    const top = stack[stack.length - 1];
    const next = top?.id === id
      ? [...stack.slice(0, -1), { ...top, props: { ...top.props, ...props } }]
      : [...stack, { key: M.newKey(), id, props }];
    get().setStack(tab, next);
  },

  popView() {
    const tab = get().mobileTab;
    const stack = get().stacks[tab] || [];
    if (stack.length) get().setStack(tab, stack.slice(0, -1));
  },
}));
