// Render tests for the attachment row: picture thumbnails (fetched as blobs once on screen), the
// attachment viewer (pictures and framed PDFs, handing one to a new tab), opening straight in a tab
// by choice, middle-truncated names, "Download all" as an icon button, and the composer's chips. Same loader hook as MessagePane.render.test.js: node --test cannot parse
// JSX, so .jsx goes through sucrase, and react-i18next is stubbed so t() returns the key.

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
        'export const useTranslation = () => ({ t: (k, o) => (o && o.label !== undefined ? k + "[" + o.label + "]" : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__') };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// Every observed element is on screen at once, unless a test holds them back.
let observing = true;
const observed = [];
globalThis.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { observed.push(el); if (observing) this.cb([{ isIntersecting: true, target: el }]); }
  disconnect() {}
};

const fetched = [];
let fetchFails = false;
globalThis.fetch = async (url, opts) => {
  fetched.push({ url: String(url), opts });
  if (fetchFails) return { ok: false, status: 500, blob: async () => new Blob([]) };
  return { ok: true, status: 200, blob: async () => new Blob(['img'], { type: 'image/jpeg' }) };
};
let made = 0;
const revoked = [];
URL.createObjectURL = () => `blob:https://mail.example.invalid/${++made}`;
URL.revokeObjectURL = (u) => { revoked.push(u); };
let opened = [];
dom.window.open = (url, target) => { opened.push({ url, target }); return {}; };

const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { default: AttachmentChips, MiddleName } = await import('./AttachmentChips.jsx');
const {
  middleTruncate, splitFilename, isPreviewableImage, isPdfAttachment, previewKind, getAttachmentObjectUrl,
  clearAttachmentCache, attachmentCacheSize, THUMB_CACHE_MAX,
} = await import('../utils/attachmentPreview.js');

const ATTS = [
  { part: '2', filename: 'Picture1.jpg', type: 'image/jpeg', size: 28 * 1024 },
  { part: '3', filename: 'Picture2.jpg', type: 'application/octet-stream', size: 28 * 1024 },
  { part: '4', filename: '10101023637468_September_statement_2026-09.pdf', type: 'application/pdf', size: 699 * 1024 },
];

let root;
let host;
const flush = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function mount(props) {
  await React.act(async () => { root.render(h(AttachmentChips, { messageId: 'm1', look: 'hedwig', ...props })); });
  await flush();
}
const chips = () => [...host.querySelectorAll('[data-attachment]')];
const dialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');
const key = (k) => React.act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })); });
// The frame's document as the browser would leave it: a PDF, a JSON error page, or none at all.
const loadFrame = (frame, contentType) => React.act(async () => {
  Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => (contentType ? { contentType } : null) });
  frame.dispatchEvent(new window.Event('load'));
});

before(() => { host = document.getElementById('root'); root = createRoot(host); });
after(async () => { await React.act(async () => root.unmount()); });
beforeEach(async () => {
  await React.act(async () => root.render(null));
  clearAttachmentCache();
  fetched.length = 0; revoked.length = 0; opened = []; observed.length = 0;
  fetchFails = false; observing = true;
});

describe('names', () => {
  test('a long name is cut in the middle, keeping the extension', () => {
    assert.equal(middleTruncate('10101023637468_September_statement_2026-09.pdf'), '10101023637468_Sep…09.pdf');
    assert.equal(middleTruncate('Picture1.jpg'), 'Picture1.jpg');
    assert.equal(middleTruncate('a-very-long-name-without-any-extension-at-all', 20), 'a-very-long-name-wi…');
    assert.deepEqual(splitFilename('10101023637468_September_statement_2026-09.pdf'), { head: '10101023637468_September_statement_2026-', tail: '09.pdf' });
    assert.deepEqual(splitFilename('Picture1.jpg'), { head: 'Picture1.jpg', tail: '' });
  });

  test('the chip keeps the tail in its own unshrinking span and the full name as the tooltip', async () => {
    await mount({ attachments: ATTS });
    const name = chips()[2].querySelector('[data-attachment-name]');
    assert.equal(name.title, ATTS[2].filename);
    assert.equal(name.lastElementChild.textContent, '09.pdf');
    assert.equal(name.lastElementChild.style.flexShrink, '0');
    assert.equal(name.firstElementChild.style.textOverflow, 'ellipsis');
    assert.equal(name.textContent, ATTS[2].filename);
  });

  test('MiddleName without an extension is one span', async () => {
    await React.act(async () => { root.render(h(MiddleName, { name: 'README' })); });
    assert.equal(host.querySelector('[data-attachment-name]').children.length, 1);
  });
});

