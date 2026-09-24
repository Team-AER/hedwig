// The View menu (the rail's "…", the top bar's View button, the phone sheet) and the modes it
// offers: only the Hedwig layouts, each with a line under it; no upstream presets; saved layouts
// the user made; Customize layout…; the Appearance radio; Settings; the classic shell last. Also
// the Triage context pane following the v2 reader and a rail click landing in Research's list slot.
//
// Same harness as v2/repair.test.js. Run with: node --test src/hedwig/shell/view.test.js
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, Image: dom.window.Image,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  DOMParser: dom.window.DOMParser, getComputedStyle: dom.window.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = globalThis.ResizeObserver;
dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
globalThis.CSS ??= { escape: (s) => String(s).replace(/"/g, '\\"') };
// Nothing here talks to the server (saves fail quietly).
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'not in this test' }), headers: { get: () => '' } });

const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { setMockMode } = await import('../v2/client.js');
const { useV2 } = await import('../v2/state.js');
const { useHedwig } = await import('../store.js');
const { registerView, getView } = await import('../registry.js');
const { useShell } = await import('./state.js');
const { buildTemplate } = await import('./templates.js');
const { layoutMenuItems, ViewMenuButton } = await import('./TopBar.jsx');
const { MenuButton, tidyItems } = await import('./Menu.jsx');
const { ViewHost } = await import('./ViewHost.jsx');
const M = await import('./model.js');

setMockMode(true);
useStore.getState().setUser?.({ id: 'u1', isAdmin: true });

