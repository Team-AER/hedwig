// Drafts in the v2 shell: finding each account's Drafts folder, the Drafts view (rows, opening a
// draft in the composer, reloading), the rail entry and its count, draft blocks in the thread,
// and the inline reply field's per-thread text. Rendered against the mock (mock.js).
//
// Same harness as components/MessagePane.compose.test.js: JSX through sucrase, a jsdom window,
// react-dom's act(). Run with: node --test src/hedwig/v2/drafts.test.js
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
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'not in this test' }), headers: { get: () => '' } });


const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { useHedwig } = await import('../store.js');
const { setMockMode } = await import('./client.js');
const mock = await import('./mock.js');
const { useV2, UI_DEFAULTS, countText, watchDrafts } = await import('./state.js');
const drafts = await import('./drafts.js');
const Drafts = (await import('./Drafts.jsx')).default;
const Rail = (await import('./Rail.jsx')).default;
const Thread = (await import('./Thread.jsx')).default;
const { v2Views } = await import('./index.js');

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
async function setText(el, value) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
const all = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const byText = (sel, t, scope = document) => all(sel, scope).find((e) => e.textContent.trim() === t);
const byLabel = (label, scope = document) => scope.querySelector(`[aria-label="${label}"]`);
async function cleanup() {
  if (root) await React.act(async () => root.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
}

let composed = [];
beforeEach(async () => {
  await cleanup();
  mock.resetMock();
  mock.mockRequests({ clear: true });
  notifications.length = 0;
  composed = [];
  useStore.setState({ composing: false, composeData: null, openCompose: (d) => { composed.push(d); useStore.setState({ composing: true, composeData: d }); } });
  useV2.getState().reset();
  useV2.setState({ prefs: { ...UI_DEFAULTS }, caps: { work: true } });
  try { localStorage.clear(); } catch { /* none */ }
  drafts.resetReplyDraftCache();
});
after(async () => { await cleanup(); dom.window.close(); });

const MARCUS = 'Draft to Marcus Oduya: Re: Lease renewal: two options';
const leaseItem = { threadId: 't-lease', messageId: 'm-lease-1', subject: 'Lease renewal: two options', from: { name: 'Marcus Oduya', email: 'marcus@oduya-lettings.example' } };

// ── pure helpers ─────────────────────────────────────────────────────────────
describe('drafts: finding them', () => {
  test('loadDrafts resolves each account\'s Drafts folder (mapping first, else \\Drafts) and merges newest first', async () => {
    const asked = [];
    const source = {
      getFolders: async (id) => (id === 'b' ? [{ path: 'INBOX' }, { path: '[Gmail]/Drafts', special_use: '\\Drafts' }] : []),
      getMessages: async ({ accountId, folder }) => {
        asked.push(`${accountId}:${folder}`);
        if (accountId === 'a') return { messages: [{ id: 'a1', uid: 1, date: '2026-09-20T10:00:00Z' }] };
        return { messages: [{ id: 'b1', uid: 9, date: '2026-09-23T10:00:00Z' }] };
      },
    };
    drafts.resetDraftFolderCache();
    const out = await drafts.loadDrafts({
      accounts: [{ id: 'a', folder_mappings: { drafts: 'Entwürfe' } }, { id: 'b' }, { id: 'c', enabled: false }],
      folders: {},
      source,
    });
    assert.deepEqual(asked.sort(), ['a:Entwürfe', 'b:[Gmail]/Drafts']);
    assert.deepEqual(out.items.map((m) => m.id), ['b1', 'a1'], 'newest first across accounts');
    assert.deepEqual(out.items.map((m) => [m.account_id, m.folder]), [['b', '[Gmail]/Drafts'], ['a', 'Entwürfe']], 'each row knows its account and folder');
    assert.deepEqual(out.folders, { a: 'Entwürfe', b: '[Gmail]/Drafts' });
  });

  test('one account failing never hides the others\' drafts', async () => {
    drafts.resetDraftFolderCache();
    const out = await drafts.loadDrafts({
      accounts: [{ id: 'a', folder_mappings: { drafts: 'Drafts' } }, { id: 'b', folder_mappings: { drafts: 'Drafts' } }],
      source: { getFolders: async () => [], getMessages: async ({ accountId }) => { if (accountId === 'a') throw new Error('down'); return [{ id: 'b1' }]; } },
    });
    assert.deepEqual(out.items.map((m) => m.id), ['b1']);
    assert.equal(out.errors.length, 1);
  });

  test('isDraftMessage: the \\Draft flag, or the account\'s Drafts folder', () => {
    const accounts = [{ id: 'a' }];
    assert.equal(drafts.isDraftMessage({ folder: 'INBOX', accountId: 'a', raw: { flags: ['\\Seen', '\\Draft'] } }, { accounts }), true);
    assert.equal(drafts.isDraftMessage({ folder: 'Drafts', accountId: 'a' }, { accounts, draftFolders: { a: 'Drafts' } }), true);
    assert.equal(drafts.isDraftMessage({ folder: 'Brouillons', accountId: 'a' }, { accounts, folders: { a: [{ path: 'Brouillons', special_use: '\\Drafts' }] } }), true);
    assert.equal(drafts.isDraftMessage({ folder: 'INBOX', accountId: 'a' }, { accounts, draftFolders: { a: 'Drafts' } }), false);
    assert.equal(drafts.isDraftMessage({ folder: 'Drafts', accountId: 'other' }, { accounts, draftFolders: { a: 'Drafts' } }), false);
  });

  test('draftRecipient reads upstream\'s address shapes', () => {
    assert.deepEqual(drafts.draftRecipient({ to_addresses: [{ name: 'Anna', address: 'anna@x.org' }] }), { name: 'Anna', email: 'anna@x.org' });
    assert.deepEqual(drafts.draftRecipient({ to_addresses: JSON.stringify([{ email: 'b@x.org' }]) }), { name: '', email: 'b@x.org' });
    assert.equal(drafts.draftRecipient({ to_addresses: [] }), null);
  });
});

// ── the Drafts view ──────────────────────────────────────────────────────────
describe('drafts: the view', () => {
  test('registered as hedwig.drafts with the "Drafts" palette command on g d', async () => {
    assert.ok(v2Views().some((v) => v.id === 'hedwig.drafts'));
    const { registerV2 } = await import('./index.js');
    const { listCommands } = await import('../registry.js');
    registerV2();
    const cmd = listCommands().find((c) => c.id === 'hedwig.v2.drafts');
    assert.ok(cmd, 'the palette has it');
    assert.equal(cmd.title, 'Drafts');
    assert.equal(cmd.keys, 'g d');
  });

  test('rows: the recipient\'s avatar (or "Draft"), the Draft label, the subject or "(no subject)", the snippet and the date; newest first', async () => {
    await render(h(Drafts, {}));
    await settle(60);
    assert.ok(document.querySelector('input[data-list-search]'), 'the list header has the search field');
    assert.equal(document.querySelector('h1').textContent, 'Drafts');
    const rows = all('[data-row-button]');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].getAttribute('aria-label'), MARCUS);
    assert.equal(rows[0].querySelector('[data-avatar]').textContent, 'MO');
    const label = rows[0].querySelector('[data-draft-label]');
    assert.equal(label.textContent, 'Draft');
    assert.equal(label.style.color, 'var(--hw-attention-ink, #A8420F)');
    assert.match(rows[0].textContent, /Hi Marcus, the 12-month renewal works for me/);
    assert.match(rows[0].textContent, /\d\d:\d\d/, 'today\'s draft shows its time');
    assert.equal(rows[1].getAttribute('aria-label'), 'Draft to no recipient yet: (no subject)');
    assert.match(rows[1].textContent, /No recipient/);
    assert.equal(rows[1].querySelector('[data-avatar]').textContent.trim().charAt(0), 'D', 'no recipient: the avatar says Draft');
  });

  test('clicking a row opens the composer with the draft, as upstream\'s Drafts folder does', async () => {
    await render(h(Drafts, {}));
    await settle(60);
    await click(byLabel(MARCUS));
    await settle(30);
    assert.equal(composed.length, 1);
    const p = composed[0];
    assert.equal(p.draftUid, 41);
    assert.equal(p.draftFolder, 'Drafts');
    assert.equal(p.accountId, 'acc-work');
    assert.deepEqual(p.to, ['Marcus Oduya <marcus@oduya-lettings.example>']);
    assert.deepEqual(p.cc, []);
    assert.equal(p.subject, 'Re: Lease renewal: two options');
    assert.equal(p.body, '<p>Hi Marcus, the 12-month renewal works for me. Could we</p>');
    assert.equal(p.bodyIsHtml, true);
  });

  test('the list reloads after the composer closes and on a mail event', async () => {
    await render(h(Drafts, {}));
    await settle(60);
    const loads = () => mock.mockRequests().filter((r) => r.startsWith('GET /mock/messages')).length;
    const before = loads();
    await React.act(async () => { useStore.setState({ composing: true }); });
    await React.act(async () => { useStore.setState({ composing: false }); });
    await settle(420);
    assert.ok(loads() > before, 'closing the composer reloads the drafts');
    const mid = loads();
    await React.act(async () => { window.dispatchEvent(new CustomEvent('mailflow:refresh')); });
    await settle(420);
    assert.ok(loads() > mid, 'a mail WebSocket event reloads them');
  });

  test('watchers share one set of listeners and stop with the last one', async () => {
    const stopA = watchDrafts();
    const stopB = watchDrafts();
    stopA();
    stopA();
    mock.mockRequests({ clear: true });
    window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
    await settle(420);
    assert.ok(mock.mockRequests().some((r) => r.startsWith('GET /mock/messages')), 'still watching while one watcher is left');
    stopB();
    mock.mockRequests({ clear: true });
    window.dispatchEvent(new CustomEvent('mailflow:sync_done'));
    await settle(420);
    assert.ok(!mock.mockRequests().some((r) => r.startsWith('GET /mock/messages')), 'quiet once nobody watches');
  });
});

