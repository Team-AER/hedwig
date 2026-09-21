// Render test for the conversation pane.
//
// The behavior that matters, and that a util test cannot show, is that a thread renders one
// card per message with only the newest open, and that opening another card mounts a second
// body. That is the whole point of the Gmail-style view: bodies are expensive, so only what
// the reader has opened is rendered.
//
// Same loader hooks as MessagePane.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed because a real i18n instance would test i18next.

import { test, describe, before, after } from 'node:test';
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const THREAD = [
  { id: 'm1', account_id: 'acct', folder: 'INBOX', message_id: '<1@x>', subject: 'Welcome', from_email: 'a@x.z', from_name: 'Ana', date: '2026-01-01T10:00:00Z', is_read: true, snippet: 'first' },
  { id: 'm2', account_id: 'acct', folder: '[Gmail]/Sent Mail', message_id: '<2@x>', subject: 'Re: Welcome', from_email: 'me@x.z', from_name: 'Me', date: '2026-01-02T10:00:00Z', is_read: true, snippet: 'my reply' },
  { id: 'm3', account_id: 'acct', folder: 'INBOX', message_id: '<3@x>', subject: 'Re: Welcome', from_email: 'a@x.z', from_name: 'Ana', date: '2026-01-03T10:00:00Z', is_read: false, snippet: 'newest' },
];
const bodyRequests = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/mail/thread/')) return { ok: true, status: 200, json: async () => ({ messages: THREAD }) };
  const id = /\/messages\/([^/]+)\/body/.exec(u)?.[1];
  if (id) { bodyRequests.push(id); return { ok: true, status: 200, json: async () => ({ html: `<p>body of ${id}</p>`, text: '', attachments: [] }) }; }
  return { ok: true, status: 200, json: async () => ({}) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const ConversationPane = (await import('./ConversationPane.jsx')).default;

let root;
before(() => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });

const cards = () => document.querySelectorAll('[aria-expanded]');
const openCards = () => document.querySelectorAll('[aria-expanded="true"]');

describe('conversation pane', () => {
  test('renders one card per message with only the newest open', async () => {
    await React.act(async () => {
      root.render(React.createElement(ConversationPane, { threadId: '<1@x>', folder: 'INBOX' }));
    });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    assert.equal(cards().length, 3, 'every message in the thread gets a card');
    assert.equal(openCards().length, 1, 'only one card opens, so only one body is rendered');
    // Sent replies belong in the conversation, which is why the thread endpoint crosses folders.
    assert.match(document.getElementById('root').innerHTML, /Me/, 'the sent reply appears in the thread');
  });

  test('only the opened message fetches a body', async () => {
    // A collapsed card must cost nothing: no request, no frame, no document.
    assert.deepEqual(bodyRequests, ['m3'], 'exactly the newest message was fetched');
  });

  test('opening another card renders a second body', async () => {
    const collapsed = document.querySelector('[aria-expanded="false"]');
    await React.act(async () => { collapsed.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });

    assert.equal(openCards().length, 2, 'two messages can be open at once');
    assert.equal(bodyRequests.length, 2, 'the newly opened message fetched its own body');
  });

  test('collapsing and reopening does not refetch', async () => {
    const before = bodyRequests.length;
    const open = document.querySelector('[aria-expanded="true"]');
    await React.act(async () => { open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await React.act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.equal(bodyRequests.length, before, 'a body already loaded is kept');
  });
});
