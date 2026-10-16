// Exercise the real App routes and BrowserRouter across dependency upgrades.
// Leaf screens and API responses are isolated so navigation never contacts a server.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://hedwig.example.invalid/' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true,
});
const user = { id: 'user-1' };
let state;
const setUser = (next) => { state.user = next; };
const setLocked = (next) => { state.isLocked = next; };
const loadPreferences = async () => {};
globalThis.__routingTestStore = () => ({ ...state, setUser, setLocked, loadPreferences });
globalThis.__routingTestMe = async () => {
  if (!state.user) throw new Error('not signed in');
  return { user: { ...state.user, locked: state.isLocked } };
};

registerHooks({
  load(url, context, nextLoad) {
    const modules = {
      '/store/index.js': 'export const useStore = () => globalThis.__routingTestStore();',
      '/utils/api.js': 'export const api = { me: () => globalThis.__routingTestMe() };',
      '/themes.js': 'export const applyTheme = () => {}; export const getInitialTheme = () => "default";',
      '/fonts.js': 'export const applyFontSet = () => {}; export const effectiveFontSet = () => "default";',
      '/layouts.js': 'export const applyLayout = () => {};',
      '/hedwig/v2/i18n.js': 'export const tv = (_, fallback) => fallback;',
    };
    for (const [suffix, source] of Object.entries(modules)) {
      if (url.endsWith(suffix)) return { format: 'module', shortCircuit: true, source };
    }
    for (const [suffix, label] of [
      ['/components/LoginPage.jsx', 'Login'], ['/components/MailApp.jsx', 'Mail'],
      ['/components/LockScreen.jsx', 'Locked'], ['/hedwig/connect/ConnectPage.jsx', 'Connect'],
    ]) {
      if (url.endsWith(suffix)) return {
        format: 'module', shortCircuit: true,
        source: `export default function Screen() { return ${JSON.stringify(label)}; }`,
      };
    }
    if (url.endsWith('/App.jsx')) return {
      format: 'module', shortCircuit: true,
      source: transform(readFileSync(new URL(url), 'utf8'), {
        transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url,
      }).code,
    };
    return nextLoad(url, context);
  },
});
const { default: App } = await import('./App.jsx');
let root;
afterEach(async () => {
  if (root) await React.act(async () => root.unmount());
  root = undefined;
});
async function mount(path, signedIn = false, locked = false) {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', path);
  state = { user: signedIn ? user : null, isLocked: locked };
  root = createRoot(document.getElementById('root'));
  await React.act(async () => {
    root.render(React.createElement(BrowserRouter, { window }, React.createElement(App)));
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
for (const path of ['/login', '/register', '/mail/thread-1', '/connect']) {
  test(`anonymous ${path} reaches login`, async () => {
    await mount(path);
    assert.equal(document.getElementById('root').textContent, 'Login');
    assert.equal(window.location.pathname, path === '/register' ? '/register' : '/login');
  });
}
for (const path of ['/login', '/register']) {
  test(`signed-in ${path} redirects to mail`, async () => {
    await mount(path, true);
    assert.equal(document.getElementById('root').textContent, 'Mail');
    assert.equal(window.location.pathname, '/');
  });
}
test('signed-in deep link stays on its mail path', async () => {
  await mount('/mail/thread-1?m=message-1', true);
  assert.equal(document.getElementById('root').textContent, 'Mail');
  assert.equal(window.location.pathname + window.location.search, '/mail/thread-1?m=message-1');
});
test('anonymous message deep link is remembered through login', async () => {
  await mount('/mail/thread-1?m=message-1');
  assert.equal(window.location.pathname, '/login');
  assert.equal(sessionStorage.getItem('mailflow_deep_link_id'), 'message-1');
});
test('signed-in connector query is preserved', async () => {
  await mount('/connect?request=0f6b2c4e-8a1d-4c3b-9e7f-1234567890ab', true);
  assert.equal(document.getElementById('root').textContent, 'Connect');
  assert.equal(window.location.search, '?request=0f6b2c4e-8a1d-4c3b-9e7f-1234567890ab');
});
for (const path of ['/mail/thread-1', '/connect']) {
  test(`locked ${path} stays behind the lock screen`, async () => {
    await mount(path, true, true);
    assert.equal(document.getElementById('root').textContent, 'Locked');
    assert.equal(window.location.pathname, path);
  });
}
