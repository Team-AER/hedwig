// Smart dark mode for email bodies: the pure helpers (utils/mailDarkMode.js) and the frame
// document it builds. jsdom has no layout, so the live decision (decideMailDark) is covered
// only for what it can see here; the browser check is in the review notes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectsNativeDark, luminance, parseColour, pickMode, effectiveBackground, mailDarkWanted, normaliseMailDark,
  frameSrcDoc, readSenderPrefs, senderMailDark, setSenderMailDark, subscribeSenderMailDark,
  SENDER_PREFS_KEY, MAIL_DARK_PAPER, MAIL_DARK_FILTER, MAIL_DARK_COUNTER, MAIL_DARK_KEEP, DARK_LUMINANCE,
} from './mailDarkMode.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    data,
  };
}

describe('detectsNativeDark', () => {
  test('a color-scheme meta that names dark, in either attribute order and quoting', () => {
    assert.equal(detectsNativeDark('<meta name="color-scheme" content="light dark"><p>x</p>'), true);
    assert.equal(detectsNativeDark("<meta content='dark' name='color-scheme'>"), true);
    assert.equal(detectsNativeDark('<META NAME=color-scheme CONTENT="only dark">'), true);
    assert.equal(detectsNativeDark('<meta name="supported-color-schemes" content="light dark">'), true);
  });
  test('a meta that does not name dark is not a declaration', () => {
    assert.equal(detectsNativeDark('<meta name="color-scheme" content="only light">'), false);
    assert.equal(detectsNativeDark('<meta name="color-scheme" content="light">'), false);
    assert.equal(detectsNativeDark('<meta name="description" content="dark roast coffee">'), false);
    assert.equal(detectsNativeDark('<meta data-name="color-scheme" content="dark">'), false);
  });
  test('a prefers-color-scheme: dark block or a color-scheme declaration in <style>', () => {
    assert.equal(detectsNativeDark('<style>@media (prefers-color-scheme: dark) { body { background: #000 } }</style>'), true);
    assert.equal(detectsNativeDark('<style type="text/css">@media screen and (prefers-color-scheme:dark){.x{color:#fff}}</style>'), true);
    assert.equal(detectsNativeDark('<style>:root { color-scheme: light dark; supported-color-schemes: light dark; }</style>'), true);
  });
  test('light-only styles, a commented-out block and text mentioning it do not count', () => {
    assert.equal(detectsNativeDark('<style>@media (prefers-color-scheme: light) { body { color: #000 } }</style>'), false);
    assert.equal(detectsNativeDark('<style>/* @media (prefers-color-scheme: dark) {} */ p { color: red }</style>'), false);
    assert.equal(detectsNativeDark('<p>Try @media (prefers-color-scheme: dark) in your CSS</p>'), false);
    assert.equal(detectsNativeDark(''), false);
    assert.equal(detectsNativeDark(null), false);
  });
});