let root;
let host;
async function render(el) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await React.act(async () => { root.render(el); });
  await settle();
  return host;
}
async function settle(ms = 20) {
  await React.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
async function click(el) {
  assert.ok(el, 'element to click exists');
  await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle();
}
async function cleanup() {
  if (root) await React.act(async () => root.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
}
const all = (sel, scope = document) => [...scope.querySelectorAll(sel)];

function onStreams() {
  useShell.setState({ device: 'desktop', tree: buildTemplate('streams'), name: 'Streams', templateId: 'streams', rows: [], overlay: null, transient: {} });
}

beforeEach(() => { onStreams(); useV2.setState({ scheme: null, selected: null }); });
after(async () => { await cleanup(); });

describe('the View menu', () => {
  test('offers the three Hedwig layouts with a line each, current one checked, and no upstream preset', () => {
    const items = layoutMenuItems({ phone: false });
    assert.equal(items[0].type, 'header');
    assert.equal(items[0].label, 'Layout');
    const layouts = items.filter((i) => i.id?.startsWith('t:'));
    assert.deepEqual(layouts.map((i) => i.label), ['Streams', 'Triage', 'Research']);
    for (const i of layouts) assert.ok(i.description && i.description.length > 10, `${i.label} has a description`);
    assert.deepEqual(layouts.map((i) => i.checked), [true, false, false]);
    assert.ok(layouts.every((i) => i.radio), 'layouts are one choice (menuitemradio)');
    const labels = items.map((i) => i.label).filter(Boolean);
    for (const upstream of ['Focused', 'Compact', 'Comfortable', 'Wide', 'Vertical']) {
      assert.ok(!labels.includes(upstream), `${upstream} is not in the Hedwig View menu`);
    }
    assert.ok(!items.some((i) => i.hint === 'upstream'));
  });

  test('Arrange panes and Export are in Customize layout, not the menu', () => {
    const ids = layoutMenuItems({ phone: false }).map((i) => i.id).filter(Boolean);
    assert.ok(ids.includes('customize'));
    assert.ok(!ids.includes('arrange'));
    assert.ok(!ids.includes('export'));
    assert.ok(!ids.includes('edit'));
  });

  test('Appearance is a Light / Dark / Auto radio that sets the scheme', () => {
    const items = layoutMenuItems({ phone: false });
    const header = items.findIndex((i) => i.type === 'header' && i.label === 'Appearance');
    assert.ok(header > 0);
    const radio = items[header + 1];
    assert.equal(radio.type, 'radio');
    assert.deepEqual(radio.options.map((o) => o.label), ['Light', 'Dark', 'Auto']);
    assert.equal(radio.options.filter((o) => o.checked).length, 1);
    const calls = [];
    const setScheme = useV2.getState().setScheme;
    useV2.setState({ setScheme: (s) => calls.push(s) });
    try { radio.options[1].onSelect(); } finally { useV2.setState({ setScheme }); }
    assert.deepEqual(calls, ['dark']);
    useV2.setState({ scheme: 'auto' });
    assert.equal(layoutMenuItems({ phone: false }).find((i) => i.type === 'radio').options.find((o) => o.checked).id, 'auto');
    assert.ok(!items.some((i) => /Light or dark/.test(i.label || '')));
  });

  test('Settings and Mail settings have icons; the classic shell is last, separated, with its line', () => {
    const items = layoutMenuItems({ phone: false });
    const settings = items.find((i) => i.id === 'hedwig-settings');
    const mail = items.find((i) => i.id === 'mail-settings');
    assert.equal(settings.label, 'Settings');
    assert.ok(settings.icon && mail.icon);
    const last = items.at(-1);
    assert.equal(last.id, 'classic');
    assert.equal(last.label, 'Classic MailFlow shell');
    assert.match(last.description, /original MailFlow layout/);
    assert.equal(items.at(-2).type, 'separator');
    let mode = null;
    const setShellMode = useHedwig.getState().setShellMode;
    useHedwig.setState({ setShellMode: (m) => { mode = m; } });
    try { layoutMenuItems({ phone: false }).at(-1).onSelect(); } finally { useHedwig.setState({ setShellMode }); }
    assert.equal(mode, 'classic');
  });

  test('Saved lists only layouts the user made; the pre-v2 Classic row is not a layout', () => {
    const classicTree = { ...M.normalise(M.split('row', [M.view('core.nav'), M.view('core.list'), M.view('core.thread')])), version: 2 };
    useShell.setState({ rows: [
      { id: 'a', name: 'Streams', device: 'desktop', tree: buildTemplate('streams'), is_active: true },
      { id: 'b', name: 'Classic', device: 'desktop', tree: classicTree },
      { id: 'c', name: 'Reading room', device: 'desktop', tree: buildTemplate('research') },
    ] });
    const items = layoutMenuItems({ phone: false });
    assert.deepEqual(items.filter((i) => i.id?.startsWith('s:')).map((i) => i.label), ['Reading room']);
    const saved = items.findIndex((i) => i.type === 'header' && i.label === 'Saved');
    assert.ok(saved > items.findIndex((i) => i.id === 't:research'), 'Saved follows the layouts');
  });

  test('picking a layout applies it; the menu shows it checked', () => {
    layoutMenuItems({ phone: false }).find((i) => i.id === 't:triage').onSelect();
    assert.equal(useShell.getState().templateId, 'triage');
    assert.deepEqual(layoutMenuItems({ phone: false }).filter((i) => i.id?.startsWith('t:')).map((i) => i.checked), [false, true, false]);
  });

  test('a caller that appends its own Appearance and Settings rows does not double them', () => {
    const shared = layoutMenuItems({ phone: false });
    const railStyle = [...shared, { type: 'separator' }, { id: 'scheme', label: 'Light or dark: Light' }, { id: 'hedwig-settings', label: 'Hedwig settings' }, { id: 'mail-settings', label: 'Mail settings' }];
    const shown = tidyItems(railStyle);
    assert.deepEqual(shown.map((i) => i.id || i.type), shared.map((i) => i.id || i.type));
    assert.equal(shown.at(-1).id, 'classic', 'the classic shell stays last');
    assert.deepEqual(tidyItems([{ type: 'separator' }, { id: 'a' }, { type: 'separator' }, { type: 'separator' }, { id: 'b' }, { type: 'separator' }]).map((i) => i.id || i.type), ['a', 'separator', 'b']);
  });

  test('on a phone the same menu without the Layout section', () => {
    const items = layoutMenuItems({ phone: true });
    assert.ok(!items.some((i) => i.id?.startsWith('t:') || i.id === 'customize'));
    assert.ok(items.some((i) => i.type === 'radio'));
    assert.equal(items.at(-1).id, 'classic');
  });

  test('renders descriptions under labels, layouts as menuitemradio and Appearance as a radio group', async () => {
    await render(h(ViewMenuButton, { variant: 'rail' }));
    const button = document.querySelector('[aria-haspopup="menu"]');
    assert.match(button.getAttribute('aria-label'), /^View: Streams/);
    await click(button);
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu, 'the menu opens');
    const streams = menu.querySelector('[data-menu-item="t:streams"]');
    assert.equal(streams.getAttribute('role'), 'menuitemradio');
    assert.equal(streams.getAttribute('aria-checked'), 'true');
    const line = streams.querySelector('[data-menu-description]');
    assert.ok(line, 'a description line');
    assert.equal(line.style.fontSize, '12px');
    const group = menu.querySelector('[data-menu-radio="scheme"]');
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'), 'Appearance');
    assert.equal(all('[role="menuitemradio"]', group).length, 3);
    // A pick in the radio keeps the menu open (the change shows at once).
    const setScheme = useV2.getState().setScheme;
    useV2.setState({ setScheme: (s) => useV2.setState({ scheme: s }) });
    try { await click(all('[role="menuitemradio"]', group)[1]); } finally { useV2.setState({ setScheme }); }
    assert.ok(document.querySelector('[role="menu"]'), 'still open');
    assert.equal(all('[role="menuitemradio"]', document.querySelector('[data-menu-radio="scheme"]'))[1].getAttribute('aria-checked'), 'true');
    await cleanup();
  });

  test('below 768px the menu opens as a sheet with a heading and Done', async () => {
    await render(h(MenuButton, { label: 'View', heading: 'View', sheet: true, items: () => layoutMenuItems({ phone: true }) }, 'open'));
    await click(document.querySelector('[aria-haspopup="menu"]'));
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu.hasAttribute('data-menu-sheet'));
    assert.ok(document.querySelector('[data-menu-backdrop]'));
    assert.ok([...menu.querySelectorAll('button')].some((b) => b.textContent === 'Done'));
    assert.equal(menu.querySelector('[data-menu-item="classic"]').style.minHeight, '44px');
    await cleanup();
  });
});

