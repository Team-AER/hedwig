// Render test for Settings → Accounts → Add account (AddAccount.jsx): the provider list, the
// sign-in window opening on the click, the admin setup card, the app-password form, and Other
// finding the provider from the address. Same sucrase/jsdom harness as
// components/AccountForm.render.test.js. Run with
//   node --test --test-concurrency=1 src/hedwig/accounts/AddAccount.render.test.js
// Assertions on DOM nodes stay boolean (assert.ok(el)): a failing deepEqual on a jsdom node walks
// the whole tree.

import { test, describe, before, after, beforeEach } from 'node:test';
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
      if (code.includes('import.meta.env')) {
        return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
      }
    }
    return nextLoad(url, context);
  },
});

const ORIGIN = 'https://mail.example.invalid';
const dom = new JSDOM('<div id="root"></div>', { url: ORIGIN, pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// Server answers; each test sets them before mounting.
let status = { google: { configured: false }, microsoft: { configured: false } };
let discovered = { provider: null };
const requests = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  const method = opts.method || 'GET';
  requests.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });
  let body = {};
  if (path.endsWith('/integrations/status')) body = status;
  else if (path.startsWith('/api/hedwig/accounts/discover')) body = discovered;
  else if (method === 'POST' && path === '/api/accounts') body = { id: 'acc-new', ...JSON.parse(opts.body) };
  else if (method === 'GET' && path === '/api/accounts') body = [];
  else if (method === 'POST' && path.startsWith('/api/integrations/')) body = { ok: true };
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

// The sign-in window: record what would open.
const opened = [];
dom.window.open = (url) => { opened.push(url); return { focus() {} }; };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { default: AddAccount } = await import('./AddAccount.jsx');