// ── the rail ─────────────────────────────────────────────────────────────────
describe('drafts: the rail', () => {
  test('Drafts sits under Later with its glyph and count, and opens the Drafts view', async () => {
    await useV2.getState().refreshDrafts();
    assert.equal(countText(useV2.getState().counts, {}, 'drafts'), '2');
    await render(h(Rail, {}));
    const nav = document.querySelector('nav');
    const later = byText('h2', 'Later', nav);
    const item = all('button.hw-nav', nav).find((b) => b.textContent.startsWith('Drafts'));
    assert.ok(item, 'the rail has Drafts');
    assert.ok(later.compareDocumentPosition(item) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'under Later');
    assert.ok(item.querySelector('svg'), 'with a glyph');
    assert.equal(item.lastElementChild.textContent, '2', 'with the count');
    await click(item);
    assert.equal(useHedwig.getState().viewRequest.id, 'hedwig.drafts');
  });

  test('Drafts is there without the work routes too (Later then holds only Drafts)', async () => {
    useV2.setState({ caps: { work: false } });
    await render(h(Rail, {}));
    const nav = document.querySelector('nav');
    assert.deepEqual(all('h2', nav).map((x) => x.textContent), ['Later', 'Hedwig']);
    assert.ok(all('button.hw-nav', nav).some((b) => b.textContent.startsWith('Drafts')));
    assert.ok(!all('button.hw-nav', nav).some((b) => b.textContent.startsWith('Reply Later')));
  });
});