describe('the modes', () => {
  test('the Triage context pane follows the thread open in the v2 reader', async () => {
    const seen = [];
    if (!getView('test.follower')) registerView({ id: 'test.follower', title: 'Follower', component: ({ props }) => { seen.push(props.messageId || null); return null; } });
    await render(h(ViewHost, { paneKey: 'p1', viewId: 'test.follower', props: {}, follows: 'hedwig.thread' }));
    assert.equal(seen.at(-1), null);
    await React.act(async () => { useV2.getState().select({ messageId: 'm-anna', threadId: 't-anna' }); });
    await settle();
    assert.equal(seen.at(-1), 'm-anna');
    await React.act(async () => { useV2.getState().select({ messageId: 'm-erik' }); });
    await settle();
    assert.equal(seen.at(-1), 'm-erik');
    await cleanup();
  });

  test('a pane that follows something else is not given the reader’s message', async () => {
    const seen = [];
    if (!getView('test.other')) registerView({ id: 'test.other', title: 'Other', component: ({ props }) => { seen.push(props.messageId || null); return null; } });
    useV2.getState().select({ messageId: 'm-anna' });
    await render(h(ViewHost, { paneKey: 'p2', viewId: 'test.other', props: {}, follows: 'core.thread' }));
    assert.equal(seen.at(-1), null);
    await cleanup();
  });

  test('in Research a rail click shows the stream in the list slot, not in a drawer over the reader', () => {
    useShell.getState().applyTemplate('research');
    const tree = useShell.getState().tree;
    const slot = tree.children[1].key;
    useShell.getState().handleViewRequest({ id: 'hedwig.stream.people', props: {}, nonce: 'n1' });
    const after = useShell.getState();
    assert.equal(after.overlay, null);
    assert.deepEqual(M.listPanes(after.tree).map((p) => p.node.id), ['hedwig.rail', 'hedwig.stream.people', 'hedwig.thread']);
    assert.equal(after.tree.children[1].key, slot);
  });

  test('a view that is not a place still opens in the drawer', () => {
    useShell.getState().applyTemplate('research');
    useShell.getState().handleViewRequest({ id: 'hedwig.timeline', props: {}, nonce: 'n2' });
    assert.equal(useShell.getState().overlay?.id, 'hedwig.timeline');
    assert.ok(M.listPanes(useShell.getState().tree).some((p) => p.node.id === 'hedwig.ask'), 'Ask stays');
  });
});
