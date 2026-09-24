// ComposeModal: drag-and-drop / pasted attachments and the Apple Mail style header rows.
//
// Renders the real desktop composer in jsdom (same loader harness as MessagePane.compose.test.js)
// and drives it with native drag events carrying a fake dataTransfer, since jsdom has no
// DragEvent or DataTransfer of its own. React reads event.dataTransfer off the native event, so
// a plain Event with that property attached is what the handlers see in a browser too.

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
const w = dom.window;
Object.assign(globalThis, {
  window: w, document: w.document,
  localStorage: w.localStorage, CustomEvent: w.CustomEvent,
  Node: w.Node, Element: w.Element, HTMLElement: w.HTMLElement,
  MutationObserver: w.MutationObserver, DOMParser: w.DOMParser,
  File: w.File, FileReader: w.FileReader, Blob: w.Blob,
  getComputedStyle: w.getComputedStyle,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
w.innerWidth = 1440;
w.innerHeight = 900;
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

const ACCOUNT = { id: 'acct', enabled: true, email_address: 'me@mine.example', name: 'Me', color: '#fff' };

let root;
let container;
const wait = (ms = 30) => React.act(async () => { await new Promise(r => setTimeout(r, ms)); });

async function mount(composeData) {
  if (root) await React.act(async () => root.unmount());
  container.innerHTML = '';
  useStore.setState({ composing: true, composeData, accounts: [ACCOUNT], plaintextEmail: false });
  root = createRoot(container);
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  await wait();
}

const composer = () => document.querySelector('.compose-window');
const overlay = () => document.querySelector('[data-compose-drop-overlay]');
const attachmentNames = () => Array.from(document.querySelectorAll('[data-compose-attachments] > span'))
  .map(el => el.querySelector('[data-attachment-name]')?.textContent);

// A native drag event with a fake dataTransfer: types says whether files are on board.
function dragEvent(type, files = []) {
  const ev = new w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', {
    value: { files, types: files.length ? ['Files'] : ['text/plain'], dropEffect: 'none', items: [], getData: () => '' },
  });
  return ev;
}
const fire = async (target, ev) => { await React.act(async () => { target.dispatchEvent(ev); }); return ev; };
const file = (name, body = 'x', type = 'text/plain') => new w.File([body], name, { type });

before(() => {
  container = document.getElementById('root');
  useStore.getState().setUser?.({ id: 'u1' });
  useStore.getState().setLocked?.(false);
});
after(async () => { if (root) await React.act(async () => root.unmount()); });

