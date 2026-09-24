// Optimistic actions with undo (actions.js), the undo toasts, and the reader toolbar that uses
// them: rows leave at once and come back when the call fails, Undo cancels a call not yet sent
// or runs the inverse, at most three toasts with a six-second timer, Z / ⌘Z, the toolbar's
// always-visible Delete / Junk / Flag, the keys in the tooltips, and the next row after Done.
//
// Same harness as v2.test.js. Run with: node --test src/hedwig/v2/actions.test.js
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
const { setMockMode } = await import('./client.js');
const mock = await import('./mock.js');
const { useV2, UI_DEFAULTS, liveRows } = await import('./state.js');
const actions = await import('./actions.js');
const UndoToasts = (await import('./UndoToasts.jsx')).default;
const { isUndoKey } = await import('./UndoToasts.jsx');
const StreamView = (await import('./StreamView.jsx')).default;
const Thread = (await import('./Thread.jsx')).default;

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
async function key(k, { target = document.body, ...mods } = {}) {
  await React.act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })); });
  await settle();
}
const byLabel = (label, scope = document) => scope.querySelector(`[aria-label="${label}"]`);
const toasts = () => actions.useUndo.getState().toasts;
const titles = () => toasts().map((t) => t.title);
async function cleanup() {
  if (root) await React.act(async () => root.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
}

/** A clock the test moves by hand: set / clear / now, and tick(ms) runs what fell due. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const due = new Map();
  return {
    set: (fn, ms) => { id += 1; due.set(id, { at: now + ms, fn }); return id; },
    clear: (k) => { due.delete(k); },
    now: () => now,
    async tick(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
      await settle();
    },
  };
}

const people = async () => (await mock.mockRequest('GET', '/sort/stream/people')).items.filter((i) => i.messageId);
const anna = async () => (await people()).find((i) => i.messageId === 'm-anna');
const rowOf = (item) => [...document.querySelectorAll('[data-row-button]')].find((b) => b.getAttribute('aria-label').startsWith(`${item.from?.name}: ${item.subject}`));
const shows = (item) => Boolean(rowOf(item));

let clock;
beforeEach(async () => {
  await cleanup();
  mock.resetMock();
  notifications.length = 0;
  actions.resetActions();
  clock = fakeClock();
  actions.setUndoClock(clock);
  useV2.setState({ selected: null, prefs: { ...UI_DEFAULTS }, caps: { work: true }, hidden: {}, patches: {}, order: null });
});
after(async () => { await cleanup(); dom.window.close(); });

// ── the layer ────────────────────────────────────────────────────────────────
describe('optimistic actions', () => {
  test('Done takes the row away at once and sends the archive only when the undo window closes', async () => {
    const archived = [];
    actions.setActionOps({ archive: async (msgs) => { archived.push(msgs.map((m) => m.id)); } });
    actions.setUndoClock(clock);
    const item = await anna();
    const id = actions.performAction({ kind: 'done', items: [item], stream: 'people' });
    assert.ok(id);
    assert.equal(liveRows([item], useV2.getState().hidden, {}).length, 0, 'gone from the list at once');
    assert.deepEqual(titles(), ['Done']);
    assert.deepEqual(archived, [], 'not sent yet: Undo can still cancel it');
    await clock.tick(actions.UNDO_MS - 1);
    assert.deepEqual(titles(), ['Done'], 'the toast holds for six seconds');
    await clock.tick(1);
    assert.deepEqual(archived, [['m-anna']], 'sent when the window closed');
    assert.deepEqual(titles(), []);
  });

  test('a failed call brings the row and the selection back and says so in the same toast, with Try again', async () => {
    let fail = true;
    const archived = [];
    actions.setActionOps({ archive: async (msgs) => { if (fail) throw new Error('IMAP said no'); archived.push(msgs.map((m) => m.id)); } });
    actions.setUndoClock(clock);
    const list = await people();
    const item = list.find((i) => i.messageId === 'm-anna');
    useV2.getState().setOrder('test', list);
    useV2.getState().select(item);
    const id = actions.performAction({ kind: 'done', items: [item], stream: 'people' });
    assert.notEqual(useV2.getState().selected?.messageId, 'm-anna', 'the reader moved on');
    await clock.tick(actions.UNDO_MS);
    assert.equal(liveRows([item], useV2.getState().hidden, {}).length, 1, 'the row is back');
    assert.equal(useV2.getState().selected?.messageId, 'm-anna', 'and so is the selection');
    const t = toasts()[0];
    assert.equal(t.id, id, 'the same toast');
    assert.equal(t.title, 'Could not archive.');
    assert.equal(t.tone, 'error');
    assert.equal(t.retry, true);
    assert.equal(t.detail, 'IMAP said no');
    fail = false;
    actions.retry(id);
    await settle();
    assert.deepEqual(archived, [['m-anna']], 'Try again sends at once');
    assert.equal(liveRows([item], useV2.getState().hidden, {}).length, 0);
  });

  test('Undo before the window closes cancels the call and puts the row back', async () => {
    const calls = [];
    actions.setActionOps({ trash: async () => { calls.push('trash'); } });
    actions.setUndoClock(clock);
    const item = await anna();
    const id = actions.performAction({ kind: 'delete', items: [item], stream: 'people' });
    assert.deepEqual(titles(), ['Deleted']);
    assert.equal(actions.undo(id), true);
    assert.equal(liveRows([item], useV2.getState().hidden, {}).length, 1);
    await clock.tick(actions.UNDO_MS * 2);
    assert.deepEqual(calls, [], 'never sent');
    assert.deepEqual(titles(), []);
  });

  test('Undo after the call went runs the inverse: Flag toggles back, Read marks unread, lists remove, Delete leaves Trash, Junk is not junk, Done moves back', async () => {
    const calls = [];
    actions.setActionOps({
      flag: async (ids, on) => { calls.push(['flag', ids, on]); },
      read: async (ids, read) => { calls.push(['read', ids, read]); },
      addToList: async (list, t) => { calls.push(['add', list, t]); },
      removeFromList: async (list, t) => { calls.push(['remove', list, t]); },
      trash: async (msgs) => { calls.push(['trash', msgs.map((m) => m.id)]); },
      untrash: async (msgs) => { calls.push(['untrash', msgs.map((m) => [m.id, m.folder])]); },
      junk: async (msgs) => { calls.push(['junk', msgs.map((m) => m.id)]); },
      unjunk: async (msgs) => { calls.push(['unjunk', msgs.map((m) => m.id)]); },
      archive: async (msgs) => { calls.push(['archive', msgs.map((m) => m.id)]); },
      relocateBack: async (moved) => { calls.push(['back', moved.flatMap((x) => x.msgs.map((m) => [m.id, m.folder, m.header]))]); },
    });
    actions.setUndoClock(clock);
    const item = await anna();
    const run = async (spec) => { const id = actions.performAction({ items: [item], ...spec }); await settle(); return id; };

    let id = await run({ kind: 'flag', on: true });
    assert.deepEqual(useV2.getState().patches['m-anna'].flagged, true, 'flagged on screen at once');
    assert.equal(actions.undo(id), true);
    await settle();
    assert.equal(useV2.getState().patches['m-anna'], undefined, 'the overlay is gone again');

    id = await run({ kind: 'read', read: true });
    actions.undo(id); await settle();
    id = await run({ kind: 'replyLater' });
    actions.undo(id); await settle();

    const messages = [{ id: 'm-anna', folder: 'INBOX', accountId: 'acc-work', raw: { message_id: '<anna@x>' } }, { id: 'm-draft', folder: 'Drafts', accountId: 'acc-work', raw: { flags: ['\\Draft'] } }];
    for (const kind of ['delete', 'junk', 'done']) {
      id = actions.performAction({ kind, items: [item], messages, immediate: true });
      await settle();
      assert.equal(actions.undo(id), true, `${kind} can be undone after it was sent`);
      await settle();
    }
    assert.deepEqual(calls, [
      ['flag', ['m-anna'], true], ['flag', ['m-anna'], false],
      ['read', ['m-anna'], true], ['read', ['m-anna'], false],
      ['add', 'replyLater', 't-anna'], ['remove', 'replyLater', 't-anna'],
      ['trash', ['m-anna']], ['untrash', [['m-anna', 'INBOX']]],
      ['junk', ['m-anna']], ['unjunk', ['m-anna']],
      ['archive', ['m-anna']], ['back', [['m-anna', 'INBOX', '<anna@x>']]],
    ], 'drafts are never part of it');
    assert.deepEqual(useV2.getState().hidden, {}, 'every row is back');
  });

  test('Delete never touches anything already in Trash (that would be permanent) and says so', async () => {
    const calls = [];
    actions.setActionOps({ trash: async (msgs) => { calls.push(msgs.map((m) => m.id)); } });
    actions.setUndoClock(clock);
    const item = await anna();
    actions.performAction({ kind: 'delete', items: [item], messages: [{ id: 'm-anna', folder: 'Trash', accountId: 'acc-work' }], immediate: true });
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(toasts()[0].tone, 'error');
    assert.equal(toasts()[0].title, 'Could not delete.');
  });

  test('at most three toasts, newest on top; the one pushed off is sent at once', async () => {
    const archived = [];
    actions.setActionOps({ archive: async (msgs) => { archived.push(msgs.map((m) => m.id)[0]); } });
    actions.setUndoClock(clock);
    const list = await people();
    const ids = list.slice(0, 4).map((it) => actions.performAction({ kind: 'done', items: [it] }));
    await settle();
    assert.equal(toasts().length, actions.MAX_TOASTS);
    assert.deepEqual(toasts().map((t) => t.id), [ids[3], ids[2], ids[1]], 'newest first');
    assert.deepEqual(archived, [list[0].messageId], 'the oldest could no longer be undone, so it went');
    await clock.tick(actions.UNDO_MS);
    assert.deepEqual(archived.sort(), list.slice(0, 4).map((i) => i.messageId).sort());
    assert.equal(toasts().length, 0);
  });

  test('the next row: below, else above, else none', () => {
    const rows = [{ messageId: 'a' }, { messageId: 'b' }, { messageId: 'c' }];
    assert.equal(actions.nextRow(rows, [{ messageId: 'a' }]).messageId, 'b');
    assert.equal(actions.nextRow(rows, [{ messageId: 'c' }]).messageId, 'b');
    assert.equal(actions.nextRow([{ messageId: 'a' }], [{ messageId: 'a' }]), null);
    assert.equal(actions.nextRow(rows, [{ messageId: 'x' }]), null);
  });
});

// ── the toasts ───────────────────────────────────────────────────────────────
describe('undo toasts', () => {
  test('bottom-centre, polite, with Undo (Z); Z undoes, but not while typing; ⌘Z / Ctrl+Z too', async () => {
    actions.setActionOps({ archive: async () => {} });
    actions.setUndoClock(clock);
    await render(h('div', null, h('textarea', { 'aria-label': 'typing' }), h(UndoToasts)));
    const item = await anna();
    await React.act(async () => { actions.performAction({ kind: 'done', items: [item] }); });
    const region = document.querySelector('[data-undo-toasts]');
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.equal(region.style.position, 'fixed');
    assert.equal(region.style.left, '50%');
    const toast = region.querySelector('[data-undo-toast]');
    assert.equal(toast.style.fontSize, '13px');
    assert.equal(toast.getAttribute('data-material'), 'bar');
    assert.match(toast.textContent, /Done/);
    const undoBtn = byLabel('Undo', toast);
    assert.equal(undoBtn.getAttribute('title'), 'Undo (Z)');

    await key('z', { target: byLabel('typing') });
    assert.equal(toasts().length, 1, 'a z typed in a field is text');
    await key('z');
    assert.equal(toasts().length, 0, 'Z undid it');
    assert.equal(liveRows([item], useV2.getState().hidden, {}).length, 1);

    await React.act(async () => { actions.performAction({ kind: 'done', items: [item] }); });
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
    await key('z', mac ? { metaKey: true } : { ctrlKey: true });
    assert.equal(toasts().length, 0, '⌘Z / Ctrl+Z undid it');
    assert.equal(isUndoKey({ key: 'z', shiftKey: true, metaKey: true, ctrlKey: true }), false, 'Shift is redo, never undo');

    await React.act(async () => { actions.performAction({ kind: 'done', items: [item] }); });
    await click(byLabel('Undo', document.querySelector('[data-undo-toast]')));
    assert.equal(toasts().length, 0, 'the Undo button');
  });

  test('a failure shows in the toast with Try again; hovering holds the timer', async () => {
    actions.setActionOps({ flag: async () => { throw Object.assign(new Error('gone'), { status: 500 }); } });
    actions.setUndoClock(clock);
    await render(h(UndoToasts));
    const item = await anna();
    await React.act(async () => { actions.performAction({ kind: 'flag', on: true, items: [item] }); });
    await settle();
    const toast = document.querySelector('[data-undo-toast]');
    assert.equal(toast.getAttribute('data-tone'), 'error');
    assert.match(toast.textContent, /Could not flag it\./);
    assert.ok(byLabel('Try again', toast));
    assert.equal(useV2.getState().patches['m-anna'], undefined, 'the flag went back off');

    actions.setActionOps({ flag: async () => {} });
    actions.setUndoClock(clock);
    await React.act(async () => { actions.performAction({ kind: 'flag', on: true, items: [item] }); });
    const fresh = document.querySelector('[data-undo-toast]');
    await React.act(async () => { fresh.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    await clock.tick(actions.UNDO_MS * 2);
    assert.equal(titles()[0], 'Flagged', 'held while the pointer is on it');
    await React.act(async () => { fresh.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    await clock.tick(actions.UNDO_MS);
    assert.ok(!titles().includes('Flagged'), 'then it goes');
  });
});

// ── the reader and the rows ──────────────────────────────────────────────────
describe('reader toolbar and rows', () => {
  const withWidth = async (width, fn) => {
    const RO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe() { this.cb([{ contentRect: { width } }]); } unobserve() {} disconnect() {} };
    try { await fn(); } finally { globalThis.ResizeObserver = RO; }
  };

  test('at 700px the toolbar still shows Done, Delete, Junk and Flag, each tooltip naming its key; Reply Later and Move fold into More', async () => {
    await withWidth(700, async () => {
      await render(h(Thread, { props: { item: await anna() } }));
      await settle(60);
      const bar = document.querySelector('[role="toolbar"]');
      for (const label of ['Done (E)', 'Delete (⌫)', 'Junk (!)', 'Flag (⇧S)', 'Reply (R)', 'Reply all (A)', 'Forward (F)', 'More']) {
        const b = byLabel(label, bar);
        assert.ok(b, `${label} at 700px`);
        assert.equal(b.getAttribute('title'), label, `${label}: the key is in the tooltip`);
      }
      for (const label of ['Reply Later (L)', 'Snooze (H)', 'Set Aside (S)', 'Move (V)']) assert.equal(byLabel(label, bar), null, `${label} folds into More`);
      assert.ok(bar.querySelector('svg path[d^="M3 6h18"]'), 'Delete is the trash glyph');
    });
  });

  test('below 640px Reply all and Forward fold too; the first group never does', async () => {
    await withWidth(560, async () => {
      await render(h(Thread, { props: { item: await anna() } }));
      await settle(60);
      const bar = document.querySelector('[role="toolbar"]');
      for (const label of ['Done (E)', 'Delete (⌫)', 'Junk (!)', 'Flag (⇧S)', 'Reply (R)']) assert.ok(byLabel(label, bar), label);
      for (const label of ['Reply all (A)', 'Forward (F)']) assert.equal(byLabel(label, bar), null, label);
    });
  });

  test('Flag fills in the accent and becomes Unflag; ⇧S toggles it', async () => {
    await render(h(Thread, { props: { item: await anna() } }));
    await settle(60);
    await click(byLabel('Flag (⇧S)'));
    const on = byLabel('Unflag (⇧S)');
    assert.ok(on, 'the tooltip says Unflag');
    assert.equal(on.getAttribute('aria-pressed'), 'true');
    assert.equal(on.querySelector('svg').getAttribute('fill'), 'currentColor');
    assert.match(on.style.color, /--hw-accent/, 'in the accent');
    await key('S', { shiftKey: true });
    assert.ok(byLabel('Flag (⇧S)'), 'Shift+S turned it off');
    assert.deepEqual(titles(), ['Flag removed', 'Flagged']);
  });

  test('keys: # and Backspace delete, ! is junk, each once', async () => {
    const seen = [];
    actions.setActionOps({ trash: async () => { seen.push('trash'); }, junk: async () => { seen.push('junk'); } });
    actions.setUndoClock(clock);
    for (const [k, mods, title] of [['#', { shiftKey: true }, 'Deleted'], ['Backspace', {}, 'Deleted'], ['!', { shiftKey: true }, 'Marked as junk']]) {
      await cleanup();
      actions.resetActions();
      actions.setActionOps({ trash: async () => { seen.push('trash'); }, junk: async () => { seen.push('junk'); } });
      actions.setUndoClock(clock);
      useV2.setState({ hidden: {} });
      await render(h(Thread, { props: { item: await anna() } }));
      await settle(60);
      await key(k, mods);
      assert.deepEqual(titles(), [title], `${k} is ${title}`);
    }
  });

  test('Done in the reader goes on to the next row in the list (the one above at the end, the empty reader when none)', async () => {
    await render(h('div', null, h(StreamView, { props: { stream: 'people' } }), h(Thread, { props: {} })));
    await settle(60);
    const order = useV2.getState().order.items.filter((i) => i.messageId);
    assert.ok(order.length > 2, 'the list published its order');
    await React.act(async () => { useV2.getState().select(order[0]); });
    await settle(60);
    await click(byLabel('Done (E)', document.querySelector('[role="toolbar"]')));
    assert.equal(useV2.getState().selected?.messageId, order[1].messageId, 'the next row is open');
    assert.equal(shows(order[0]), false, 'the row left the list at once');
    assert.equal(shows(order[1]), true);
    assert.deepEqual(titles(), ['Done']);
    const now = useV2.getState().order.items.filter((i) => i.messageId);
    const last = now[now.length - 1];
    await React.act(async () => { useV2.getState().select(last); });
    await settle(60);
    await key('e');
    assert.equal(useV2.getState().selected?.messageId, now[now.length - 2].messageId, 'at the end, the one above');
  });

  test('the hover buttons are Done, Snooze, Reply Later and Delete, 24px each, through the same layer', async () => {
    await render(h(StreamView, { props: { stream: 'people' } }));
    await settle(60);
    const item = await anna();
    const article = rowOf(item).closest('article');
    await React.act(async () => { article.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    const buttons = [...article.querySelectorAll('[data-row-actions] button')];
    assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')), ['Done (E)', 'Snooze', 'Reply Later (L)', 'Delete (⌫)']);
    assert.ok(buttons.every((b) => b.style.height === '24px'));
    await click(byLabel('Delete (⌫)', article));
    assert.equal(shows(item), false, 'gone at once');
    assert.deepEqual(titles(), ['Deleted']);
    assert.equal(notifications.length, 0, 'one toast, no second notification');
    assert.equal(actions.undo(), true);
    await settle();
    assert.equal(shows(item), true, 'Undo brought it back');
  });

  test('"Mark the rest read" is one undoable action', async () => {
    const reads = [];
    actions.setActionOps({ read: async (ids, read) => { reads.push([ids.length, read]); } });
    actions.setUndoClock(clock);
    await render(h(StreamView, { props: { stream: 'reading' } }));
    await settle(60);
    const unread = () => document.querySelectorAll('[data-row-button][aria-label$=", unread"]').length;
    assert.equal(unread(), 3);
    await click(byLabel('Filter and sort'));
    await click([...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Mark the rest read'));
    assert.equal(unread(), 0, 'read on screen at once');
    assert.deepEqual(titles(), ['Marked 3 as read']);
    assert.deepEqual(reads, [[3, true]], 'sent at once');
    assert.equal(actions.undo(), true);
    await settle();
    assert.deepEqual(reads, [[3, true], [3, false]], 'Undo marks them unread again');
    assert.equal(unread(), 3);
  });
});