let root;
let added;
const container = () => document.getElementById('root');
const text = () => container().textContent;
const button = (label) => [...container().querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const tile = (id) => container().querySelector(`button[data-provider="${id}"]`);
const flush = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = async (el) => { await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await flush(); };
async function type(el, value) {
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

function ManualForm({ initial }) {
  return React.createElement('div', { 'data-testid': 'manual-form' }, `manual:${initial.email_address}:${initial.imap_host}`);
}

async function mount({ isAdmin = false } = {}) {
  useStore.setState({ user: { id: 'u1', isAdmin }, accounts: [] });
  await React.act(async () => {
    root.render(React.createElement(AddAccount, {
      ManualForm,
      onSaveManual: async () => {},
      onAdded: (account) => { added = account ?? 'oauth'; },
      onClose: () => {},
    }));
  });
  await flush();
}

before(() => { root = createRoot(container()); });
beforeEach(async () => {
  await React.act(async () => root.unmount());
  root = createRoot(container());
  status = { google: { configured: false }, microsoft: { configured: false } };
  discovered = { provider: null };
  requests.length = 0;
  opened.length = 0;
  added = undefined;
});
after(async () => { await React.act(async () => root.unmount()); });

describe('Add account', () => {
  test('lists Google, Microsoft, Yahoo, iCloud and Other', async () => {
    await mount();
    const ids = [...container().querySelectorAll('button[data-provider]')].map((b) => b.dataset.provider);
    assert.deepEqual(ids, ['google', 'microsoft', 'yahoo', 'icloud', 'other']);
    assert.ok(text().includes('Gmail and Google Workspace'));
  });

  test('a configured provider opens its sign-in window on the first click, and the result closes the screen', async () => {
    status = { google: { configured: true }, microsoft: { configured: false } };
    await mount();
    await click(tile('google'));
    assert.deepEqual(opened, ['/oauth/google?popup=1']);
    assert.ok(text().includes('Signing in with Google'), 'waiting state shown');

    // The sign-in window reports over BroadcastChannel (its opener may be cut).
    const channel = new BroadcastChannel('hedwig-oauth');
    channel.postMessage({ type: 'oauth_success', provider: 'google', id: 'r1' });
    channel.close();
    await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    assert.equal(added, 'oauth');
    assert.ok(requests.some((r) => r.method === 'GET' && r.path === '/api/accounts'), 'account list refreshed');
  });

  test('a failed sign-in shows the reason and offers to try again', async () => {
    status = { google: { configured: false }, microsoft: { configured: true } };
    await mount();
    await click(tile('microsoft'));
    await React.act(async () => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'oauth_error', error: 'AADSTS65001: consent required' }, origin: ORIGIN }));
    });
    assert.ok(text().includes('AADSTS65001: consent required'));
    assert.ok(button('Try again'), 'try again shown');
    assert.equal(added, undefined);
  });

  test('an admin gets the one-time setup card for an unconfigured provider, with the redirect URI', async () => {
    await mount({ isAdmin: true });
    await click(tile('google'));
    assert.equal(opened.length, 0, 'no window for an unconfigured provider');
    assert.ok(text().includes('Turn on Google sign-in'));
    const uri = [...container().querySelectorAll('input')].some((i) => i.value === `${ORIGIN}/oauth/google/callback`);
    assert.ok(uri, 'redirect URI shown');

    const [, clientId, secret] = container().querySelectorAll('input');
    await type(clientId, 'g-id.apps.googleusercontent.com');
    await type(secret, 'g-secret');
    status = { google: { configured: true }, microsoft: { configured: false } };
    await click(button('Save'));
    const save = requests.find((r) => r.method === 'POST' && r.path === '/api/integrations/google');
    assert.ok(save, 'saved through the Integrations API');
    assert.equal(save.body.clientId, 'g-id.apps.googleusercontent.com');
    assert.ok(button('Continue with Google'), 'sign-in offered once saved');
  });

  test('someone else is told to ask the admin, and Gmail falls back to an app password', async () => {
    await mount({ isAdmin: false });
    await click(tile('google'));
    assert.ok(text().includes('Ask your Hedwig admin'));
    await click(button('Use a Gmail app password instead'));
    assert.ok(text().includes('Add your Google account'));
  });

  test('Yahoo adds the account with an app password on Yahoo servers', async () => {
    await mount();
    await click(tile('yahoo'));
    const [email, password] = container().querySelectorAll('input');
    await type(email, 'ana@yahoo.com');
    await type(password, 'abcd efgh ijkl mnop');
    await click(button('Add account'));
    const post = requests.filter((r) => r.method === 'POST' && r.path === '/api/accounts');
    assert.equal(post.length, 1, 'one add, not two');
    assert.equal(post[0].body.imap_host, 'imap.mail.yahoo.com');
    assert.equal(post[0].body.auth_user, 'ana@yahoo.com');
    assert.equal(post[0].body.auth_pass, 'abcdefghijklmnop', 'spaces removed');
    assert.equal(added?.id, 'acc-new');
  });

  test('Other finds a Microsoft 365 domain and offers sign-in with the address', async () => {
    status = { google: { configured: false }, microsoft: { configured: true } };
    discovered = { domain: 'contoso.example', provider: 'microsoft', source: 'mx' };
    await mount();
    await click(tile('other'));
    await type(container().querySelector('input'), 'ana@contoso.example');
    await click(button('Continue'));
    assert.ok(requests.some((r) => r.path === '/api/hedwig/accounts/discover?email=ana%40contoso.example'));
    assert.equal(opened.length, 0, 'waits for its own click after the lookup');
    await click(button('Continue with Microsoft'));
    assert.deepEqual(opened, ['/oauth/microsoft?popup=1&login_hint=ana%40contoso.example']);
  });

  test('Other falls back to the IMAP form for an unknown host', async () => {
    discovered = { domain: 'example.org', provider: null, source: null };
    await mount();
    await click(tile('other'));
    await type(container().querySelector('input'), 'ana@example.org');
    await click(button('Continue'));
    assert.ok(text().includes('manual:ana@example.org:'), 'IMAP form with the address');
  });
});