describe('thumbnails', () => {
  test('a picture chip draws its thumbnail from the fetched blob, with the session cookie, inline', async () => {
    await mount({ attachments: ATTS });
    const thumbs = host.querySelectorAll('[data-attachment-thumb]');
    assert.equal(thumbs.length, 2, 'both pictures, not the PDF');
    for (const t of thumbs) {
      assert.equal(t.dataset.attachmentThumb, 'ready');
      assert.match(t.querySelector('img').src, /^blob:/);
      assert.equal(t.style.width, '40px');
      assert.equal(t.style.borderRadius, '6px');
      assert.equal(t.querySelector('img').style.objectFit, 'cover');
    }
    assert.deepEqual(fetched.map((f) => f.url), ['/api/mail/messages/m1/attachments/2?inline=1', '/api/mail/messages/m1/attachments/3?inline=1']);
    assert.ok(fetched.every((f) => f.opts.credentials === 'include'));
  });

  test('nothing is fetched until the chip is on screen', async () => {
    observing = false;
    await mount({ attachments: ATTS });
    assert.equal(fetched.length, 0);
    assert.equal(host.querySelector('[data-attachment-thumb]').dataset.attachmentThumb, 'loading');
  });

  test('a failed fetch falls back to the file glyph; a picture over 8 MB never fetches', async () => {
    fetchFails = true;
    await mount({ attachments: [ATTS[0], { part: '9', filename: 'huge.png', type: 'image/png', size: 9 * 1024 * 1024 }] });
    const thumbs = host.querySelectorAll('[data-attachment-thumb]');
    assert.equal(thumbs.length, 1);
    assert.equal(thumbs[0].dataset.attachmentThumb, 'failed');
    assert.ok(thumbs[0].querySelector('svg'));
    assert.equal(fetched.length, 1);
  });

  test('the cache holds 40 and revokes what it evicts', async () => {
    for (let i = 0; i < THUMB_CACHE_MAX + 2; i += 1) await getAttachmentObjectUrl('m', String(i));
    assert.equal(attachmentCacheSize(), THUMB_CACHE_MAX);
    assert.deepEqual(revoked, ['blob:https://mail.example.invalid/' + (made - THUMB_CACHE_MAX - 1), 'blob:https://mail.example.invalid/' + (made - THUMB_CACHE_MAX)]);
  });

  test('SVG and disguised names are never previewed; PDFs are told apart', () => {
    assert.equal(isPreviewableImage({ filename: 'logo.svg', type: 'image/svg+xml' }), false);
    assert.equal(isPreviewableImage({ filename: 'photo.jpg.exe', type: 'image/jpeg' }), false);
    assert.equal(isPreviewableImage({ filename: 'photo.HEIC', type: '' }), true);
    assert.equal(isPdfAttachment({ filename: 'a.pdf', type: 'application/octet-stream' }), true);
    assert.equal(isPdfAttachment({ filename: 'a.pdf.exe' }), false);
    assert.deepEqual(ATTS.map(previewKind), ['image', 'image', 'pdf']);
    assert.equal(previewKind({ filename: 'notes.txt', type: 'text/plain' }), null);
  });
});