describe('colours', () => {
  test('parseColour reads hex, rgb() in both syntaxes and names', () => {
    assert.deepEqual(parseColour('#fff'), { r: 255, g: 255, b: 255, a: 1 });
    assert.deepEqual(parseColour('#1E1E20'), { r: 30, g: 30, b: 32, a: 1 });
    assert.deepEqual(parseColour('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(parseColour('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
    assert.equal(parseColour('transparent').a, 0);
    assert.equal(parseColour('not a colour'), null);
  });
  test('luminance is WCAG relative luminance; transparent has none', () => {
    assert.equal(luminance('#ffffff'), 1);
    assert.equal(luminance('rgb(0, 0, 0)'), 0);
    assert.ok(Math.abs(luminance('#777777') - 0.184) < 0.002);
    assert.ok(Math.abs(luminance('#f4f1ea') - 0.88) < 0.01);
    assert.equal(luminance('rgba(0, 0, 0, 0)'), null);
    assert.equal(luminance('garbage'), null);
  });
  test('effectiveBackground is the innermost mostly-opaque layer', () => {
    assert.equal(effectiveBackground(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']), null);
    assert.equal(effectiveBackground(['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)', 'rgb(17, 17, 17)']), 'rgb(17, 17, 17)');
    assert.equal(effectiveBackground(['rgb(17, 17, 17)', 'rgba(255, 255, 255, 0.1)']), 'rgb(17, 17, 17)');
  });
});

describe('pickMode', () => {
  test('native wins over any background', () => {
    assert.equal(pickMode({ native: true, background: '#ffffff' }), 'native');
  });
  test('an already dark background is left alone; the threshold is 0.35', () => {
    assert.equal(pickMode({ background: 'rgb(0, 0, 0)' }), 'already');
    assert.equal(pickMode({ background: '#1a1a2e' }), 'already');
    assert.equal(pickMode({ background: DARK_LUMINANCE - 0.01 }), 'already');
    assert.equal(pickMode({ background: DARK_LUMINANCE }), 'inverted');
  });
  test('light, or nothing opaque (the default white page), is inverted', () => {
    assert.equal(pickMode({ background: '#ffffff' }), 'inverted');
    assert.equal(pickMode({ background: '#f4f1ea' }), 'inverted');
    assert.equal(pickMode({ background: null }), 'inverted');
    assert.equal(pickMode(), 'inverted');
  });
});

describe('whether a message is darkened', () => {
  test('dark theme, Smart, and the sender not opted out', () => {
    assert.equal(mailDarkWanted({ dark: true, setting: 'smart' }), true);
    assert.equal(mailDarkWanted({ dark: false, setting: 'smart' }), false, 'never in the light theme');
    assert.equal(mailDarkWanted({ dark: true, setting: 'off' }), false);
    assert.equal(mailDarkWanted({ dark: true, setting: 'smart', senderPref: 'light' }), false);
  });
  test('the setting defaults to smart', () => {
    assert.equal(normaliseMailDark(undefined), 'smart');
    assert.equal(normaliseMailDark('bogus'), 'smart');
    assert.equal(normaliseMailDark('off'), 'off');
  });
});

describe('frameSrcDoc', () => {
  const html = '<table style="background:#fff"><tr><td>Hello <a href="https://x.example">link</a></td></tr></table>';

  test('light is the white page it always was: only light, forced white, no dark hooks', () => {
    const doc = frameSrcDoc(html);
    assert.match(doc, /<meta name="color-scheme" content="only light">/);
    assert.match(doc, /background-color: #ffffff !important; color-scheme: light;/);
    assert.match(doc, /<html><head>/);
    assert.doesNotMatch(doc, /data-hw-dark/);
    assert.doesNotMatch(doc, /invert\(/);
    assert.match(doc, /<a rel="noopener noreferrer" href/);
  });

  test('dark: the decision hooks, starting pending (inverted) so a light mail never flashes white', () => {
    const doc = frameSrcDoc(html, { dark: true });
    assert.match(doc, /<html data-hw-dark="pending">/);
    assert.match(doc, /<meta name="color-scheme" content="only light">/, 'inverted mail is still a light document underneath');
    assert.doesNotMatch(doc, /#ffffff !important/, 'no forced white page');
    assert.ok(doc.includes(`html[data-hw-dark] { background-color: ${MAIL_DARK_PAPER} !important; }`), 'the dark paper behind everything');
    assert.ok(doc.includes(`html[data-hw-dark="inverted"] #mf-scale-wrapper { filter: ${MAIL_DARK_FILTER}; }`));
    assert.ok(doc.includes(`html[data-hw-dark="inverted"] body { background-color: transparent !important;`), 'the body cannot leak white');
    for (const keep of ['img', 'picture', 'video', 'svg', 'canvas', '[style*="background-image" i]', '[background]', '.hw-keep']) {
      assert.ok(doc.includes(`html[data-hw-dark="inverted"] #mf-scale-wrapper ${keep}`), `${keep} is counter-inverted`);
    }
    assert.ok(doc.includes(`{ filter: ${MAIL_DARK_COUNTER}; }`));
    assert.ok(doc.includes(`html[data-hw-dark="inverted"] #mf-scale-wrapper :is(${MAIL_DARK_KEEP}) :is(${MAIL_DARK_KEEP}),`), 'nested media is not inverted twice');
    assert.match(doc, /e8e8e8%22"\] \{ filter: none; \}/);
    assert.ok(doc.includes('html[data-hw-dark="inverted"] #mf-scale-wrapper img[src^="data:image/svg+xml,"][src*="fill%3D%22%23e8e8e8%22"]'), 'a blocked remote image slot darkens with the mail');
    assert.doesNotMatch(doc, /data-hw-dark="(already|measure)"\]/, 'already and measure carry no rules');
    assert.match(doc, /color: #1a1a1a;/, 'the light defaults stay, they are what gets inverted');
  });

  test('dark and native: the dark base style in <head> at zero specificity, no forced colours, no filter', () => {
    const mail = '<meta name="color-scheme" content="light dark"><style>@media (prefers-color-scheme: dark){td{color:#eee}}</style>' + html;
    const doc = frameSrcDoc(mail, { dark: true, native: true });
    assert.match(doc, /<html data-hw-dark="native">/);
    assert.match(doc, /<meta name="color-scheme" content="dark">/);
    const head = doc.slice(0, doc.indexOf('</head>'));
    assert.match(head, /<style id="hw-dark-base">/);
    assert.ok(head.includes(`:root { color-scheme: dark; background-color: ${MAIL_DARK_PAPER}; }`));
    assert.match(head, /:where\(body\) \{ color: #E4E4E6; \}/);
    const tail = doc.slice(doc.lastIndexOf('<style>'));
    assert.doesNotMatch(tail, /color: #1a1a1a|a \{ color: #6366f1|#ffffff/, 'the sender keeps its colours');
    assert.doesNotMatch(tail, /(?<![-\w])color:[^;]*!important/, 'no !important text colour');
    assert.doesNotMatch(doc, /data-hw-dark="native"\][^{]*\{ filter/, 'no filter on a native mail');
  });
});

describe('the per-sender choice', () => {
  test('remembers original colours per address, case-insensitively, and clears back to darkened', () => {
    const store = memoryStorage();
    assert.equal(senderMailDark('News@Example.org', store), null);
    setSenderMailDark('News@Example.org', 'light', store);
    assert.equal(senderMailDark('news@example.org', store), 'light');
    assert.deepEqual(JSON.parse(store.getItem(SENDER_PREFS_KEY)), { 'news@example.org': 'light' });
    setSenderMailDark('news@example.org', 'dark', store);
    assert.equal(senderMailDark('news@example.org', store), null);
    assert.equal(store.getItem(SENDER_PREFS_KEY), null, 'an empty map is removed');
  });
  test('broken or unavailable storage never throws', () => {
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    assert.deepEqual(readSenderPrefs(broken), {});
    assert.equal(senderMailDark('a@b.example', broken), null);
    assert.doesNotThrow(() => setSenderMailDark('a@b.example', 'light', broken));
    assert.deepEqual(readSenderPrefs(memoryStorage({ [SENDER_PREFS_KEY]: '{not json' })), {});
    assert.deepEqual(readSenderPrefs(memoryStorage({ [SENDER_PREFS_KEY]: '["x"]' })), {});
    assert.equal(senderMailDark('', memoryStorage()), null);
  });
  test('subscribers hear every change', () => {
    const store = memoryStorage();
    const heard = [];
    const off = subscribeSenderMailDark((k) => heard.push(k));
    setSenderMailDark('A@b.example', 'light', store);
    off();
    setSenderMailDark('A@b.example', null, store);
    assert.deepEqual(heard, ['a@b.example']);
  });
});