// ── the thread ───────────────────────────────────────────────────────────────
describe('drafts: in a thread', () => {
  test('a draft renders as a draft block with Edit draft; a trailing draft turns the reply bar into Continue draft', async () => {
    await render(h(Thread, { props: { item: leaseItem } }));
    await settle(80);
    const block = document.querySelector('article[data-draft]');
    assert.ok(block, 'the draft is a draft block');
    assert.equal(block.id, 'hw-msg-2', 'keeps article#hw-msg-N');
    assert.equal(block.querySelector('[data-draft-label]').textContent, 'Draft');
    assert.match(block.textContent, /To Marcus Oduya/);
    assert.match(block.querySelector('[data-draft-snippet]').textContent, /the 12-month renewal works for me/);
    assert.equal(block.querySelector('[data-message-body]'), null, 'no read-only body');
    assert.ok(document.getElementById('hw-msg-1'), 'the real message is still a message');
    assert.ok(document.querySelector('[role="toolbar"]'), 'the toolbar stays');
    const bar = document.querySelector('[data-reply-bar]');
    assert.equal(bar.querySelector('textarea'), null, 'no empty reply field under a draft');
    assert.ok(byText('button', 'Continue draft', bar));
    assert.equal(byLabel('Reply to You'), null, 'never a reply to yourself');

    await click(byText('button', 'Edit draft', block));
    await settle(30);
    assert.equal(composed.length, 1);
    assert.equal(composed[0].draftUid, 41);
    assert.equal(composed[0].draftFolder, 'Drafts');
    assert.equal(composed[0].accountId, 'acc-work');
    assert.deepEqual(composed[0].to, ['Marcus Oduya <marcus@oduya-lettings.example>']);

    await click(byText('button', 'Continue draft', document.querySelector('[data-reply-bar]')));
    await settle(30);
    assert.equal(composed.length, 2);
    assert.equal(composed[1].draftUid, 41);
  });

  test('a thread without a draft keeps its reply field', async () => {
    const anna = (await mock.mockRequest('GET', '/sort/stream/people')).items.find((i) => i.messageId === 'm-anna');
    await render(h(Thread, { props: { item: anna } }));
    await settle(80);
    assert.equal(document.querySelector('article[data-draft]'), null);
    assert.ok(byLabel('Reply to Anna'), 'the reply field');
  });
});

