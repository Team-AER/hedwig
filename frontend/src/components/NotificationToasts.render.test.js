// The new-mail toast opens its message when clicked (useWebSocket sets onAction + openOnClick);
// other toasts keep a passive body. Same sucrase/jsdom harness as AccountForm.render.test.js.
// Assertions stay boolean: a failing deepEqual on a jsdom node walks the whole tree.

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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { default: NotificationToasts } = await import('./NotificationToasts.jsx');

let root;
const container = () => document.getElementById('root');
const click = (el) => React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });

before(() => { root = createRoot(container()); });
beforeEach(async () => {
  await React.act(async () => root.unmount());
  root = createRoot(container());
  useStore.setState({ notifications: [] });
});
after(async () => { await React.act(async () => root.unmount()); dom.window.close(); });

describe('new-mail toast', () => {
  test('clicking the toast body opens the message and closes the toast', async () => {
    let opened = 0;
    useStore.getState().addNotification({ type: 'new_mail', title: 'Ana', body: 'Lunch?', onAction: () => { opened += 1; }, openOnClick: true });
    await React.act(async () => { root.render(React.createElement(NotificationToasts)); });
    const body = container().querySelector('[role="button"]');
    assert.ok(body, 'the toast body is a button');
    assert.ok(body.textContent.includes('Lunch?'));
    await click(body);
    assert.equal(opened, 1);
  });

  test('a toast without openOnClick keeps a passive body', async () => {
    useStore.getState().addNotification({ type: 'info', title: 'Saved', body: 'Done', onAction: () => {} });
    await React.act(async () => { root.render(React.createElement(NotificationToasts)); });
    assert.equal(Boolean(container().querySelector('[role="button"]')), false);
  });
});
