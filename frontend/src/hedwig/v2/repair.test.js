// Tests for the 2026-09-24 repair: the one-time move out of the classic shell and the pre-v2
// layout migration (against the production user's own layout row), the way back from the classic
// shell, TL;DR lines on rows, the story so far with its provenance, the Tier 2 note and the
// lighter-model labels, and the admin Models and routing page. Rendered against mock.js.
//
// Same harness as v2.test.js. Run with: node --test src/hedwig/v2/repair.test.js
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';
import process from 'node:process';

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
// hedwigApi (the layouts, /status) goes through fetch; a test installs a handler per route.
const fetched = [];
let fetchRoutes = null;
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  fetched.push({ method, url: String(url), body });
  const hit = await fetchRoutes?.(method, String(url).replace(/^\/api\/hedwig/, ''), body);
  if (hit === undefined) return { ok: false, status: 404, json: async () => ({ error: 'not in this test' }), headers: { get: () => '' } };
  return { ok: true, status: 200, json: async () => hit, headers: { get: () => 'application/json' } };
};


const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { setMockMode } = await import('./client.js');
const mock = await import('./mock.js');
const { useV2, UI_DEFAULTS } = await import('./state.js');
const { useHedwig, initialShellMode, SHELL_KEY, SHELL_STAMP } = await import('../store.js');
const { useShell, resetMigrationNote, setLoadTimeout } = await import('../shell/state.js');
const { pickLayout, isPreV2Layout, CLASSIC_NAME } = await import('../shell/layouts.js');
const { layoutMenuItems } = await import('../shell/TopBar.jsx');
const ClassicWayBack = (await import('../shell/ClassicWayBack.jsx')).default;
const { tldrOf } = await import('./format.js');
const { tierState, tierLabel, isLighter, tierNotice } = await import('./tiers.js');
const { resetTldrCache } = await import('./tldrs.js');
const { WhyDoor, powerSignals } = await import('./WhyDoor.jsx');
const { proseNote } = await import('./Brief.jsx');
const Ledger = (await import('./Ledger.jsx')).default;
const { reduceAsk2, askStarted, fromSaved, coverageGap } = await import('./ask.js');
const { effortOptions, clampEffort, chatModels, usageRows, tierChoiceLabel, servingLine } = await import('../views/settings/RoutingSettings.jsx');
const RoutingSettings = (await import('../views/settings/RoutingSettings.jsx')).default;
const StreamView = (await import('./StreamView.jsx')).default;
const Screener = (await import('./Screener.jsx')).default;
const Thread = (await import('./Thread.jsx')).default;
const Rail = (await import('./Rail.jsx')).default;
const Brief = (await import('./Brief.jsx')).default;
const Ask = (await import('../views/Ask.jsx')).default;

setMockMode(true);
const notifications = [];
useStore.setState({ addNotification: (n) => notifications.push(n) });
useStore.getState().setUser?.({ id: 'u1', isAdmin: true });
useStore.getState().setAccounts?.([{ id: 'acc-work', email_address: 'me@example.org', enabled: true, aliases: [] }]);

// ── helpers ──────────────────────────────────────────────────────────────────
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
async function settle(ms = 30) {
  await React.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
async function click(el) {
  assert.ok(el, 'element to click exists');
  await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle();
}
async function choose(select, value) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(select, value);
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await settle(40);
}
const all = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const byText = (sel, text, scope = document) => all(sel, scope).find((e) => e.textContent.trim() === text);
const byLabel = (label, scope = document) => scope.querySelector(`[aria-label="${label}"]`);
const text = () => document.body.textContent;
const requests = () => mock.mockRequests();

async function cleanup() {
  if (root) await React.act(async () => root.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
}

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), dump: () => Object.fromEntries(m) };
}

const healthyStatus = () => ({ ready: true, enabled: true, features: { sort: true, context: true }, models: {
  fast: { primary: 'google/gemma-4-12B-it-qat-w4a16-ct', fallback: 'google/gemma-4-12B-it-qat-w4a16-ct', active: 'google/gemma-4-12B-it-qat-w4a16-ct', degraded: false },
  long: { primary: 'Qwen/Qwen3.8-Flash-Next', fallback: 'google/gemma-4-12B-it-qat-w4a16-ct', active: 'Qwen/Qwen3.8-Flash-Next', degraded: false },
} });
const degradedStatus = () => {
  const s = healthyStatus();
  s.models.long = { ...s.models.long, active: 'google/gemma-4-12B-it-qat-w4a16-ct', degraded: true };
  return s;
};

beforeEach(async () => {
  await cleanup();
  mock.resetMock();
  mock.mockRequests({ clear: true });
  notifications.length = 0;
  resetMigrationNote();
  fetched.length = 0;
  fetchRoutes = null;
  useV2.setState({ selected: null, prefs: { ...UI_DEFAULTS }, caps: { work: true }, settingsFields: null });
  useHedwig.setState({ status: healthyStatus(), shellMode: 'hedwig' });
});

// The production user's only layout row (hedwig_layouts, 2026-09-23 07:33, pre-v2, active).
const PROD_ROW = {
  id: 'd8a6093d-b4a4-4767-816a-2da90c98d67e', name: 'Triage', device: 'desktop', is_active: true, updated_at: '2026-09-23T07:33:00.123Z',
  tree: { dir: 'row', key: 'pfyzen5', type: 'split', sizes: [220, 420, null, 320], defaults: [220, 420, null, 320], children: [
    { id: 'core.nav', key: 'p0q43g1', type: 'view' },
    { id: 'hedwig.needs', key: 'piqlkt2', type: 'view' },
    { id: 'core.thread', key: 'pzfr653', type: 'view' },
    { id: 'hedwig.context', key: 'pozqtm4', type: 'view', follows: 'core.thread' },
  ] },
};

