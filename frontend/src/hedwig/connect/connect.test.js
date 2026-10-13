// The /connect page a connector (Claude, ChatGPT…) sends the person to, and the request id that
// survives signing in. Same sucrase/jsdom harness as components/AccountForm.render.test.js.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

// jsdom cannot leave the page; record where the page tried to go.
const navigations = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => { if (/navigation/i.test(err.message)) navigations.push(err); });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://hedwig.example.invalid/connect', pretendToBeVisual: true, virtualConsole });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const ID = '0f6b2c4e-8a1d-4c3b-9e7f-1234567890ab';
let described;
let connections;
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
  const reply = (status, body) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
  if (path === `/api/hedwig/mcp/requests/${ID}`) return described ? reply(200, described) : reply(404, { error: 'expired' });
  if (path.endsWith('/approve')) return reply(200, { redirect: 'https://claude.ai/api/mcp/auth_callback?code=hwk_x&state=s' });
  if (path.endsWith('/deny')) return reply(200, { redirect: 'https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s' });
  if (path === '/api/hedwig/mcp/connections') return reply(200, connections);
  if (path.startsWith('/api/hedwig/mcp/connections/')) return reply(200, { ok: true });
  return reply(200, {});
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const { default: ConnectPage } = await import('./ConnectPage.jsx');
const { useStore } = await import('../../store/index.js');
const pending = await import('./pending.js');
const { default: ConnectorSettings } = await import('../views/settings/ConnectorSettings.jsx');

let root;
const container = () => document.getElementById('root');
const text = () => container().textContent;
const button = (label) => [...container().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const settle = () => React.act(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); });

async function mount(path = `/connect?request=${ID}`, Component = ConnectPage) {
  await React.act(async () => {
    root.render(React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component)));
  });
  await settle();
}
async function click(el) {
  await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  await settle();
}

before(() => {
  root = createRoot(container());
  useStore.setState({ user: { id: 'u1', username: 'demo', email: 'me@example.com' } });
});
beforeEach(async () => {
  await React.act(async () => root.unmount());
  root = createRoot(container());
  calls.length = 0;
  navigations.length = 0;
  sessionStorage.clear();
  described = { id: ID, client: { name: 'Claude', uri: null }, redirectHost: 'claude.ai', scopes: ['mail.read', 'mail.write'] };
});

describe('pending connect request', () => {
  test('reads the id only from /connect, and keeps a valid one across sign-in', () => {
    assert.equal(pending.requestFromUrl('/connect', `?request=${ID}`), ID);
    assert.equal(pending.requestFromUrl('/', `?request=${ID}`), null);
    assert.equal(pending.requestFromUrl('/connect', '?request=../../evil'), null);
    pending.rememberRequest(sessionStorage, ID);
    assert.equal(pending.pendingRequest(sessionStorage), ID);
    assert.equal(pending.connectPath(ID), `/connect?request=${ID}`);
    pending.forgetRequest(sessionStorage);
    assert.equal(pending.pendingRequest(sessionStorage), null);
    sessionStorage.setItem('hedwig_connect_request', 'javascript:alert(1)');
    assert.equal(pending.pendingRequest(sessionStorage), null);
  });
});

describe('ConnectPage', () => {
  test('says who is asking, where the person goes back to, and what the app may do', async () => {
    await mount();
    assert.match(text(), /Connect Claude to Hedwig/);
    assert.match(text(), /You will go back to claude\.ai afterwards/);
    assert.match(text(), /Search and read your mail in every account/);
    assert.match(text(), /It can never send or delete mail/);
    assert.match(text(), /Signed in as me@example\.com/);
    assert.equal(container().querySelector('input[type=checkbox]').checked, true);
  });

  test('allows read-only when the person unticks organising, then goes back to the app', async () => {
    await mount();
    await click(container().querySelector('input[type=checkbox]'));
    await click(button('Allow'));
    const approve = calls.find((c) => c.path.endsWith('/approve'));
    assert.deepEqual(approve.body, { write: false });
    assert.equal(approve.method, 'POST');
    assert.match(text(), /Connected/);
    assert.match(text(), /Taking you back to claude\.ai/);
    assert.equal(navigations.length, 1);
  });

  test('allows organising by default', async () => {
    await mount();
    await click(button('Allow'));
    assert.deepEqual(calls.find((c) => c.path.endsWith('/approve')).body, { write: true });
  });

  test('offers no organising to an app that asked to read only', async () => {
    described = { ...described, scopes: ['mail.read'] };
    await mount();
    assert.equal(container().querySelector('input[type=checkbox]'), null);
    assert.match(text(), /asked to read only/);
    await click(button('Allow'));
    assert.deepEqual(calls.find((c) => c.path.endsWith('/approve')).body, { write: false });
  });

  test('cancelling declines and goes back', async () => {
    await mount();
    await click(button('Cancel'));
    assert.ok(calls.some((c) => c.path.endsWith('/deny') && c.method === 'POST'));
    assert.ok(!calls.some((c) => c.path.endsWith('/approve')));
    assert.match(text(), /Not connected/);
  });

  test('explains an expired or used request', async () => {
    described = null;
    await mount();
    assert.match(text(), /This link has expired/);
    assert.equal(button('Allow'), undefined);
  });

  test('finds the request remembered before sign-in, and forgets it', async () => {
    pending.rememberRequest(sessionStorage, ID);
    await mount('/connect');
    assert.match(text(), /Connect Claude to Hedwig/);
    assert.equal(pending.pendingRequest(sessionStorage), null);
  });
});

describe('Settings → Connectors', () => {
  const GRANT = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
  beforeEach(() => {
    connections = {
      endpoint: 'https://hedwig.example.invalid/mcp',
      connections: [{ id: GRANT, name: 'Claude', host: 'claude.ai', scopes: ['mail.read', 'mail.write'], calls: 14, connectedAt: '2026-10-10T09:00:00Z', lastUsedAt: '2026-10-13T08:00:00Z' }],
      activity: [{ id: 1, app: 'Claude', tool: 'archive_message', summary: 'Archive “Invoice” from Ana', ok: true, at: '2026-10-13T08:00:00Z' }],
    };
  });

  test('shows the URL to add, the connected app and what it changed', async () => {
    await mount('/', ConnectorSettings);
    assert.equal(container().querySelector('input[readonly]').value, 'https://hedwig.example.invalid/mcp');
    assert.match(text(), /claude mcp add --transport http hedwig https:\/\/hedwig\.example\.invalid\/mcp/);
    assert.match(text(), /Reads and organises/);
    assert.match(text(), /14 requests/);
    assert.match(text(), /Archive “Invoice” from Ana/);
  });

  test('disconnects only on the second click', async () => {
    await mount('/', ConnectorSettings);
    await click(button('Disconnect'));
    assert.ok(!calls.some((c) => c.method === 'DELETE'));
    await click(button('Disconnect now?'));
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === `/api/hedwig/mcp/connections/${GRANT}`));
    assert.match(text(), /No apps connected yet/);
  });
});