describe('drag and drop attachments', () => {
  beforeEach(async () => { await mount({ accountId: 'acct' }); });

  test('dropping two files attaches both', async () => {
    const target = composer();
    const files = [file('report.pdf', 'pdf!', 'application/pdf'), file('notes.txt', 'hello')];
    await fire(target, dragEvent('dragenter', files));
    await fire(target, dragEvent('dragover', files));
    const drop = await fire(target, dragEvent('drop', files));
    await wait();
    assert.equal(drop.defaultPrevented, true, 'the browser must not open the file');
    assert.deepEqual(attachmentNames().sort(), ['notes.txt', 'report.pdf']);
    assert.equal(overlay(), null, 'the overlay goes away on drop');
  });

  test('a dropped picture shows its thumbnail from the local file, revoked when it is removed', async () => {
    const made = []; const revoked = [];
    const saved = [URL.createObjectURL, URL.revokeObjectURL];
    URL.createObjectURL = (f) => { made.push(f); return `blob:local/${made.length}`; };
    URL.revokeObjectURL = (u) => { revoked.push(u); };
    try {
      const pic = file('Picture1.jpg', 'jpg!', 'image/jpeg');
      await fire(composer(), dragEvent('drop', [pic, file('notes.txt', 'hello')]));
      await wait();
      const thumbs = document.querySelectorAll('[data-compose-attachments] img[data-compose-thumb]');
      assert.equal(thumbs.length, 1, 'only the picture has a thumbnail');
      assert.equal(thumbs[0].getAttribute('src'), 'blob:local/1');
      assert.equal(made[0].name, 'Picture1.jpg');
      const remove = Array.from(document.querySelectorAll('[data-compose-attachments] button')).find(b => /Picture1\.jpg/.test(b.title));
      await React.act(async () => { remove.click(); });
      assert.deepEqual(revoked, ['blob:local/1']);
    } finally {
      [URL.createObjectURL, URL.revokeObjectURL] = saved;
    }
  });

  test('a drop on the body editor attaches through the same path', async () => {
    const editor = document.querySelector('.tiptap-compose');
    assert.ok(editor, 'the rich editor is rendered');
    const target = editor.querySelector('.ProseMirror') || editor;
    // ProseMirror resolves the drop point from the mouse position; jsdom has no layout, so
    // point it at the editor paragraph.
    const para = target.querySelector('p') || target;
    const prev = document.elementFromPoint;
    document.elementFromPoint = () => para;
    try {
      await fire(target, dragEvent('dragenter', [file('a.csv')]));
      const drop = await fire(target, dragEvent('drop', [file('a.csv')]));
      await wait();
      assert.equal(drop.defaultPrevented, true);
      assert.deepEqual(attachmentNames(), ['a.csv']);
      assert.equal(target.textContent.includes('a.csv'), false, 'nothing is inserted into the body');
    } finally {
      document.elementFromPoint = prev;
    }
  });

  test('dropping the same file twice attaches it once', async () => {
    await fire(composer(), dragEvent('drop', [file('dup.txt')]));
    await wait();
    await fire(composer(), dragEvent('drop', [file('dup.txt')]));
    await wait();
    assert.deepEqual(attachmentNames(), ['dup.txt']);
  });

  test('dragover with files shows the overlay; dragleave hides it, even across children', async () => {
    const target = composer();
    const child = document.querySelector('[data-compose-row="to"]');
    const files = [file('a.txt')];
    assert.equal(overlay(), null);
    const over = await fire(target, dragEvent('dragenter', files));
    await fire(target, dragEvent('dragover', files));
    assert.equal(over.defaultPrevented, true);
    assert.ok(overlay(), 'overlay shown while files hover the window');
    assert.equal(overlay().textContent, 'compose.dropToAttach');
    // Moving onto a child: enter child, leave parent. The depth counter keeps the overlay up.
    await fire(child, dragEvent('dragenter', files));
    await fire(target, dragEvent('dragleave', files));
    assert.ok(overlay(), 'no flicker when crossing into a child');
    await fire(child, dragEvent('dragleave', files));
    assert.equal(overlay(), null, 'leaving the window hides the overlay');
  });

  test('a drag of text (no files) shows no overlay and is left alone', async () => {
    const ev = await fire(composer(), dragEvent('dragover'));
    assert.equal(ev.defaultPrevented, false);
    assert.equal(overlay(), null);
  });

  test('a document-level dragover/drop guard does not stop a drop inside the composer', async () => {
    // A page-wide "never let a stray file drop navigate away" guard, registered in the capture
    // phase so it runs before the composer. It cancels both events for everything.
    const seenBubble = [];
    const guard = (e) => e.preventDefault();
    const bubbleSpy = (e) => seenBubble.push(e.type);
    document.addEventListener('dragover', guard, true);
    document.addEventListener('drop', guard, true);
    document.addEventListener('drop', bubbleSpy);
    try {
      const files = [file('one.txt'), file('two.txt')];
      await fire(composer(), dragEvent('dragenter', files));
      await fire(composer(), dragEvent('dragover', files));
      await fire(composer(), dragEvent('drop', files));
      await wait();
      assert.deepEqual(attachmentNames().sort(), ['one.txt', 'two.txt']);
      assert.deepEqual(seenBubble, [], 'the composer claims the drop; nothing above it handles it again');
    } finally {
      document.removeEventListener('dragover', guard, true);
      document.removeEventListener('drop', guard, true);
      document.removeEventListener('drop', bubbleSpy);
    }
  });

  test('pasting files into the subject attaches them', async () => {
    const subject = document.querySelector('.compose-subject-input');
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [file('pasted.pdf', 'p', 'application/pdf')], getData: () => '' } });
    await fire(subject, ev);
    await wait();
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(attachmentNames(), ['pasted.pdf']);
  });
});

