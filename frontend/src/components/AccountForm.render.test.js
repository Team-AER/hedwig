// Render test for the Settings → Accounts → Add account form: the Outlook / Microsoft 365 and
// Exchange presets, and whether Outlook offers Microsoft sign-in or explains that the admin has
// to configure it. The decision itself is unit-tested in utils/accountPresets.test.js; this
// proves the form actually shows it. Same sucrase/jsdom harness as MessagePane.render.test.js.

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

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// What GET /api/integrations/status answers; each test sets it before mounting.
let microsoftConfigured = false;
globalThis.fetch = async (url) => {
  const path = String(url);
  const body = path.endsWith('/integrations/status')
    ? { microsoft: { configured: microsoftConfigured }, google: { configured: false } }
    : path.endsWith('/admin/settings')
      ? { settings: { allow_insecure_tls: 'false' } }
      : {};
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { AccountForm } = await import('./AdminPanel.jsx');

let root;
const container = () => document.getElementById('root');
const text = () => container().textContent;
const buttonWithText = (label) => [...container().querySelectorAll('button')].find(b => b.textContent.trim() === label);
const inputWithPlaceholder = (ph) => [...container().querySelectorAll('input')].filter(i => i.getAttribute('placeholder') === ph);

async function mountForm() {
  await React.act(async () => {
    root.render(React.createElement(AccountForm, { onSave: async () => {}, onCancel: () => {} }));
  });
  // Let the integrations/settings fetches resolve and re-render.
  await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

async function choose(presetKey) {
  const button = buttonWithText(`admin.accounts.${presetKey}`);
  assert.ok(button, `${presetKey} button is rendered`);
  await React.act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
}

before(() => { root = createRoot(container()); });
beforeEach(async () => {
  await React.act(async () => root.unmount());
  root = createRoot(container());
});
after(async () => { await React.act(async () => root.unmount()); });

describe('Add account presets', () => {
  test('lists Gmail, Outlook / Microsoft 365, Yahoo, iCloud, Exchange, Custom in order', async () => {
    await mountForm();
    const labels = [...container().querySelectorAll('button')]
      .map(b => b.textContent.trim())
      .filter(l => l.startsWith('admin.accounts.preset'));
    assert.deepEqual(labels, [
      'admin.accounts.presetGmail', 'admin.accounts.presetOutlook', 'admin.accounts.presetYahoo',
      'admin.accounts.presetIcloud', 'admin.accounts.presetExchange', 'admin.accounts.presetCustom',
    ]);
  });

  test('Outlook shows "Sign in with Microsoft" and hides the password when Microsoft OAuth is configured', async () => {
    microsoftConfigured = true;
    await mountForm();
    await choose('presetOutlook');
    assert.ok(buttonWithText('admin.accounts.signInMicrosoft'), 'sign-in button shown');
    assert.ok(text().includes('admin.accounts.signInMicrosoftNote'));
    assert.equal(container().querySelector('input[type="password"]'), null, 'no password field');
    assert.ok(!text().includes('admin.accounts.outlookPasswordNote'));
  });

  test('Outlook keeps the password field with the admin note when Microsoft OAuth is not configured', async () => {
    microsoftConfigured = false;
    await mountForm();
    await choose('presetOutlook');
    assert.equal(buttonWithText('admin.accounts.signInMicrosoft'), undefined, 'no sign-in button');
    assert.ok(text().includes('admin.accounts.outlookPasswordNote'), 'explains that the admin must configure sign-in');
    assert.ok(container().querySelector('input[type="password"]'), 'password field still shown');
    const hosts = [...container().querySelectorAll('input')].map(i => i.value);
    assert.ok(hosts.includes('outlook.office365.com'), 'IMAP host filled in');
    assert.ok(hosts.includes('smtp.office365.com'), 'SMTP host filled in');
  });

  test('Exchange leaves the hosts empty with mail.example.com placeholders and the admin note', async () => {
    microsoftConfigured = true;
    await mountForm();
    await choose('presetGmail');
    await choose('presetExchange');
    const hostInputs = inputWithPlaceholder('admin.accounts.exchangeHostPh');
    assert.equal(hostInputs.length, 2, 'IMAP and SMTP host inputs use the Exchange placeholder');
    assert.ok(hostInputs.every(i => i.value === ''), 'hosts cleared');
    assert.ok(text().includes('admin.accounts.exchangeNote'));
    assert.ok(container().querySelector('input[type="password"]'), 'password auth');
    assert.equal(buttonWithText('admin.accounts.signInMicrosoft'), undefined, 'no Microsoft sign-in for on-premises');
  });
});