describe('opening', () => {
  test('a picture opens the viewer; arrows move through the pictures and the PDF; Esc closes', async () => {
    await mount({ attachments: ATTS });
    await React.act(async () => { chips()[0].click(); });
    await flush();
    assert.ok(dialog(), 'the viewer is open');
    assert.equal(dialog().getAttribute('aria-label'), 'Picture1.jpg');
    assert.match(dialog().querySelector('[data-lightbox-img]').src, /^blob:/);
    assert.equal(document.activeElement.dataset.lightboxBtn, 'close', 'focus moves into the dialog');
    await key('ArrowRight');
    assert.equal(dialog().getAttribute('aria-label'), 'Picture2.jpg');
    await key('ArrowRight');
    assert.equal(dialog().getAttribute('aria-label'), ATTS[2].filename);
    assert.equal(dialog().dataset.lightboxKind, 'pdf');
    await key('ArrowRight');
    assert.equal(dialog().getAttribute('aria-label'), 'Picture1.jpg', 'wraps round');
    await key('ArrowLeft');
    assert.equal(dialog().dataset.lightboxKind, 'pdf');
    await key('Escape');
    assert.ok(!dialog());
    assert.equal(fetched.length, 2, 'the viewer reuses the thumbnails\' blobs, and the PDF frame fetches for itself');
  });

  test('the buttons move and close; a click on the scrim closes; Tab stays inside and reaches the PDF', async () => {
    await mount({ attachments: ATTS });
    await React.act(async () => { chips()[1].click(); });
    await flush();
    await React.act(async () => { dialog().querySelector('[data-lightbox-btn="next"]').click(); });
    assert.equal(dialog().dataset.lightboxKind, 'pdf');
    await React.act(async () => { dialog().querySelector('[data-lightbox-btn="prev"]').click(); });
    assert.equal(dialog().getAttribute('aria-label'), 'Picture2.jpg');
    await key('Tab');
    assert.ok(dialog().contains(document.activeElement));
    await React.act(async () => { dialog().querySelector('[data-lightbox-btn="next"]').click(); });
    for (let i = 0; i < 6 && document.activeElement?.tagName !== 'IFRAME'; i += 1) await key('Tab');
    assert.equal(document.activeElement?.tagName, 'IFRAME', 'keyboard focus can enter the PDF');
    await React.act(async () => { dialog().querySelector('[data-lightbox-btn="close"]').click(); });
    assert.ok(!dialog());
    await React.act(async () => { chips()[0].click(); });
    await flush();
    const scrim = document.querySelector('[data-lightbox]');
    await React.act(async () => { scrim.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })); });
    assert.ok(!dialog());
  });

  test('a PDF opens in the viewer: the inline route in a frame, shown once the frame holds a PDF', async () => {
    await mount({ attachments: ATTS });
    await React.act(async () => { chips()[2].click(); });
    await flush();
    assert.equal(opened.length, 0, 'no tab');
    assert.equal(dialog().dataset.lightboxKind, 'pdf');
    assert.equal(dialog().getAttribute('aria-label'), ATTS[2].filename);
    const frame = dialog().querySelector('iframe[data-lightbox-pdf]');
    assert.equal(frame.getAttribute('src'), '/api/mail/messages/m1/attachments/4?inline=1');
    assert.equal(frame.title, ATTS[2].filename);
    await loadFrame(frame, 'application/pdf');
    assert.equal(dialog().querySelector('[data-lightbox-state]').dataset.lightboxState, 'ready');
    assert.equal(frame.style.visibility, 'visible');
    assert.equal(dialog().querySelector('[role="alert"], [role="status"]'), null);
    assert.ok(chips()[2].querySelector('[data-glyph="preview"]'), 'the chip says it previews');
  });

  test('a frame that loads anything but a PDF says so, and Retry loads it again', async () => {
    await mount({ attachments: ATTS });
    await React.act(async () => { chips()[2].click(); });
    await flush();
    await loadFrame(dialog().querySelector('iframe[data-lightbox-pdf]'), 'application/json');
    assert.equal(dialog().querySelector('[data-lightbox-state]').dataset.lightboxState, 'failed');
    assert.equal(dialog().querySelector('[role="alert"]').textContent, 'message.preview.failedPdf');
    const before = dialog().querySelector('iframe[data-lightbox-pdf]');
    await React.act(async () => { dialog().querySelector('[data-lightbox-retry]').click(); });
    assert.equal(dialog().querySelector('[data-lightbox-state]').dataset.lightboxState, 'loading');
    assert.ok(dialog().querySelector('iframe[data-lightbox-pdf]') !== before, 'a fresh frame');
    await loadFrame(dialog().querySelector('iframe[data-lightbox-pdf]'), null);
    assert.equal(dialog().querySelector('[data-lightbox-state]').dataset.lightboxState, 'failed', 'a frame the browser refused has no document');
  });

  test('"Open in new tab" in the viewer hands the file to a tab and closes the viewer', async () => {
    await mount({ attachments: ATTS });
    await React.act(async () => { chips()[2].click(); });
    await flush();
    const tab = dialog().querySelector('[data-lightbox-btn="tab"]');
    assert.equal(tab.getAttribute('aria-label'), 'message.preview.openInTab');
    await React.act(async () => { tab.click(); });
    assert.deepEqual(opened, [{ url: '/api/mail/messages/m1/attachments/4?inline=1', target: '_blank' }]);
    assert.ok(!dialog());
    await React.act(async () => { chips()[0].click(); });
    await flush();
    await React.act(async () => { dialog().querySelector('[data-lightbox-btn="tab"]').click(); });
    assert.equal(opened[1].url, '/api/mail/messages/m1/attachments/2?inline=1', 'a picture too');
  });

  test('openIn="tab" opens pictures and PDFs straight in a new tab; anything else still downloads', async () => {
    await mount({ attachments: [...ATTS, { part: '5', filename: 'notes.txt', type: 'text/plain', size: 10 }], openIn: 'tab' });
    await React.act(async () => { chips()[2].click(); });
    await React.act(async () => { chips()[0].click(); });
    assert.deepEqual(opened.map((o) => o.url), ['/api/mail/messages/m1/attachments/4?inline=1', '/api/mail/messages/m1/attachments/2?inline=1']);
    assert.ok(!dialog());
    assert.ok(chips()[2].querySelector('[data-glyph="open"]'), 'the chip says it opens a tab');
    assert.ok(!chips()[3].querySelector('[data-glyph]'), 'the text file keeps the download glyph');
  });
});

describe('header', () => {
  test('"Download all" is an icon button named "Download all (zip)"', async () => {
    await mount({ attachments: ATTS });
    const all = host.querySelector('[data-download-all]');
    assert.equal(all.getAttribute('aria-label'), 'message.downloadAllZip');
    assert.equal(all.title, 'message.downloadAllZip');
    assert.ok(all.querySelector('svg'));
    assert.equal(all.textContent, '', 'no text beside the glyph');
    assert.equal(all.getAttribute('href'), '/api/mail/messages/m1/attachments.zip');
    assert.match(host.textContent, /message\.attachment/);
  });

  test('an attachment with no size shows no empty size line', async () => {
    await mount({ attachments: [{ part: '5', filename: 'notes.txt', type: 'text/plain', size: 0 }] });
    const lines = chips()[0].querySelectorAll('div > div');
    assert.equal([...lines].filter((d) => d.textContent === '').length, 0);
  });
});