describe('header rows', () => {
  test('chips show the display name, keep the full address in the title', async () => {
    await mount({
      accountId: 'acct',
      to: [
        { name: 'Pradeesha V', email: 'pradeesha.v@mouser.example' },
        { name: 'Pradeesha.V@mouser.example', email: 'pradeesha.v@mouser.example' },
        'plain@x.example',
      ],
      cc: [{ name: 'Smith, John', email: 'john@x.example' }],
    });
    const chips = Array.from(document.querySelectorAll('[data-compose-row="to"] [data-compose-chip]'));
    assert.deepEqual(chips.map(c => c.querySelector('.compose-chip-label').textContent), [
      'Pradeesha V',
      'pradeesha.v@mouser.example', // a "name" that is just the address shows the address once
      'plain@x.example',
    ]);
    assert.equal(chips[0].title, 'Pradeesha V <pradeesha.v@mouser.example>');
    const cc = document.querySelector('[data-compose-row="cc"] [data-compose-chip]');
    assert.equal(cc.querySelector('.compose-chip-label').textContent, 'Smith, John');
    assert.equal(cc.title, '"Smith, John" <john@x.example>');
  });

  test('Cc and Bcc rows stay hidden until toggled, and their toggles then disappear', async () => {
    await mount({ accountId: 'acct', to: ['a@x.example'] });
    assert.equal(document.querySelector('[data-compose-row="cc"]'), null);
    assert.equal(document.querySelector('[data-compose-row="bcc"]'), null);
    const ccBtn = document.querySelector('[data-compose-toggle="cc"]');
    const bccBtn = document.querySelector('[data-compose-toggle="bcc"]');
    assert.ok(ccBtn && bccBtn, 'both toggles sit in the To row');
    assert.ok(ccBtn.closest('[data-compose-row="to"]'));
    await React.act(async () => { ccBtn.click(); });
    assert.ok(document.querySelector('[data-compose-row="cc"]'), 'Cc row opens');
    assert.equal(document.activeElement, document.querySelector('[data-compose-row="cc"] .compose-recipient-input'), 'and takes focus');
    assert.equal(document.querySelector('[data-compose-toggle="cc"]'), null, 'Cc toggle is gone');
    assert.equal(document.querySelector('[data-compose-row="bcc"]'), null, 'Bcc still hidden');
    await React.act(async () => { document.querySelector('[data-compose-toggle="bcc"]').click(); });
    assert.ok(document.querySelector('[data-compose-row="bcc"]'));
    assert.equal(document.querySelector('.compose-ccbcc-quickadd'), null);
  });

  test('a Cc that already has recipients renders without toggling', async () => {
    await mount({ accountId: 'acct', to: ['a@x.example'], cc: ['c@x.example'] });
    assert.ok(document.querySelector('[data-compose-row="cc"]'));
    assert.equal(document.querySelector('[data-compose-toggle="cc"]'), null);
    assert.ok(document.querySelector('[data-compose-toggle="bcc"]'));
  });

  test('Backspace in an empty recipient field removes the last chip', async () => {
    await mount({ accountId: 'acct', to: ['a@x.example', 'b@x.example'] });
    const input = document.querySelector('[data-compose-row="to"] .compose-recipient-input');
    await React.act(async () => {
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    const labels = Array.from(document.querySelectorAll('[data-compose-row="to"] .compose-chip-label')).map(e => e.textContent);
    assert.deepEqual(labels, ['a@x.example']);
  });

  test('pasting a list of addresses makes one chip each', async () => {
    await mount({ accountId: 'acct' });
    const input = document.querySelector('[data-compose-row="to"] .compose-recipient-input');
    const ev = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [], getData: () => 'a@x.example, Bob <b@y.example>; c@z.example' } });
    await fire(input, ev);
    const labels = Array.from(document.querySelectorAll('[data-compose-row="to"] .compose-chip-label')).map(e => e.textContent);
    assert.deepEqual(labels, ['a@x.example', 'Bob', 'c@z.example']);
  });

  test('text holding several addresses commits as one chip each on blur', async () => {
    await mount({ accountId: 'acct' });
    const input = document.querySelector('[data-compose-row="to"] .compose-recipient-input');
    const setValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      setValue.call(input, 'Pradeesha.V@mouser.example <pradeesha.v@mouser.example>, Some One <one@x.example>');
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    });
    await React.act(async () => { input.dispatchEvent(new w.FocusEvent('focusout', { bubbles: true })); });
    const labels = Array.from(document.querySelectorAll('[data-compose-row="to"] .compose-chip-label')).map(e => e.textContent);
    assert.deepEqual(labels, ['pradeesha.v@mouser.example', 'Some One']);
  });

  test('an address that does not parse is marked invalid', async () => {
    await mount({ accountId: 'acct', to: ['tommy', 'ok@x.example'] });
    const chips = Array.from(document.querySelectorAll('[data-compose-row="to"] [data-compose-chip]'));
    assert.equal(chips[0].classList.contains('is-invalid'), true);
    assert.equal(chips[1].classList.contains('is-invalid'), false);
  });
});