// ── shell mode ───────────────────────────────────────────────────────────────
describe('shell mode: the one-time move out of the classic shell', () => {
  test('a classic choice stored before v2 opens the Hedwig shell once, and the stamp is written', () => {
    const st = memoryStorage({ [SHELL_KEY]: 'classic' });
    assert.equal(initialShellMode(st), 'hedwig');
    assert.equal(st.getItem(SHELL_KEY), 'hedwig');
    assert.equal(st.getItem(SHELL_STAMP), '1');
  });

  test('after the stamp, the user\'s own choice sticks, classic included', () => {
    const st = memoryStorage({ [SHELL_KEY]: 'classic', [SHELL_STAMP]: '1' });
    assert.equal(initialShellMode(st), 'classic');
    assert.equal(initialShellMode(memoryStorage({ [SHELL_KEY]: 'hedwig', [SHELL_STAMP]: '1' })), 'hedwig');
  });

  test('nothing stored, junk stored, or storage that throws: the Hedwig shell', () => {
    assert.equal(initialShellMode(memoryStorage()), 'hedwig');
    assert.equal(initialShellMode(memoryStorage({ [SHELL_KEY]: 'weird', [SHELL_STAMP]: '1' })), 'hedwig');
    assert.equal(initialShellMode({ getItem() { throw new Error('blocked'); }, setItem() {} }), 'hedwig');
    assert.equal(initialShellMode(null), 'hedwig');
  });

  test('switching shells stamps too, so a later load keeps the choice', () => {
    localStorage.removeItem(SHELL_STAMP);
    useHedwig.getState().setShellMode('classic');
    assert.equal(localStorage.getItem(SHELL_KEY), 'classic');
    assert.equal(localStorage.getItem(SHELL_STAMP), '1');
    assert.equal(initialShellMode(localStorage), 'classic');
    useHedwig.getState().setShellMode('hedwig');
    assert.equal(initialShellMode(localStorage), 'hedwig');
  });
});