// ── the reply field's text, per thread ───────────────────────────────────────
describe('drafts: the inline reply field', () => {
  test('text typed in a thread is kept when the selection moves and restored on return, with "Draft saved"', async () => {
    const people = (await mock.mockRequest('GET', '/sort/stream/people')).items;
    const anna = people.find((i) => i.messageId === 'm-anna');
    const other = people.find((i) => i.messageId !== 'm-anna' && !i.synthetic && i.messageId);
    useV2.getState().select(anna);
    await render(h(Thread, { props: {} }));
    await settle(80);
    await setText(byLabel('Reply to Anna'), 'Sending the numbers tonight.');
    await settle(900);
    assert.ok(document.querySelector('[data-draft-saved]'), '"Draft saved" once it is kept');
    assert.equal(document.querySelector('[data-draft-saved]').textContent, 'Draft saved');

    await React.act(async () => { useV2.getState().select(other); });
    await settle(80);
    const stored = JSON.parse(localStorage.getItem('hedwig_reply_drafts'));
    assert.equal(stored['t-anna'].text, 'Sending the numbers tonight.', 'kept in localStorage per thread');
    assert.notEqual(document.querySelector('textarea')?.value, 'Sending the numbers tonight.', 'another thread starts empty');

    await React.act(async () => { useV2.getState().select(anna); });
    await settle(80);
    assert.equal(byLabel('Reply to Anna').value, 'Sending the numbers tonight.', 'restored on return');
    assert.ok(document.querySelector('[data-draft-saved]'));

    // A reload: only localStorage is left.
    drafts.resetReplyDraftCache();
    assert.equal(drafts.getReplyDraft('t-anna'), 'Sending the numbers tonight.');
  });

  test('pop-out carries the text to the composer and forgets the kept copy', async () => {
    const anna = (await mock.mockRequest('GET', '/sort/stream/people')).items.find((i) => i.messageId === 'm-anna');
    drafts.setReplyDraft('t-anna', 'Yes, by Thursday.');
    await render(h(Thread, { props: { item: anna } }));
    await settle(80);
    assert.equal(byLabel('Reply to Anna').value, 'Yes, by Thursday.');
    await click(all('button').find((b) => b.getAttribute('aria-label') === 'Open in the composer'));
    await settle(30);
    assert.equal(composed.at(-1).body, 'Yes, by Thursday.');
    assert.equal(drafts.getReplyDraft('t-anna'), '');
  });

  test('storage that throws never breaks the field (memory only)', () => {
    const orig = dom.window.Storage.prototype.setItem;
    dom.window.Storage.prototype.setItem = () => { throw new Error('quota'); };
    try {
      assert.equal(drafts.setReplyDraft('t-x', 'hello'), true);
      assert.equal(drafts.getReplyDraft('t-x'), 'hello');
    } finally {
      dom.window.Storage.prototype.setItem = orig;
    }
  });
});