describe('the footer Discard button', () => {
  const discardBtn = () => document.querySelector('[data-compose-discard]');
  const confirmBox = () => document.querySelector('[data-compose-discard-confirm]');
  const click = async (el) => { await React.act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); }); await wait(); };

  test('a fresh, empty message closes at once with nothing to confirm', async () => {
    await mount({ accountId: 'acct' });
    assert.ok(discardBtn(), 'the footer has a Discard button');
    await click(discardBtn());
    assert.equal(confirmBox(), null, 'nothing typed: no confirmation');
    assert.equal(useStore.getState().composing, false, 'the composer closed');
  });

  test('a stored draft asks first, then deletes the draft and closes', async () => {
    const calls = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => { calls.push([String(url), opts.method || 'GET']); return new w.Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    try {
      await mount({ accountId: 'acct', draftUid: 42, draftFolder: 'Drafts', to: ['a@b.example'], subject: 'Kept', body: 'hello' });
      await click(discardBtn());
      assert.ok(confirmBox(), 'a stored draft is confirmed before it goes');
      const confirmDiscard = confirmBox().querySelector('button');
      await click(confirmDiscard);
      assert.equal(confirmBox(), null);
      assert.equal(useStore.getState().composing, false, 'the composer closed');
      assert.ok(calls.some(([u, m]) => m === 'DELETE' && /\/mail\/draft\/42\b/.test(u)), `the stored draft is deleted: ${JSON.stringify(calls)}`);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

describe('icon-first footer and formatting bar', () => {
  const footerBtn = (sel) => document.querySelector(sel);

  test('Save draft and Discard are icon buttons named by their tooltips; Send keeps its label', async () => {
    await mount({ accountId: 'acct' });
    for (const [sel, label] of [['[data-compose-save]', 'compose.saveDraft'], ['[data-compose-discard]', 'compose.discard']]) {
      const btn = footerBtn(sel);
      assert.ok(btn, `${label} is in the footer`);
      assert.equal(btn.getAttribute('aria-label'), label);
      assert.equal(btn.getAttribute('title'), label);
      assert.equal(btn.textContent, '', `${label} shows an icon, not text`);
      assert.ok(btn.querySelector('svg'), `${label} has its glyph`);
      assert.equal(btn.style.width, '28px');
      assert.equal(btn.style.height, '28px');
    }
    const send = footerBtn('[data-compose-send]');
    assert.match(send.textContent, /compose\.send/, 'Send is the primary action: icon plus label');
    assert.equal(send.getAttribute('title'), 'compose.sendTooltip');
  });

  test('every formatting control has a tooltip and a name, 24px, on one line', async () => {
    await mount({ accountId: 'acct' });
    const bar = document.querySelector('[data-compose-toolbar]');
    assert.ok(bar, 'the desktop formatting bar is rendered');
    assert.equal(bar.style.flexWrap, 'nowrap', 'the bar never wraps onto a second line');
    const buttons = Array.from(bar.querySelectorAll('button'));
    assert.ok(buttons.length >= 12);
    for (const b of buttons) {
      assert.ok(b.getAttribute('title'), `a tooltip on ${b.outerHTML.slice(0, 80)}`);
      assert.equal(b.getAttribute('aria-label'), b.getAttribute('title'));
      assert.equal(b.style.height, '24px');
    }
    const bold = buttons.find(b => /^Bold \((⌘B|Ctrl\+B)\)$/.test(b.title));
    assert.ok(bold, 'Bold names its key');
    assert.equal(bold.getAttribute('aria-pressed'), 'false', 'formatting toggles carry aria-pressed');
    for (const label of ['compose.toolbar.insertTable', 'compose.toolbar.insertImage', 'Edit HTML source']) {
      assert.ok(buttons.some(b => b.title === label), `${label} is on the bar while it fits`);
    }
  });

  test('when the bar is narrower than its content, table, image and HTML source fold into More', async () => {
    const proto = w.HTMLElement.prototype;
    const widths = { clientWidth: 400, scrollWidth: 620 };
    for (const [prop, value] of Object.entries(widths)) {
      Object.defineProperty(proto, prop, { configurable: true, get() { return this.hasAttribute('data-compose-toolbar') ? value : 0; } });
    }
    try {
      await mount({ accountId: 'acct' });
      const bar = document.querySelector('[data-compose-toolbar]');
      assert.ok(bar.hasAttribute('data-collapsed'), 'the bar collapsed');
      const titles = Array.from(bar.querySelectorAll('button')).map(b => b.title);
      for (const label of ['compose.toolbar.insertTable', 'compose.toolbar.insertImage', 'Edit HTML source']) {
        assert.ok(!titles.includes(label), `${label} left the bar`);
      }
      const more = bar.querySelector('[data-compose-toolbar-more]');
      assert.equal(more.getAttribute('title'), 'compose.toolbar.moreFormatting');
      assert.equal(more.getAttribute('aria-haspopup'), 'menu');
      await React.act(async () => { more.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
      await wait();
      const menu = document.querySelector('[data-compose-toolbar-menu]');
      assert.ok(menu, 'More opens its menu');
      assert.deepEqual(Array.from(menu.querySelectorAll('[role="menuitem"]')).map(b => b.textContent),
        ['compose.toolbar.insertImage', 'compose.toolbar.insertTable', 'Edit HTML source']);
    } finally {
      for (const prop of Object.keys(widths)) delete proto[prop];
    }
  });

  test('the title bar buttons have tooltips and names', async () => {
    await mount({ accountId: 'acct' });
    for (const label of ['compose.toolbar.minimize', 'compose.toolbar.maximize', 'compose.toolbar.close']) {
      const btn = document.querySelector(`button[aria-label="${label}"]`);
      assert.ok(btn, label);
      assert.equal(btn.getAttribute('title'), label);
    }
  });
});