describe('the way back from the classic shell', () => {
  test('in the classic shell a quiet line says so and switches to the Hedwig layout', async () => {
    useHedwig.setState({ shellMode: 'classic' });
    await render(h(ClassicWayBack, {}));
    const btn = byLabel('Switch to the Hedwig layout');
    assert.ok(btn, 'the button is there');
    assert.match(btn.textContent, /Classic layout/);
    assert.match(btn.textContent, /Hedwig layout/);
    await click(btn);
    assert.equal(useHedwig.getState().shellMode, 'hedwig');
    assert.equal(localStorage.getItem(SHELL_KEY), 'hedwig');
    assert.equal(document.querySelector('[data-hedwig-way-back]'), null, 'gone once in the Hedwig shell');
  });

  test('a collapsed sidebar gets the owl button; the Hedwig shell gets nothing', async () => {
    useHedwig.setState({ shellMode: 'classic' });
    await render(h(ClassicWayBack, { collapsed: true }));
    const btn = byLabel('Switch to the Hedwig layout');
    assert.ok(btn);
    assert.equal(btn.textContent.trim(), '');
    await cleanup();
    useHedwig.setState({ shellMode: 'hedwig' });
    await render(h(ClassicWayBack, {}));
    assert.equal(document.querySelector('[data-hedwig-way-back]'), null);
  });

  test('on a phone (the sidebar drawer) the line is a 44 px target', async () => {
    useHedwig.setState({ shellMode: 'classic' });
    Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
    try {
      await render(h(ClassicWayBack, {}));
      assert.equal(byLabel('Switch to the Hedwig layout').style.minHeight, '44px');
    } finally {
      Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
    }
  });

  test('the classic shell is in the layout menu, not a one-click button in the top bar', async () => {
    const src = readFileSync(new URL('../shell/TopBar.jsx', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /onClick=\{\(\) => setShellMode\('classic'\)\}/);
    assert.ok(layoutMenuItems().some((i) => i.id === 'classic'));
    assert.match(readFileSync(new URL('../../components/Sidebar.jsx', import.meta.url), 'utf8'), /<ClassicWayBack collapsed=\{sidebarCollapsed\} \/>/);
  });
});

// ── the pre-v2 layout migration, on the production row ──────────────────────────
describe('layout migration for a layout saved before v2', () => {
  test('the production "Triage" row is pre-v2 and moves to Streams, kept as Classic from its own row', () => {
    assert.equal(isPreV2Layout(PROD_ROW.tree), true);
    const pick = pickLayout([PROD_ROW], 'desktop', undefined);
    assert.equal(pick.source, 'migrate');
    assert.equal(pick.templateId, 'streams');
    assert.equal(pick.classic.name, CLASSIC_NAME);
    assert.equal(pick.classic.device, 'desktop');
    assert.equal(pick.classic.fromId, PROD_ROW.id);
    const tablet = pickLayout([PROD_ROW], 'tablet', undefined);
    assert.equal(tablet.source, 'migrate');
    assert.equal(tablet.classic.device, 'desktop', 'on a tablet the old row is still the desktop one');
  });

  function layoutServer(rows) {
    const db = rows.map((r) => ({ ...r }));
    let n = 0;
    fetchRoutes = (method, path, body) => {
      if (method === 'GET' && path === '/layouts') return db.map((r) => ({ ...r }));
      if (method === 'PUT' && path === '/layouts') {
        if (body.active) for (const r of db) if (r.device === body.device) r.is_active = false;
        let row = db.find((r) => r.device === body.device && r.name === body.name);
        if (row) Object.assign(row, { tree: body.tree, is_active: body.active || row.is_active });
        else { row = { id: `new-${++n}`, name: body.name, device: body.device, tree: body.tree, is_active: Boolean(body.active), updated_at: new Date().toISOString() }; db.push(row); }
        return { ...row };
      }
      if (method === 'DELETE' && path.startsWith('/layouts/')) {
        const id = path.split('/').pop();
        db.splice(db.findIndex((r) => r.id === id), 1);
        return { ok: true };
      }
      return undefined;
    };
    return db;
  }

  test('init on the desktop: Streams on screen, the old tree saved as Classic, the old row removed, a note says where it went', async () => {
    const db = layoutServer([PROD_ROW]);
    localStorage.clear();
    await useShell.getState().init('desktop');
    const shell = useShell.getState();
    assert.equal(shell.name, 'Streams');
    assert.ok(JSON.stringify(shell.tree).includes('hedwig.rail'), 'the rail is on screen');
    const puts = fetched.filter((f) => f.method === 'PUT');
    assert.equal(puts[0].body.name, 'Classic');
    assert.equal(puts[0].body.active, false);
    assert.equal(puts[0].body.device, 'desktop');
    assert.equal(puts[0].body.tree.version, 2, 'Classic is stamped, so it is never moved again');
    assert.deepEqual(puts[0].body.tree.children.map((c) => c.id), ['core.nav', 'hedwig.needs', 'core.thread', 'hedwig.context']);
    assert.ok(fetched.some((f) => f.method === 'DELETE' && f.url.endsWith(`/layouts/${PROD_ROW.id}`)));
    assert.equal(puts[1].body.name, 'Streams');
    assert.equal(puts[1].body.active, true);
    assert.deepEqual(db.map((r) => [r.name, r.device, r.is_active]).sort(), [['Classic', 'desktop', false], ['Streams', 'desktop', true]]);
    assert.ok(shell.savedLayouts().some((r) => r.name === 'Classic'));
    const saved = layoutMenuItems().filter((i) => i.id?.startsWith('s:')).map((i) => i.label);
    assert.deepEqual(saved, ['Classic'], 'Classic is in the layout menu');
    assert.match(notifications.at(-1).body, /“Classic”/);

    // The next load keeps Streams and does not migrate again.
    fetched.length = 0;
    await useShell.getState().init('desktop');
    assert.equal(fetched.filter((f) => f.method !== 'GET').length, 0);
    assert.equal(useShell.getState().name, 'Streams');
  });

  test('two loads at once (a second tab, StrictMode, a device change) end with one Classic, one Streams and one note', async () => {
    const db = layoutServer([PROD_ROW]);
    localStorage.clear();
    await Promise.all([useShell.getState().init('desktop'), useShell.getState().init('desktop')]);
    await settle(20);
    assert.deepEqual(db.map((r) => [r.name, r.device, r.is_active]).sort(), [['Classic', 'desktop', false], ['Streams', 'desktop', true]]);
    assert.equal(notifications.length, 1, 'one note, not two');
    assert.equal(useShell.getState().name, 'Streams');
    assert.equal(useShell.getState().ready, true);
    // Reloads after that change nothing and say nothing.
    resetMigrationNote();
    for (let i = 0; i < 2; i++) await useShell.getState().init('desktop');
    assert.equal(db.filter((r) => r.name === 'Classic').length, 1);
    assert.equal(notifications.length, 1);
  });

  test('a migration cut short (the old row could not be removed) finishes on the next load without a second Classic', async () => {
    const db = layoutServer([PROD_ROW]);
    const serve = fetchRoutes;
    fetchRoutes = (method, path, body) => (method === 'DELETE' ? undefined : method === 'PUT' && body.name === 'Streams' ? undefined : serve(method, path, body));
    localStorage.clear();
    await useShell.getState().init('desktop');
    assert.deepEqual(db.map((r) => [r.name, r.is_active]).sort(), [['Classic', false], ['Triage', true]], 'Classic saved, Triage still there and active');
    fetchRoutes = serve;
    resetMigrationNote();
    await useShell.getState().init('desktop');
    assert.deepEqual(db.map((r) => [r.name, r.device, r.is_active]).sort(), [['Classic', 'desktop', false], ['Streams', 'desktop', true]]);
  });

  test('when Classic cannot be saved the note names the row the old layout is still in', async () => {
    const db = layoutServer([PROD_ROW]);
    const serve = fetchRoutes;
    fetchRoutes = (method, path, body) => (method === 'PUT' && body.name === 'Classic' ? undefined : serve(method, path, body));
    localStorage.clear();
    await useShell.getState().init('desktop');
    assert.equal(useShell.getState().name, 'Streams');
    assert.ok(db.some((r) => r.name === 'Triage'), 'the old row is not removed when Classic was not saved');
    assert.match(notifications.at(-1).body, /“Triage”/);
    assert.doesNotMatch(notifications.at(-1).body, /Classic/);
  });

  test('/layouts timing out: Streams on screen, no crash; the late answer still moves the old layout to Classic', async () => {
    const db = layoutServer([PROD_ROW]);
    const serve = fetchRoutes;
    let release;
    const gate = new Promise((r) => { release = r; });
    fetchRoutes = (method, path, body) => (method === 'GET' && path === '/layouts' ? gate.then(() => serve(method, path, body)) : serve(method, path, body));
    localStorage.clear();
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    setLoadTimeout(20);
    try {
      await useShell.getState().init('desktop');
      const shell = useShell.getState();
      assert.equal(shell.ready, true);
      assert.equal(shell.name, 'Streams');
      assert.ok(JSON.stringify(shell.tree).includes('hedwig.rail'));
      assert.equal(fetched.filter((f) => f.method !== 'GET').length, 0, 'nothing written without the server\'s rows');
      assert.equal(notifications.length, 0);
      release();
      await settle(40);
      assert.deepEqual(db.map((r) => [r.name, r.device, r.is_active]).sort(), [['Classic', 'desktop', false], ['Streams', 'desktop', true]]);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0].body, /“Classic”/);
      assert.ok(useShell.getState().savedLayouts().some((r) => r.name === 'Classic'), 'the layout menu has its rows');
      assert.equal(unhandled.length, 0);
    } finally {
      setLoadTimeout(4000);
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('/layouts failing outright: Streams on screen and nothing written', async () => {
    fetchRoutes = () => undefined;
    localStorage.clear();
    await useShell.getState().init('desktop');
    assert.equal(useShell.getState().ready, true);
    assert.equal(useShell.getState().name, 'Streams');
    assert.equal(fetched.filter((f) => f.method !== 'GET').length, 0);
    assert.equal(notifications.length, 0);
  });

  test('init on a tablet with only the desktop row: Classic keeps the desktop device, Streams is saved for the tablet', async () => {
    const db = layoutServer([PROD_ROW]);
    localStorage.clear();
    await useShell.getState().init('tablet');
    assert.deepEqual(db.map((r) => [r.name, r.device, r.is_active]).sort(), [['Classic', 'desktop', false], ['Streams', 'tablet', true]]);
    assert.equal(useShell.getState().name, 'Streams');
  });
});

// ── TL;DR lines ────────────────────────────────────────────────────────────
describe('TL;DR on rows', () => {
  test('tldrOf takes a string or { text }, and drops noise', () => {
    assert.equal(tldrOf({ tldr: '  Wants the  numbers. ' }), 'Wants the numbers.');
    assert.equal(tldrOf({ tldr: { text: 'From an object' } }), 'From an object');
    assert.equal(tldrOf({ summary: 'Alias' }), 'Alias');
    assert.equal(tldrOf({ tldr: 'undefined' }), null);
    assert.equal(tldrOf({ tldr: '{"text":"raw json"}' }), null);
    assert.equal(tldrOf({ tldr: 'Same as subject', subject: 'same as subject' }), null);
    assert.equal(tldrOf({ tldr: 42 }), null);
    assert.equal(tldrOf({}), null);
    assert.equal(tldrOf({ tldr: 'x'.repeat(400) }).length, 240);
  });

  test('People rows show the one line under the subject when there is one, and describe the row with it', async () => {
    await render(h(StreamView, { props: { stream: 'people' } }));
    const anna = byLabel('Anna Berg: Q3 report: can you send the final numbers?, unread');
    assert.ok(anna, 'the row keeps its name');
    const line = anna.querySelector('[data-tldr]');
    assert.equal(line.textContent, 'Wants the final Q3 numbers by Thursday evening for Friday’s board pack.');
    assert.equal(anna.getAttribute('aria-describedby'), line.id);
    const jonas = all('[data-row-button]').find((b) => b.getAttribute('aria-label').startsWith('Jonas Weber'));
    assert.equal(jonas.querySelector('[data-tldr]'), null, 'no TL;DR, no empty line');
    assert.doesNotMatch(text(), /undefined|\[object Object\]/);
  });

  test('Screener rows show the TL;DR (GET /work/tldr on their latest message), else the latest subject', async () => {
    resetTldrCache();
    await render(h(Screener, {}));
    await settle(60);
    assert.equal(requests().filter((r) => r.startsWith('GET /work/tldr?ids=')).length, 1, 'one call for every sender');
    const nordlys = document.querySelector('article[aria-label="Nordlys Travel"]');
    assert.equal(nordlys.querySelector('[data-tldr]').textContent, 'Your Bergen booking is confirmed: 3 nights, reference NT-44821.');
    const maria = document.querySelector('article[aria-label="María López"], article[aria-label="Maria López"]');
    assert.equal(maria.querySelector('[data-tldr]').textContent, 'Studio visit next week?');
    const ruter = document.querySelector('article[aria-label="Ruter"]');
    assert.equal(ruter.querySelector('[data-tldr]'), null);
  });
});

// ── the story so far ─────────────────────────────────────────────────────────
describe('the story so far', () => {
  const anna = async () => (await mock.mockRequest('GET', '/sort/stream/people?limit=100')).items.find((i) => i.messageId === 'm-anna');

  test('shows with citations; written by the lighter model says so', async () => {
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    const story = byLabel('The story so far');
    assert.ok(story);
    assert.equal(all('button[aria-label^="Message "]', story).length, 3);
    assert.equal(story.querySelector('[data-lighter]'), null, 'Tier 1 wrote it as planned: no label');
    await cleanup();

    mock.mockThreadExtras('t-anna', { storyMeta: { source: 'open', tier: 'reflex', model: 'google/gemma-4-12B-it-qat-w4a16-ct', lighter: true } });
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    assert.equal(byLabel('The story so far').querySelector('[data-lighter]').textContent, 'Written by the lighter model');
  });

  test('a failed story says so in words (never the raw error) and Try again asks for a fresh one', async () => {
    mock.mockThreadExtras('t-anna', { story: null, storyError: 'no response within 45000 ms' });
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    assert.equal(byLabel('The story so far'), null);
    assert.match(text(), /Hedwig could not write the story so far just now\./);
    assert.doesNotMatch(text(), /45000/);
    mock.mockRequests({ clear: true });
    await click(byText('button', 'Try again'));
    await settle(60);
    assert.ok(requests().includes('GET /work/thread/t-anna?refresh=1'));
  });

  test('over budget: a plain sentence and no retry', async () => {
    mock.mockThreadExtras('t-anna', { story: null, storyError: 'budget' });
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    assert.match(text(), /budget for summaries is spent/);
    assert.equal(byText('button', 'Try again'), undefined);
  });

  test('quick replies sit under the message and insert, not send', async () => {
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    const qr = byText('button', 'Sending them now.');
    assert.ok(qr);
    const article = document.querySelector('article#hw-msg-5');
    assert.ok(article.compareDocumentPosition(qr) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'under the latest message');
    mock.mockRequests({ clear: true });
    await click(qr);
    assert.equal(byLabel('Reply to Anna').value, 'Sending them now.');
    assert.equal(requests().filter((r) => r.startsWith('POST')).length, 0);
  });
});

describe('TL;DRs in the thread, Reading and Records, and the inline question', () => {
  const anna = async () => (await mock.mockRequest('GET', '/sort/stream/people?limit=100')).items.find((i) => i.messageId === 'm-anna');

  test('each message shows its TL;DR above the text; a thread without a story shows its own TL;DR', async () => {
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    const latest = document.querySelector('article#hw-msg-5');
    assert.equal(latest.querySelector('[data-tldr]').textContent, 'Wants the final Q3 numbers by Thursday evening; the revenue lines are fixed.');
    assert.equal(document.querySelector('[data-thread-tldr]'), null, 'the story is there, so no separate thread TL;DR');
    await cleanup();
    mock.mockThreadExtras('t-anna', { story: null, storyMeta: null });
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    assert.equal(document.querySelector('[data-thread-tldr]').textContent, 'Anna needs your final Q3 numbers by Thursday evening.');
  });

  test('the open question about a message is asked under it and answered there', async () => {
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    const q = byLabel('A question from Hedwig');
    assert.ok(q, 'GET /labels/questions/for/m-anna has one');
    assert.ok(document.querySelector('article#hw-msg-5').contains(q));
    await click(byText('button', 'No', q));
    assert.equal(byLabel('A question from Hedwig'), null);
    assert.deepEqual(mock.mockAnswers().at(-1), { id: 'q-anna', optionId: 'no', always: false });
  });

  test('Reading and Screener rows get their TL;DRs in one GET /work/tldr call; nothing without the work routes', async () => {
    resetTldrCache();
    await render(h(StreamView, { props: { stream: 'reading' } }));
    await settle(60);
    const ben = all('[data-row-button]').find((b) => b.getAttribute('aria-label').startsWith('Benedict'));
    assert.equal(ben.querySelector('[data-tldr]').textContent, 'On-device models turn the browser into an inference runtime.');
    assert.equal(requests().filter((r) => r.startsWith('GET /work/tldr?ids=')).length, 1);
    await cleanup();
    resetTldrCache();
    mock.mockRequests({ clear: true });
    useV2.setState({ caps: { work: false } });
    await render(h(StreamView, { props: { stream: 'reading' } }));
    await settle(60);
    assert.equal(requests().filter((r) => r.startsWith('GET /work/tldr')).length, 0);
    assert.equal(document.querySelector('[data-tldr]'), null);
  });

  test('re-renders, list refreshes and the status poll do not ask for TL;DRs or cards again', async () => {
    resetTldrCache();
    const count = (prefix) => requests().filter((r) => r.startsWith(prefix)).length;
    const churn = async () => {
      for (let i = 0; i < 3; i++) {
        // A sort change reloads the lists (new item objects, same ids) …
        await React.act(async () => { window.dispatchEvent(new CustomEvent('hedwig:sort-changed')); });
        await settle(360);
        // … and a /status answer re-renders every view.
        await React.act(async () => { useHedwig.setState({ status: { ...healthyStatus(), n: i } }); });
        await settle(20);
      }
    };
    await render(h(StreamView, { props: { stream: 'reading' } }));
    await settle(60);
    assert.ok(requests().filter((r) => r.startsWith('GET /sort/stream/reading')).length >= 1);
    assert.equal(count('GET /work/tldr?ids='), 1);
    const listLoads = count('GET /sort/stream/reading');
    await churn();
    assert.ok(count('GET /sort/stream/reading') > listLoads, 'the list did reload');
    assert.equal(count('GET /work/tldr?ids='), 1, 'rows without a TL;DR yet are not asked about again at once');
    await cleanup();

    mock.mockRequests({ clear: true });
    await render(h(StreamView, { props: { stream: 'records' } }));
    await settle(80);
    const tldrCalls = count('GET /work/tldr?ids=');
    assert.ok(tldrCalls <= 1);
    assert.equal(count('GET /cards/messages?ids='), 1);
    await churn();
    assert.equal(count('GET /work/tldr?ids='), tldrCalls);
    // Cards follow sort changes (a correction can move a card), once per burst, never per row.
    assert.ok(count('GET /cards/messages?ids=') <= 4, `at most one per sort change, got ${count('GET /cards/messages?ids=')}`);
  });

  test('Records rows take their cards from GET /cards/messages in one call', async () => {
    await render(h(StreamView, { props: { stream: 'records' } }));
    await settle(80);
    assert.ok(requests().some((r) => r.startsWith('GET /cards/messages?ids=')));
    assert.ok(!requests().includes('GET /cards?limit=200'), 'the older list is only the fallback');
    assert.match(text(), /arriving today|out for delivery/i);
  });
});

// ── tiers ───────────────────────────────────────────────────────────────────
describe('Tier 2 status and the lighter model', () => {
  test('tierState reads /status models today and tiers when the runtime ships them', () => {
    assert.equal(tierState(healthyStatus()).reasoningDegraded, false);
    assert.equal(tierState(degradedStatus()).reasoningDegraded, true);
    assert.equal(tierState(degradedStatus()).reasoning.active, 'google/gemma-4-12B-it-qat-w4a16-ct');
    assert.equal(tierState({ tiers: { reasoning: { primary: 'q', fallback: 'g', state: 'degraded' } } }).reasoningDegraded, true);
    assert.equal(tierState({ models: { long: { degraded: true } }, tiers: { reasoning: { degraded: false } } }).reasoningDegraded, false, 'tiers wins');
    const withTiers = mock.mockStatus();
    assert.equal(tierNotice(withTiers), null, 'tiers without a notice: nothing to say');
    mock.mockSetDegraded(true);
    const bad = mock.mockStatus();
    assert.deepEqual(tierNotice(bad).text, 'Tier 2 is slow; using the lighter model');
    assert.match(tierNotice(bad).detail, /answers Tier 2 work until it recovers/);
    assert.equal(tierNotice({ tiers: { notice: null }, models: { long: { degraded: true, primary: 'q', fallback: 'g' } } }), null, 'tiers.notice decides');
    assert.equal(tierNotice(degradedStatus()).text, 'Tier 2 is slow; answers use the lighter model', 'older servers: built from models.long');
    assert.deepEqual(tierState(null), { reflex: null, reasoning: null, reflexDegraded: false, reasoningDegraded: false });
    assert.equal(tierLabel('fast'), 'Tier 1 Reflex (fast)');
    assert.equal(tierLabel('long'), 'Tier 2 Reasoning (long)');
  });

  test('isLighter: an explicit flag decides; a model id only counts for output meant for Tier 2', () => {
    const st = healthyStatus();
    assert.equal(isLighter({ fellBack: true }, st), true);
    assert.equal(isLighter({ lighterModel: true }, st), true);
    assert.equal(isLighter({ lighter: true }, st), true);
    assert.equal(isLighter({ lighterModel: false, model: 'google/gemma-4-12B-it-qat-w4a16-ct' }, st, { expected: 'reasoning' }), false);
    assert.equal(isLighter({ fellBack: false, model: 'google/gemma-4-12B-it-qat-w4a16-ct' }, st, { expected: 'reasoning' }), false);
    assert.equal(isLighter({ model: 'google/gemma-4-12B-it-qat-w4a16-ct' }, st, { expected: 'reasoning' }), true);
    assert.equal(isLighter({ model: 'Qwen/Qwen3.8-Flash-Next' }, st, { expected: 'reasoning' }), false);
    assert.equal(isLighter({ model: 'google/gemma-4-12B-it-qat-w4a16-ct', tier: 'reflex' }, st), false, 'Tier 1 on Gemma is the plan');
    assert.equal(isLighter(null, st), false);
  });

  test('Ask answers carry who wrote them and the coverage, live and saved', () => {
    const cov = { share: 0.62, indexed: 62, total: 100, complete: false };
    const withSources = reduceAsk2(askStarted('q'), { type: 'sources', sources: [], coverage: cov });
    assert.deepEqual(withSources.coverage, cov);
    const live = reduceAsk2(withSources, { type: 'done', answer: 'a', citations: [], lighterModel: true, model: 'g', coverage: cov });
    assert.deepEqual(live.provenance, { model: 'g', lighter: true, tier: null });
    assert.equal(coverageGap(live.coverage), '62%');
    assert.equal(coverageGap({ share: 1, complete: true }), null);
    assert.equal(reduceAsk2(askStarted('q'), { type: 'done', answer: 'a', citations: [] }).provenance, null);
    assert.deepEqual(fromSaved({ id: 1, question: 'q', answer: 'a', status: 'done', model: 'm', lighterModel: false }).provenance, { model: 'm', lighter: false, tier: null });
  });

  test('the rail, Ask and the Brief say Tier 2 is slow only while it is', async () => {
    await render(h(Rail, {}));
    assert.equal(document.querySelector('[data-tier-note]'), null);
    assert.match(document.querySelector('nav footer').textContent, /Up to date/, 'healthy: the footer\'s status line is the sync line');
    await cleanup();
    mock.mockSetDegraded(true);
    useHedwig.setState({ status: mock.mockStatus() });
    await render(h(Rail, {}));
    const note = document.querySelector('[data-tier-note]');
    assert.equal(document.querySelectorAll('[data-tier-note]').length, 1, 'once in the rail');
    assert.ok(note.closest('footer'), 'as the rail footer\'s status line, not under the search field');
    assert.equal(note.closest('button')?.closest('footer'), note.closest('footer'), 'the status line opens Today');
    assert.doesNotMatch(note.closest('footer').textContent, /Up to date/, 'the tier note replaces the sync line while degraded');
    assert.equal(note.textContent, 'Tier 2 is slow; using the lighter model', 'the server’s notice, as it says it');
    assert.equal(note.getAttribute('role'), 'status');
    assert.match(note.title, /gemma/);
    await cleanup();
    await render(h(Ask, { props: {} }));
    assert.ok(document.querySelector('[data-tier-note]'));
    await cleanup();
    await render(h(Brief, {}));
    await settle(60);
    assert.ok(document.querySelector('[data-tier-note]'));
  });

  test('the top bar says it only when the layout has no rail (never twice on screen)', async () => {
    const TopBar = (await import('../shell/TopBar.jsx')).default;
    const { buildTemplate } = await import('../shell/templates.js');
    mock.mockSetDegraded(true);
    useHedwig.setState({ status: mock.mockStatus() });
    useShell.setState({ tree: buildTemplate('streams'), name: 'Streams' });
    await render(h(TopBar, {}));
    assert.equal(document.querySelector('[data-tier-note]'), null, 'Streams has the rail, which says it');
    await cleanup();
    useShell.setState({ tree: PROD_ROW.tree, name: 'Classic' });
    await render(h(TopBar, {}));
    assert.ok(document.querySelector('[data-tier-note]'), 'a layout without the rail gets it in the top bar');
  });

  test('/status: requests asked at once share one call; an unchanged answer does not re-render', async () => {
    let calls = 0;
    let body = healthyStatus();
    fetchRoutes = (method, path) => (method === 'GET' && path === '/status' ? (calls++, body) : undefined);
    useHedwig.setState({ status: null });
    await Promise.all([useHedwig.getState().loadStatus(), useHedwig.getState().loadStatus(), useHedwig.getState().refreshStatus()]);
    assert.equal(calls, 1);
    const before = useHedwig.getState().status;
    await useHedwig.getState().refreshStatus();
    assert.equal(calls, 2);
    assert.equal(useHedwig.getState().status, before, 'same answer, same object: nothing re-renders');
    body = degradedStatus();
    await useHedwig.getState().refreshStatus();
    assert.equal(useHedwig.getState().status.models.long.degraded, true);
    fetchRoutes = () => undefined;
    await useHedwig.getState().refreshStatus();
    assert.equal(useHedwig.getState().status.models.long.degraded, true, 'a failed poll keeps what is known');
  });

  test('an Ask answer the lighter model wrote is labelled; one from Tier 2 is not', async () => {
    await render(h(Ask, { props: { question: 'What did the landlord say about the deposit?' } }));
    await settle(120);
    assert.match(text(), /deposit scheme/);
    assert.equal(document.querySelector('[data-lighter]'), null);
    assert.match(document.querySelector('[data-coverage]').textContent, /Hedwig has read 62% of your mail so far/);
    await cleanup();
    mock.mockSetDegraded(true);
    useHedwig.setState({ status: degradedStatus() });
    await render(h(Ask, { props: { question: 'And what about the keys?' } }));
    await settle(120);
    assert.equal(document.querySelector('[data-lighter]').textContent, 'Answered by the lighter model');
  });
});

// ── admin: Models and routing ─────────────────────────────────────────────────
describe('admin: Models and routing', () => {
  test('helpers: efforts follow the catalog, chat models only, usage summed over tiers', () => {
    const gemma = { id: 'g', capabilities: ['chat', 'reasoning'], reasoning_efforts: ['none', 'high'] };
    const qwen = { id: 'q', capabilities: ['chat', 'reasoning'], reasoning_efforts: ['off', 'low', 'medium', 'xhigh'] };
    assert.deepEqual(effortOptions(gemma), ['off', 'high']);
    assert.deepEqual(effortOptions({ id: 'g', reasoningEfforts: ['off', 'high'], reasoning_efforts: ['none', 'high'] }), ['off', 'high'], 'the admin catalog’s reasoningEfforts');
    assert.deepEqual(effortOptions(qwen), ['off', 'low', 'medium', 'xhigh']);
    assert.deepEqual(effortOptions({ capabilities: ['chat'] }), ['off']);
    assert.deepEqual(effortOptions(null), ['off', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(clampEffort('low', gemma), 'off');
    assert.equal(clampEffort('medium', gemma), 'high');
    assert.equal(clampEffort('xhigh', qwen), 'xhigh');
    assert.deepEqual(chatModels({ models: [{ id: 'bge-m3', capabilities: ['embeddings'], chat: false }, gemma] }).map((m) => m.id), ['g']);
    assert.deepEqual(usageRows({ aiCalls24h: [{ feature: 'sort', calls: 3, errors: 1, avg_latency_ms: 20 }] }), [{ feature: 'sort', calls: 3, errors: 1, tokens: null, fallbacks: null, escalations: null, avgMs: 20 }]);
    const summed = usageRows({ features: [
      { feature: 'sort', tier: 'reflex', calls: 30, errors: 1, fellBack: 0, escalated: 3, tokens: 100, avgLatencyMs: 100 },
      { feature: 'sort', tier: 'reasoning', calls: 10, errors: 0, fellBack: 2, escalated: 0, tokens: 50, avgLatencyMs: 500 },
      { feature: 'ask', tier: 'reasoning', calls: 2, tokensIn: 10, tokensOut: 5 },
    ] });
    assert.deepEqual(summed[0], { feature: 'sort', calls: 40, errors: 1, tokens: 150, fallbacks: 2, escalations: 3, avgMs: 200 });
    assert.equal(summed[1].tokens, 15);
    assert.deepEqual(usageRows(null), []);
    assert.equal(tierChoiceLabel('auto', 'reflex'), 'Auto: Tier 1 Reflex (fast)');
    assert.equal(tierChoiceLabel('reasoning', 'reflex'), 'Tier 2 Reasoning (long)');
    assert.match(servingLine({ model: 'q', active: 'g', degraded: true, reason: 'timeout' }), /Not answering \(timeout\); g is standing in\./);
    assert.match(servingLine({ model: 'q', active: 'q', degraded: true }), /no lighter model is set/);
    assert.equal(servingLine({ model: 'g', active: 'g', degraded: false, latencyMs: 1900 }), 'Serving now: g · 1.9 s');
  });

  test('the tiers are named as the PRD names them; a model is picked from the catalog through PUT /admin/runtime with its effort clamped', async () => {
    await render(h(RoutingSettings, {}));
    await settle(80);
    const rows = all('[data-tier-row]');
    assert.deepEqual(rows.map((r) => r.querySelector('span').textContent), ['Tier 1 Reflex (fast)', 'Tier 2 Reasoning (long)', 'Agent (tool calling)']);
    const pick = byLabel('Model for Tier 2 Reasoning (long)');
    assert.equal(pick.value, 'Qwen/Qwen3.8-Flash-Next');
    assert.deepEqual(all('option', pick).map((o) => o.value), ['google/gemma-4-12B-it-qat-w4a16-ct', 'Qwen/Qwen3.8-Flash-Next'], 'chat models only');
    const effort = byLabel('Reasoning effort for Tier 2 Reasoning (long)');
    assert.deepEqual(all('option', effort).map((o) => o.value), ['off', 'low', 'medium', 'xhigh']);
    assert.equal(effort.value, 'low');
    assert.match(rows[1].textContent, /Serving now: Qwen\/Qwen3\.8-Flash-Next · 4\.2 s/);
    assert.ok(requests().includes('GET /admin/runtime') && requests().includes('GET /admin/models/catalog'));

    mock.mockRequests({ clear: true });
    await choose(pick, 'google/gemma-4-12B-it-qat-w4a16-ct');
    assert.ok(requests().includes('PUT /admin/runtime'));
    const rt = await mock.mockRequest('GET', '/admin/runtime');
    assert.equal(rt.tiers.reasoning.model, 'google/gemma-4-12B-it-qat-w4a16-ct');
    assert.equal(rt.tiers.reasoning.effort, 'off', 'low is not a Gemma effort: the nearest one is stored');
    assert.deepEqual(all('option', byLabel('Reasoning effort for Tier 2 Reasoning (long)')).map((o) => o.value), ['off', 'high']);

    await choose(byLabel('Reasoning effort for Tier 1 Reflex (fast)'), 'high');
    assert.equal((await mock.mockRequest('GET', '/admin/runtime')).tiers.reflex.effort, 'high');
  });

  test('the server’s validation notes and errors show; Test the models probes every tier', async () => {
    await render(h(RoutingSettings, {}));
    await settle(80);
    // An effort the model does not accept is stored, and the note says what it gets instead.
    await React.act(async () => {
      const sel = byLabel('Reasoning effort for Tier 1 Reflex (fast)');
      const opt = document.createElement('option'); opt.value = 'low'; sel.appendChild(opt);
    });
    await choose(byLabel('Reasoning effort for Tier 1 Reflex (fast)'), 'low');
    assert.match(document.querySelector('[data-runtime-notes]').textContent, /accepts none\/high; low is sent as none/);
    // A model the catalog lacks is refused (400) and the message shows.
    await React.act(async () => {
      const sel = byLabel('Model for Tier 1 Reflex (fast)');
      const opt = document.createElement('option'); opt.value = 'ghost/model'; sel.appendChild(opt);
    });
    await choose(byLabel('Model for Tier 1 Reflex (fast)'), 'ghost/model');
    assert.match(text(), /ghost\/model is not in the gateway catalog/);

    mock.mockSetDegraded(true);
    mock.mockRequests({ clear: true });
    await click(byText('button', 'Test the models'));
    assert.ok(requests().includes('POST /admin/tiers/probe'));
    const rows = all('[data-tier-row]');
    assert.match(rows[0].textContent, /Answered in 1900 ms/);
    assert.match(rows[1].textContent, /No answer: no response within 10000 ms/);
    assert.match(rows[1].textContent, /Not answering \(no response within 45000 ms\); google\/gemma-4-12B-it-qat-w4a16-ct is standing in\./);
    assert.equal(document.querySelector('[data-runtime-notice]').textContent, 'Tier 2 is slow; using the lighter model');
  });

  test('the routing table changes a feature\'s tier, escalation and budget; usage per feature, summed over tiers, shows beside it', async () => {
    await render(h(RoutingSettings, {}));
    await settle(80);
    const sort = document.querySelector('[data-feature="sort"]');
    assert.match(sort.textContent, /412 calls/);
    assert.match(sort.textContent, /3 failed/);
    mock.mockRequests({ clear: true });
    await choose(byLabel('Tier for sort'), 'reasoning');
    assert.ok(requests().includes('PUT /admin/routing'));
    const table = await mock.mockRequest('GET', '/admin/routing');
    assert.equal(table.features.find((f) => f.feature === 'sort').override, 'reasoning');
    const budget = byLabel('Daily token budget per person for work');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(budget, '500000');
      budget.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
    });
    await settle(40);
    assert.equal((await mock.mockRequest('GET', '/admin/routing')).features.find((f) => f.feature === 'work').budget, 500000);
    assert.match(text(), /Model calls in the last 7 days/);
    assert.match(text(), /2\.6% escalated to Tier 2/);
    const ask = document.querySelector('[data-usage-row="ask"]');
    assert.match(ask.textContent, /43%/, 'lighter-model share: 3 of 7');
  });

  test('without /admin/usage the last 24 hours from /admin/health stand in', async () => {
    mock.mockNoUsage();
    await render(h(RoutingSettings, {}));
    await settle(100);
    assert.match(text(), /Model calls in the last 24 hours/);
    assert.match(document.querySelector('[data-feature="sort"]').textContent, /412 calls/);
  });

  test('the models people may pick are ticked on and off through PUT /admin/runtime', async () => {
    await render(h(RoutingSettings, {}));
    await settle(80);
    const box = all('input[type="checkbox"]').find((b) => b.closest('label').textContent.includes('Qwen 3.8 Flash Next'));
    await click(box);
    assert.deepEqual((await mock.mockRequest('GET', '/admin/runtime')).enabledModels, ['Qwen/Qwen3.8-Flash-Next']);
  });

  test('not an admin: says who sets it, no controls', async () => {
    useStore.getState().setUser?.({ id: 'u2', isAdmin: false });
    try {
      await render(h(RoutingSettings, {}));
      assert.match(text(), /set by an administrator/);
      assert.equal(document.querySelector('select'), null);
    } finally {
      useStore.getState().setUser?.({ id: 'u1', isAdmin: true });
    }
  });
});

// ── why door, Brief, coverage ─────────────────────────────────────────────
describe('why door: Waiting for Reflex and the Power signals', () => {
  test('powerSignals names alwaysIn and listRule and keeps weights', () => {
    const rows = powerSignals({ signals: [{ name: 'alwaysIn', label: 'You have written to them', weight: 0.5 }, { name: 'listRule', label: 'A mailing list: Reading', weight: 0.9 }, 'plain', { name: 'x' }] });
    assert.deepEqual(rows.map((r) => [r.label, r.text, r.weight]), [['Always in', 'You have written to them', 0.5], ['List rule', 'A mailing list: Reading', 0.9], [null, 'plain', null], ['x', 'x', null]]);
  });

  test('a first guess says it waits for Reflex; Power shows the named signals and the engine version', async () => {
    const item = (await mock.mockRequest('GET', '/sort/stream/people?limit=100')).items.find((i) => i.messageId === 'm-kaur');
    await render(h(WhyDoor, { item, anchor: null, onClose: () => {} }));
    await settle(40);
    assert.match(document.querySelector('[data-pending="reflex"]').textContent, /Waiting for Reflex/);
    assert.equal(document.querySelector('[data-power-signals]'), null, 'Simple: plain signals');
    assert.match(text(), /You have written to them/);
    await cleanup();
    useV2.setState((st) => ({ prefs: { ...st.prefs, powerMode: true } }));
    await render(h(WhyDoor, { item, anchor: null, onClose: () => {} }));
    await settle(40);
    const power = document.querySelector('[data-power-signals]');
    assert.match(power.textContent, /Always in/);
    assert.match(power.textContent, /0\.50/);
    assert.match(text(), /engine 2026-09-24\.2/);
  });
});

describe('Brief: where the prose came from, undo any of it, coverage', () => {
  test('proseNote says when the template stood in, and why', () => {
    assert.equal(proseNote({ source: 'template', fallback: true, reason: 'tier2_degraded' }, healthyStatus()), 'Written from a template: Tier 2 was not answering.');
    assert.equal(proseNote({ source: 'template', fallback: true, reason: 'something_new' }, healthyStatus()), 'Written from a template today.');
    assert.equal(proseNote({ source: 'model', fallback: false, model: 'Qwen/Qwen3.8-Flash-Next' }, healthyStatus()), null);
    assert.equal(proseNote({ source: 'model', fallback: false, model: 'google/gemma-4-12B-it-qat-w4a16-ct' }, healthyStatus()), 'Written by the lighter model');
    assert.equal(proseNote(null, healthyStatus()), null);
  });

  test('today’s entries can each be undone from the Brief; coverage shows while the index fills', async () => {
    await render(h(Brief, {}));
    await settle(60);
    assert.match(text(), /Written from a template: Tier 2 was not answering\./);
    assert.match(text(), /Hedwig has read 62% of your mail so far\./);
    const entries = all('[data-undo-entry]');
    assert.equal(entries.length, 3);
    const first = entries.find((e) => e.textContent.includes('Screened Nordlys Travel into Records'));
    mock.mockRequests({ clear: true });
    await click(byText('button', 'Undo', first));
    await settle(400);
    assert.ok(requests().includes('POST /sort/undo'));
    assert.ok(!all('[data-undo-entry]').some((e) => e.textContent.includes('Screened Nordlys Travel')));
  });

  test('the ledgers say how much of the mail their figures come from', async () => {
    await render(h(Ledger, { props: { kind: 'purchases' } }));
    await settle(60);
    assert.match(document.querySelector('[data-coverage]').textContent, /62% of your mail so far; these figures come from that part/);
  });
});

after(async () => { await cleanup(); dom.window.close(); });
