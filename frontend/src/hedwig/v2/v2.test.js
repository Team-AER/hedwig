// Component and unit tests for the Hedwig v2 frontend: the pure helpers, the theme tokens, the
// design primitives, and every v2 view rendered against the mock backend (mock.js), which
// answers with the response shapes of docs/hedwig/V2-BUILD.md.
//
// Same harness as components/MessagePane.compose.test.js: JSX through sucrase, a jsdom window,
// react-dom's act(). Run with: node --test src/hedwig/v2/v2.test.js
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
const { setMockMode, announceSortChange, COUNTS_EVENT } = await import('./client.js');
const mock = await import('./mock.js');
const { useV2, prefsFromFields, UI_DEFAULTS, watchSystemScheme, unwatchSystemScheme, countText } = await import('./state.js');
const { useHedwig } = await import('../store.js');
const { ensureHedwigStyles } = await import('../theme/styles.js');
const { rescueLine } = await import('./Screener.jsx');
const { cardParts, todayLine } = await import('./Brief.jsx');
const { hasListKey, whySignals } = await import('./WhyDoor.jsx');
const { routingLine } = await import('./HedwigSettings.jsx');
const { firstRowFor } = await import('./rows.jsx');
const { normaliseStory, normaliseDeadline } = await import('./threadData.js');
const format = await import('./format.js');
const tokens = await import('../theme/tokens.js');
const P = await import('./primitives.jsx');
const StreamView = (await import('./StreamView.jsx')).default;
const Screener = (await import('./Screener.jsx')).default;
const Thread = (await import('./Thread.jsx')).default;
const { foldRuns, upstreamOwnsKey, hiddenInPage } = await import('./Thread.jsx');
const { shortcutBus } = await import('../../utils/shortcutBus.js');
const Brief = (await import('./Brief.jsx')).default;
const Today = (await import('./Today.jsx')).default;
const HedwigSettingsV2 = (await import('./HedwigSettings.jsx')).default;
const { v2Views, v2SessionAllowed, startV2Session, stopV2Session, isV2SessionRunning } = await import('./index.js');
const actions = await import('./actions.js');
const toastTitles = () => actions.useUndo.getState().toasts.map((t) => t.title);

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
const all = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const byText = (sel, text, scope = document) => all(sel, scope).find((e) => e.textContent.trim() === text);
const byLabel = (label, scope = document) => scope.querySelector(`[aria-label="${label}"]`);
const text = () => document.body.textContent;

async function cleanup() {
  if (root) await React.act(async () => root.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
}

beforeEach(() => { mock.resetMock(); notifications.length = 0; actions.resetActions(); useV2.setState({ selected: null, prefs: { ...UI_DEFAULTS }, caps: { work: null }, hidden: {}, patches: {}, order: null }); });
// Event-driven reloads wait REFRESH_DEBOUNCE_MS (300) so one burst is one fetch.
const AFTER_EVENT = 420;
const phoneView = (el) => h(P.PhoneContext.Provider, { value: { phone: true, depth: 0 } }, el);

// ── pure helpers ─────────────────────────────────────────────────────────────
describe('format helpers', () => {
  const now = new Date('2026-09-23T12:00:00');

  test('list times: clock today, Yesterday, weekday this week, day and month after', () => {
    assert.match(format.listTime(new Date('2026-09-23T09:40:00'), now), /09:40/);
    assert.equal(format.listTime(new Date('2026-09-22T09:40:00'), now), 'Yesterday');
    assert.equal(format.listTime(new Date('2026-09-20T09:40:00'), now), 'Sun');
    assert.match(format.listTime(new Date('2026-09-01T09:40:00'), now), /Sep/);
    assert.equal(format.listTime('not a date', now), '');
  });

  test('splitStream puts Needs you first and groups the rest by day', () => {
    const { needs, groups } = format.splitStream([
      { messageId: 'a', date: '2026-09-23T08:00:00', needsYou: false },
      { messageId: 'b', date: '2026-09-22T08:00:00', needsYou: true },
      { messageId: 'c', date: '2026-09-22T09:00:00', needsYou: false },
      { messageId: 'd', date: '2026-09-01T09:00:00', needsYou: false },
    ], now);
    assert.deepEqual(needs.map((i) => i.messageId), ['b']);
    assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'earlier']);
  });

  test('groupBundles collapses Records into one group per bundle with a summary, in bundle order', () => {
    const out = format.groupBundles([
      { bundle: 'bills', from: { name: 'Telia' }, date: '2026-09-21', unread: false, subject: 'Bill' },
      { bundle: 'deliveries', from: { name: 'DHL' }, date: '2026-09-23', unread: true, subject: 'Parcel' },
      { bundle: 'deliveries', from: { name: 'Posten' }, date: '2026-09-22', unread: false, subject: 'Books' },
      { bundle: null, from: { name: 'Someone' }, date: '2026-09-20' },
    ], [{ key: 'deliveries', name: 'Deliveries', position: 1 }, { key: 'bills', name: 'Bills', position: 2 }]);
    assert.deepEqual(out.map((g) => g.name), ['Deliveries', 'Bills', 'Not in a bundle']);
    assert.equal(out[0].summary, 'DHL, Posten');
    assert.equal(out[0].unread, 1);
  });

  test('storyParts splits citations out of the story', () => {
    assert.deepEqual(format.storyParts('Sent a draft [2]. Fixed [3].'), [
      { text: 'Sent a draft' }, { cite: 2 }, { text: '. Fixed' }, { cite: 3 }, { text: '.' },
    ]);
    assert.deepEqual(format.storyParts(null), []);
  });

  test('newTextOf drops quoted history; htmlToPlain never keeps markup', () => {
    assert.equal(format.newTextOf('Yes, Thursday.\n\nOn Mon, Anna wrote:\n> old'), 'Yes, Thursday.');
    assert.equal(format.htmlToPlain('<p>Hi <b>there</b></p><script>x()</script>'), 'Hi there');
  });

  test('slip dates read like the mockup ("Fri 25")', () => {
    assert.equal(format.slipDate('2026-09-25T17:00:00'), 'Fri 25');
  });
});

describe('theme tokens', () => {
  test('the Hedwig themes carry the redesign palette (DESIGN-AUDIT-2026-09-24 §e), light and dark', () => {
    const light = tokens.hwVarsFor('hedwig');
    assert.equal(light['--hw-paper'], '#EEF0F3');
    assert.equal(light['--hw-ink'], '#1D1D1F');
    assert.equal(light['--hw-accent'], '#007AFF');
    assert.equal(light['--hw-accent-ink'], '#0062CC');
    assert.equal(light['--hw-on-accent'], '#FFFFFF');
    assert.equal(light['--hw-glass'], 'rgba(248,248,250,0.72)');
    const dark = tokens.hwVarsFor('hedwig-night');
    assert.equal(dark['--hw-paper'], '#161618');
    assert.equal(dark['--hw-accent'], '#0A84FF');
    assert.equal(dark['--hw-edge'], 'rgba(255,255,255,0.08)');
    assert.equal(dark['--hw-on-accent'], '#FFFFFF', 'white glyphs on the blue in both themes');
    assert.equal(light['--hw-font-why'], light['--hw-font-body'], 'reasons are the body face, no serif');
  });

  test('ui.accent and ui.blur become CSS that wins over the theme block', () => {
    const css = tokens.userVarsCss({ accent: '#2f6f5e', blur: 60 });
    assert.match(css, /:root\[data-mailflow-theme\] \{ --hw-blur: 48px; \}/);
    assert.match(css, /--hw-accent: #2F6F5E/);
    assert.doesNotMatch(tokens.userVarsCss({ accent: '#E0561A', blur: 24 }), /--hw-accent:/, 'the default accent leaves each theme its own');
    assert.equal(tokens.normaliseHex('#abc'), '#AABBCC');
    assert.equal(tokens.normaliseHex('red'), null);
  });

  test('contrast: on-accent, accent-ink on the tint, and a custom accent picks its own on-accent', () => {
    // The tint over the paper, flattened: rgba(224,86,26,.12) on #F4F2EC.
    const mix = (fg, a, bg) => `#${[0, 2, 4].map((i) => Math.round(parseInt(fg.slice(1 + i, 3 + i), 16) * a + parseInt(bg.slice(1 + i, 3 + i), 16) * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
    const lightTint = mix('#E0561A', 0.12, '#F4F2EC');
    const darkTint = mix('#FF7A40', 0.16, '#111214');
    assert.ok(tokens.contrastRatio('#9E3B0E', lightTint) >= 4.5, 'accent-ink on the light tint');
    assert.ok(tokens.contrastRatio('#FF9A66', darkTint) >= 4.5, 'accent-ink on the dark tint');
    assert.ok(tokens.contrastRatio('#111214', '#FF7A40') >= 4.5, 'dark on-accent');
    assert.ok(tokens.contrastRatio('#FFFFFF', '#E0561A') >= 3, 'light on-accent (icons)');
    assert.ok(tokens.contrastRatio('#FFFFFF', '#FF7A40') < 3, 'the old white-on-orange in dark really was too low');
    assert.ok(tokens.contrastRatio(mix('#17181A', 0.8, lightTint), lightTint) >= 4.5, 'ink at 80% on the light tint');
    assert.ok(tokens.contrastRatio('#66696D', lightTint) < 4.5, 'muted grey on the tint is what failed');
    assert.equal(tokens.onAccentFor('#F5D90A'), '#111214', 'a yellow accent gets dark icons');
    assert.match(tokens.userVarsCss({ accent: '#2f6f5e' }), /--hw-on-accent: #FFFFFF/);
  });

  test('ui.* values are read from GET /settings field descriptions', () => {
    assert.deepEqual(prefsFromFields([
      { key: 'ui.powerMode', value: true }, { key: 'ui.blur', value: 100 }, { key: 'ui.accent', value: 'nope' }, { key: 'sort.autoScreen', value: true },
    ]), { powerMode: true, blur: 48, accent: tokens.DEFAULT_ACCENT });
  });
});

// ── primitives ───────────────────────────────────────────────────────────────
describe('primitives', () => {
  after(cleanup);

  test('Sheet, Why door, Figure, Slip, TextTabs and Pick', async () => {
    let opened = null;
    let tab = null;
    let pick = null;
    await render(h('div', null,
      h(P.Sheet, { 'data-testid': 'sheet' }, 'inside'),
      h(P.Why, { tone: 'accent', onOpen: () => { opened = true; }, label: 'Why: busy' }, 'Asked for the report by Friday'),
      h(P.Why, null, 'plain reason'),
      h(P.Figure, { value: '1,240', caption: 'NOK, electricity', sub: 'due Friday', accent: true }),
      h(P.Slip, null, 'slip'),
      h(P.TextTabs, {
        variant: 'stacked', label: 'Streams', value: 'people', onChange: (v) => { tab = v; },
        items: [{ id: 'screener', label: 'Screener', count: 7, countAccent: true }, { id: 'people', label: 'People', count: 4, dotWhenActive: true }],
      }),
      h(P.Pick, { label: 'Stream', value: 'records', onChange: (v) => { pick = v; }, options: [{ id: 'people', label: 'People' }, { id: 'records', label: 'Records' }] }),
    ));
    assert.ok(document.querySelector('[data-testid="sheet"]').classList.contains('hw-sheet'));
    const door = byLabel('Why: busy');
    assert.equal(door.tagName, 'BUTTON');
    assert.equal(door.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(door.style.fontStyle, 'normal', 'reasons are no longer italic');
    await click(door);
    assert.equal(opened, true);
    assert.equal(byText('span', 'plain reason').tagName, 'SPAN', 'a reason without a door is not a button');
    const nav = document.querySelector('nav[aria-label="Streams"]');
    assert.equal(byLabel('People, 4', nav).getAttribute('aria-current'), 'page');
    await click(byLabel('Screener, 7', nav));
    assert.equal(tab, 'screener');
    const radios = all('[role="radio"]');
    assert.equal(radios.find((r) => r.textContent === 'Records').getAttribute('aria-checked'), 'true');
    await click(radios.find((r) => r.textContent === 'People'));
    assert.equal(pick, 'people');
    // A radio group: one Tab stop, arrow keys move the choice and the focus.
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, 0]);
    pick = null;
    await React.act(async () => { radios[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    assert.equal(pick, 'people', 'wraps from the last option to the first');
  });

  test('the glass sheet forms no stacking context, so a fixed menu inside a pane is not trapped under the next one', () => {
    ensureHedwigStyles();
    const css = document.getElementById('hedwig-shell-styles').textContent;
    const sheet = /\.hw-sheet \{([^}]*)\}/.exec(css)[1];
    assert.doesNotMatch(sheet, /isolation|z-index|opacity|transform|filter/);
    const glass = /\.hw-sheet::before \{([^}]*)\}/.exec(css)[1];
    assert.doesNotMatch(glass, /z-index/);
    assert.match(css, /:where\(\.hw-sheet > \*\) \{ position: relative; \}/);
    assert.match(css, /\.hw-hit::after/);
  });
});

// ── views on the mock ────────────────────────────────────────────────────────
describe('People stream', () => {
  after(cleanup);

  test('Needs you on top with reasons, no question on desktop, then the rest; the reason opens the why door and Change this corrects', async () => {
    await render(h(StreamView, { props: { stream: 'people' } }));
    assert.ok(document.querySelector('h1').textContent === 'People');
    assert.match(document.querySelector('h1').parentElement.textContent, /People\d+ · 5 unread/, 'the title row says how many and how many unread');
    const needs = document.querySelector('section[aria-label="Needs you"]');
    assert.equal(needs.querySelector('h2').textContent, 'Needs you5', 'the Needs you header carries its count');
    assert.equal(all('[data-row-button]', needs).length, 5, 'four people and a due reminder');
    assert.match(needs.textContent, /Asked for the report by Friday/);
    assert.doesNotMatch(text(), /Keep her mail in People\?/, 'the day\'s question lives in the Brief on desktop');
    assert.match(text(), /Reply Later/);
    assert.match(text(), /Focus and Reply/);

    // Rows that do not need you carry no reason line, only a quiet "why" door.
    const jonas = byLabel('Jonas Weber: Re: Weekend plans').closest('article');
    assert.equal(jonas.querySelector('.hw-why-door:not(.hw-row-why)'), null);
    assert.ok(jonas.querySelector('.hw-row-why'));

    await click(byLabel('Why: Waiting four days · your landlord. Open to see or change'));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, 'the why door opened');
    await settle();
    assert.match(dialog.textContent, /He asked you to choose between two options/);
    assert.match(dialog.textContent, /Reflex model/);
    assert.match(dialog.textContent, /81% sure/);
    assert.match(dialog.textContent, /sort\.reflex@2026-09-23\.1/);

    await click(byText('button', 'Change this', dialog));
    assert.deepEqual(all('input[type="radio"]', dialog).map((r) => r.value), ['one', 'sender', 'kind'], 'no list scope for personal mail');
    await click(all('[role="radio"]', dialog).find((r) => r.textContent === 'Reading'));
    await click(all('[role="radio"]', dialog).find((r) => r.textContent === 'Doesn’t need me'));
    const always = all('input[type="radio"]', dialog).find((r) => r.value === 'sender');
    await React.act(async () => { always.click(); });
    await click(byText('button', 'Change it', dialog));
    assert.equal(document.querySelector('[role="dialog"]'), null, 'the door closes after the correction');
    assert.match(notifications.at(-1).title, /Hedwig will do the same next time/);
    // The mock applied POST /sort/correct: Marcus moved to Reading and the list reloaded.
    await settle(AFTER_EVENT);
    assert.doesNotMatch(document.querySelector('section[aria-label="Needs you"]').textContent, /Marcus Oduya/);
    const reading = await mock.mockRequest('GET', '/sort/stream/reading');
    assert.ok(reading.items.some((i) => i.messageId === 'm-marcus'));
  });

  test('opening a row selects it and tints it; a reminder row has nothing to open', async () => {
    const row = byLabel('Anna Berg: Q3 report: can you send the final numbers?, unread');
    await click(row);
    assert.equal(useV2.getState().selected.messageId, 'm-anna');
    assert.equal(row.closest('article').getAttribute('aria-current'), 'true');
    const reminder = byLabel('Reminder: Call the dentist about the crown, unread');
    assert.equal(reminder.getAttribute('aria-disabled'), 'true');
    await click(reminder);
    assert.equal(useV2.getState().selected.messageId, 'm-anna', 'the reminder did not replace the selection');
    assert.match(reminder.closest('article').textContent, /You asked to be reminded/);
  });

  test('a long stream: Needs you is complete from its own list, the rest pages with Show more', async () => {
    await cleanup();
    // 150 newer messages push every Needs you row past the first page of the plain list.
    mock.mockAddItems('people', Array.from({ length: 150 }, (_, i) => ({ id: `bulk-${i}`, subject: `Bulk ${i}`, date: new Date(Date.now() - i * 1000).toISOString() })));
    await render(h(StreamView, { props: { stream: 'people' } }));
    assert.equal(all('[data-row-button]', document.querySelector('section[aria-label="Needs you"]')).length, 5);
    const before = all('[data-row-button]').length;
    const more = byText('button', 'Show more');
    assert.ok(more, 'there is a next page');
    await click(more);
    await settle();
    assert.ok(all('[data-row-button]').length > before + 50);
    assert.equal(byText('button', 'Show more'), undefined, 'the last page has no Show more');
    assert.ok(mock.mockRequests().some((r) => r.startsWith('GET /sort/stream/people?needsYou=1')));
  });

  test('on a phone the day\'s question sits in People (All): Yes answers this one, always is its own button', async () => {
    await cleanup();
    await render(phoneView(h(StreamView, { props: { stream: 'people' } })));
    assert.doesNotMatch(text(), /Keep her mail in People\?/, 'not on the Needs you tab');
    await click(byText('button', 'All'));
    assert.match(text(), /Keep her mail in People\?/);
    assert.ok(byText('button', 'Yes, always'));
    await click(byText('button', 'Yes'));
    assert.doesNotMatch(text(), /Keep her mail in People\?/);
    assert.deepEqual(mock.mockAnswers().at(-1), { id: 'q-anna', optionId: 'yes', always: false }, 'a plain Yes makes no rule');
  });
});

describe('why door scopes', () => {
  after(cleanup);

  test('"Everything from this list" only for mail with a List-Id; the mock (like the backend) refuses it otherwise', async () => {
    assert.equal(hasListKey({ signals: [{ name: 'list', label: 'Mailing list or bulk headers (List-Unsubscribe / Precedence)' }] }), false);
    assert.equal(hasListKey({ signals: [{ name: 'list', label: 'Mailing list weekly.benedict.example' }] }), true);
    assert.equal(hasListKey({ senderDecision: { scope: 'address' } }), false);
    await render(h(StreamView, { props: { stream: 'reading' } }));
    await click(byLabel("Benedict's Newsletter: Why on-device models change the browser, unread").closest('article').querySelector('.hw-row-why'));
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    await click(byText('button', 'Change this', dialog));
    assert.ok(all('input[type="radio"]', dialog).some((r) => r.value === 'list'));
    await assert.rejects(mock.mockRequest('POST', '/sort/correct', { messageId: 'm-marcus', stream: 'reading', always: 'list' }), /mailing list/);
  });
});

describe('counts', () => {
  after(async () => { stopV2Session(); await cleanup(); });

  test('Needs you is counted from the needsYou list; only a poll toasts, never right after your own change, and a poll that moves a count reloads the lists', async () => {
    await useV2.getState().refreshCounts();
    assert.equal(useV2.getState().counts.people, 5);
    assert.equal(useV2.getState().counts.replyLater, 3);
    assert.equal(countText({ reading: 100 }, { reading: true }, 'reading'), '100+');

    let reloads = 0;
    const onCounts = () => { reloads += 1; };
    window.addEventListener(COUNTS_EVENT, onCounts);
    mock.mockAddItems('people', [{ id: 'new-1', needsYou: true, reason: 'New', subject: 'Fresh' }]);
    announceSortChange({ test: true });
    await useV2.getState().refreshCounts({ poll: true });
    assert.equal(useV2.getState().counts.people, 6);
    assert.equal(notifications.length, 0, 'no toast right after a change made here');
    assert.equal(reloads, 1, 'the lists were told to reload');

    mock.mockAddItems('people', [{ id: 'new-2', needsYou: true, reason: 'New', subject: 'Fresher' }]);
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try { await useV2.getState().refreshCounts({ poll: true }); } finally { Date.now = realNow; }
    assert.equal(notifications.at(-1).title, 'A new message needs you');
    window.removeEventListener(COUNTS_EVENT, onCounts);
  });

  test('one sort change: the counts and a mounted Screener share one debounced GET', async () => {
    startV2Session();
    assert.equal(isV2SessionRunning(), true);
    await render(h(Screener));
    await settle(AFTER_EVENT);
    mock.mockRequests({ clear: true });
    announceSortChange({ test: true });
    announceSortChange({ test: true });
    await settle(AFTER_EVENT);
    const screenerGets = mock.mockRequests().filter((r) => r === 'GET /sort/screener');
    assert.equal(screenerGets.length, 1, `one request, got ${screenerGets.length}`);
    stopV2Session();
    assert.equal(isV2SessionRunning(), false);
    assert.equal(useV2.getState().counts.people, null, 'stopping forgets the user\'s counts');
  });
});

describe('session and scheme', () => {
  test('the v2 session runs only in the Hedwig shell with Hedwig on', () => {
    setMockMode(false);
    try {
      assert.equal(v2SessionAllowed({ userId: null, shellMode: 'hedwig', status: { ready: true, enabled: true } }), false);
      assert.equal(v2SessionAllowed({ userId: 'u1', shellMode: 'classic', status: { ready: true, enabled: true } }), false);
      assert.equal(v2SessionAllowed({ userId: 'u1', shellMode: 'hedwig', status: { ready: false } }), false);
      assert.equal(v2SessionAllowed({ userId: 'u1', shellMode: 'hedwig', status: { ready: true, enabled: false } }), false);
      assert.equal(v2SessionAllowed({ userId: 'u1', shellMode: 'hedwig', status: { ready: true, enabled: true, features: {} } }), true);
    } finally { setMockMode(true); }
  });

  test('a saved theme survives sign-in; only an explicit "auto" follows the system', () => {
    // matchMedia says light in this test window.
    useStore.getState().setTheme('hedwig-night');
    useV2.setState({ scheme: null });
    unwatchSystemScheme();
    watchSystemScheme();
    assert.equal(useStore.getState().theme, 'hedwig-night', 'no choice made: the saved theme stands');
    unwatchSystemScheme();
    useV2.setState({ scheme: 'auto' });
    watchSystemScheme();
    assert.equal(useStore.getState().theme, 'hedwig', 'auto follows the (light) system');
    unwatchSystemScheme();
    useV2.setState({ scheme: null });
  });
});

describe('Records stream', () => {
  after(cleanup);

  test('each bundle is one line with a summary until opened', async () => {
    await render(h(StreamView, { props: { stream: 'records' } }));
    const bundle = all('button[aria-expanded]').find((b) => b.textContent.includes('Deliveries'));
    assert.ok(bundle);
    assert.match(bundle.textContent, /DHL, Posten/);
    assert.equal(bundle.getAttribute('aria-expanded'), 'false');
    assert.equal(all('[data-row-button]').length, 0);
    await click(bundle);
    assert.equal(bundle.getAttribute('aria-expanded'), 'true');
    assert.equal(all('[data-row-button]').length, 2);
  });
});

describe('Screener', () => {
  after(cleanup);

  test('proposed stream per sender, rescue rows say so, picking another and accepting decides it', async () => {
    await render(h(Screener));
    assert.match(text(), /7 waiting/);
    const erik = document.querySelector('article[aria-label="Erik Haugen"]');
    assert.match(erik.textContent, /In your spam folder, but it looks real: he is replying/);
    assert.ok(erik.style.background.includes('accent-tint'));
    assert.ok(byLabel('Accept: People, rescue from spam', erik));
    const prize = document.querySelector('article[aria-label="Winner Selection Dept"]');
    assert.ok(byLabel('Accept: Block', prize));

    const nordlys = document.querySelector('article[aria-label="Nordlys Travel"]');
    await click(all('[role="radio"]', nordlys).find((r) => r.textContent === 'People'));
    await click(byLabel('Accept: People', nordlys));
    assert.equal(document.querySelector('article[aria-label="Nordlys Travel"]'), null);
    const log = await mock.mockRequest('GET', '/sort/today');
    assert.equal(log.entries[0].after.decision, 'people', 'the changed pick was sent, not the proposal');

    // Accept (per row) and Accept all are icon buttons named by their tooltips.
    const rowAccept = byLabel('Accept: Block', prize);
    assert.equal(rowAccept.getAttribute('title'), 'Accept: Block');
    assert.equal(rowAccept.textContent, '', 'the row Accept is a check icon, no text');
    const acceptAll = byLabel('Accept all');
    assert.equal(acceptAll.getAttribute('title'), 'Accept all');
    assert.equal(acceptAll.textContent, '');
    assert.ok(acceptAll.querySelector('svg'), 'the check-check glyph');
    await click(acceptAll);
    assert.match(text(), /No new senders/);
    assert.match(notifications.at(-1).title, /Accepted senders: 6/);
  });

  test('stream pickers are radio groups with one Tab stop; a rescue row without a reason drops the colon', async () => {
    await cleanup();
    await render(h(Screener));
    const group = document.querySelector('article[aria-label="Nordlys Travel"] [role="radiogroup"]');
    const radios = all('[role="radio"]', group);
    assert.deepEqual(radios.map((r) => r.tabIndex), [-1, -1, 0, -1], 'only the proposed Records is tabbable');
    await React.act(async () => { radios[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    await settle();
    const after = all('[role="radio"]', document.querySelector('article[aria-label="Nordlys Travel"] [role="radiogroup"]'));
    assert.equal(after[3].getAttribute('aria-checked'), 'true', 'ArrowRight picked Block');
    assert.equal(document.activeElement, after[3]);
    assert.equal(rescueLine(''), 'In your spam folder, but it looks real.');
    assert.equal(rescueLine('He replied in May.'), 'In your spam folder, but it looks real: he replied in May.');
  });

  test('clicking a sender row opens their latest message in the reader; the decisions and Accept are not inside that button', async () => {
    await cleanup();
    useV2.setState({ selected: null });
    await render(h(Screener));
    const nordlys = document.querySelector('article[aria-label="Nordlys Travel"]');
    const row = nordlys.querySelector('[data-row-button]');
    assert.ok(row, 'the sender, subject and preview are one row button');
    assert.equal(row.querySelectorAll('button').length, 0, 'no button inside the row button');
    assert.ok(!row.contains(byLabel('Accept: Records', nordlys)), 'Accept is a sibling');
    assert.ok(!row.contains(nordlys.querySelector('[role="radiogroup"]')), 'the decisions are siblings');
    assert.ok(row.contains(nordlys.querySelector('[data-tldr]')), 'the preview opens it too');
    await click(row);
    assert.equal(useV2.getState().selected.messageId, 'm-nordlys');
    assert.equal(document.querySelector('article[aria-label="Nordlys Travel"]').getAttribute('aria-current'), 'true');
    await click(all('[role="radio"]', nordlys).find((r) => r.textContent === 'People'));
    assert.equal(useV2.getState().selected.messageId, 'm-nordlys', 'a decision does not open anything else');
    assert.equal(all('[role="radio"]', nordlys).find((r) => r.textContent === 'People').getAttribute('aria-checked'), 'true');
    await cleanup();
  });
});

describe('Thread', () => {
  after(cleanup);
  const annaItem = async () => (await mock.mockRequest('GET', '/sort/stream/people')).items.find((i) => i.messageId === 'm-anna');
  const setText = async (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const focusIn = async (el) => { await React.act(async () => { el.focus(); el.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true })); }); await settle(); };

  test('toolbar, subject, story with citations, deadline, collapsed earlier messages, latest message, reason with Change, quick replies and the reply bar', async () => {
    await render(h(Thread, { props: { item: await annaItem() } }));
    await settle(60);
    assert.equal(document.querySelector('h2').textContent, 'Q3 report: can you send the final numbers?');
    assert.equal(document.querySelector('h2').style.fontSize, '20px');
    assert.match(text(), /Anna Berg and you · 5 messages · Work/);

    // The toolbar: every button names its key, in its tooltip too; Done shows its label.
    const bar = document.querySelector('[role="toolbar"]');
    for (const label of ['Done (E)', 'Delete (⌫)', 'Junk (!)', 'Flag (⇧S)', 'Reply Later (L)', 'Snooze (H)', 'Set Aside (S)', 'Reply (R)', 'Reply all (A)', 'Forward (F)', 'Move (V)', 'More']) {
      const b = byLabel(label, bar);
      assert.ok(b, `${label} in the toolbar`);
      assert.equal(b.getAttribute('title'), label);
    }
    assert.equal(byLabel('Done (E)', bar).textContent, 'Done');

    const story = document.querySelector('section[aria-label="The story so far"]');
    assert.match(story.textContent, /Story so far/);
    assert.equal(all('button[aria-label^="Message "]', story).length, 3);

    // Older read messages are 44px rows (four of them: not folded); the newest is open.
    assert.equal(all('article[id^="hw-msg-"]').length, 5);
    assert.equal(document.querySelector('article#hw-msg-2 [data-message-body]'), null, 'collapsed: no body');
    assert.ok(document.querySelector('article#hw-msg-2 button[aria-expanded="false"]'));
    assert.doesNotMatch(text(), /earlier messages/, 'four collapsed rows do not fold');
    assert.equal(document.querySelector('article#hw-msg-5 [data-text-body]').textContent, 'Hi, the board pack goes to print Friday morning. Could you send the final Q3 numbers by Thursday evening? The corrected revenue lines are already in.');
    assert.equal(document.querySelector('article#hw-msg-5 iframe'), null, 'plain text, no frame');
    assert.doesNotMatch(document.querySelector('article#hw-msg-5').textContent, /^\s*5/, 'no mono ordinal');

    // Citation 1 names m-anna-2 (the second message): it opens in place.
    await click(byLabel('Message 1', story));
    assert.match(document.querySelector('article#hw-msg-2 [data-message-body]').textContent, /Two revenue lines look off/);
    await click(document.querySelector('article#hw-msg-2 header button[aria-expanded="true"]'));
    assert.equal(document.querySelector('article#hw-msg-2 [data-message-body]'), null, 'collapsed again');

    const slip = document.querySelector('[aria-label="Deadline"]');
    assert.match(slip.textContent, /Final Q3 numbers/);
    assert.match(slip.textContent, /Deadline, asked by Anna/);
    assert.match(text(), /In People because you reply to Anna within an hour\./);
    assert.match(text(), /1 tracker blocked/);

    // The reply bar: a 40px field that grows on focus with Draft in my voice and Send.
    const input = byLabel('Reply to Anna');
    assert.equal(input.tagName, 'TEXTAREA');
    assert.equal(byLabel('Draft in my voice'), null, 'collapsed until focused');
    await focusIn(input);
    // Draft in my voice is a sparkles icon button named by its tooltip; Send keeps its label.
    const voice = byLabel('Draft in my voice');
    assert.ok(voice, 'Draft in my voice button');
    assert.equal(voice.getAttribute('title'), 'Draft in my voice');
    assert.equal(voice.textContent, '', 'an icon, no text label');
    const sendBtn = byText('button', 'Send');
    assert.ok(sendBtn, 'Send button');
    assert.match(sendBtn.getAttribute('title'), /^Send \((⌘|Ctrl\+)↩\)$/);
    assert.equal(sendBtn.getAttribute('aria-label'), sendBtn.getAttribute('title'));

    await click(byText('button', 'Sending them now.'));
    assert.equal(input.value, 'Sending them now.');
    await click(byLabel('Draft in my voice'));
    await settle();
    assert.match(input.value, /Hi Anna, yes/);
    assert.ok(mock.mockRequests().includes('POST /work/draft'));
    const submit = async () => { await React.act(async () => { input.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }); await settle(); };
    // The send guard warns first (a mentioned attachment, nothing attached); a second press sends.
    await setText(input, 'The numbers are attached.');
    await submit();
    assert.match(text(), /You mention “attached” but nothing is attached\./);
    assert.ok(byText('button', 'Send anyway'));
    assert.equal(input.value, 'The numbers are attached.', 'a warning never sends or clears');
    await submit();
    assert.equal(input.value, '');
    assert.equal(notifications.at(-1).title, 'Sent.');

    await click(byText('button', 'Change'));
    assert.ok(document.querySelector('[role="dialog"][aria-label="Why Hedwig put it here"]'));
  });

  test('without the work routes, Reply Later, Set Aside and drafting are hidden, not "not available"', async () => {
    await cleanup();
    useV2.setState({ caps: { work: false } });
    await render(h(Thread, { props: { item: await annaItem() } }));
    await settle(60);
    await focusIn(byLabel('Reply to Anna'));
    for (const label of ['Reply Later (L)', 'Set Aside (S)']) assert.equal(byLabel(label), null, label);
    assert.equal(byLabel('Draft in my voice'), null);
    assert.ok(byLabel('Done (E)'));
    assert.doesNotMatch(text(), /Not available yet/);
  });

  test('Reply Later posts the thread to /work/lists/reply_later', async () => {
    await cleanup();
    await render(h(Thread, { props: { item: await annaItem() } }));
    await settle(60);
    await click(byLabel('Reply Later (L)'));
    assert.deepEqual(toastTitles(), ['Added to Reply Later'], 'one undo toast, no second notification');
    assert.equal(notifications.length, 0);
    const list = await mock.mockRequest('GET', '/work/lists/replyLater');
    assert.ok(list.items.some((i) => i.threadId === 't-anna'));
    assert.equal(useV2.getState().counts.replyLater, 4);
  });

  test('keys: S sets aside, never while typing or as the second key of a g sequence', async () => {
    await cleanup();
    await render(h(Thread, { props: { item: await annaItem() } }));
    await settle(60);
    const key = async (k, target = document.body) => { await React.act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }); await settle(); };
    await key('s', byLabel('Reply to Anna'));
    assert.deepEqual(toastTitles(), [], 'typing an s in the reply is text');
    await key('g');
    await key('s');
    assert.deepEqual(toastTitles(), [], 'g then s is not Set Aside');
    await key('s');
    assert.deepEqual(toastTitles(), ['Set aside']);
  });

  test('help me write off hides quick replies and drafting', async () => {
    await cleanup();
    useV2.setState({ prefs: { ...UI_DEFAULTS, helpMeWrite: false } });
    await render(h(Thread, { props: { item: await annaItem() } }));
    await settle(60);
    await focusIn(byLabel('Reply to Anna'));
    assert.equal(byText('button', 'Sending them now.'), undefined);
    assert.equal(byLabel('Draft in my voice'), null);
  });

  test('no selection is a quiet line, not an error', async () => {
    await cleanup();
    await render(h(Thread, { props: {} }));
    assert.match(text(), /Pick a conversation to read it here\./);
  });

  test('the reply bar never shrinks under the messages: both keep their height (flex-shrink 0), the bar is sticky', async () => {
    await cleanup();
    await render(h(Thread, { props: { item: await annaItem() } }));
    await settle(60);
    const list = document.querySelector('[data-messages]');
    const bar = document.querySelector('[data-reply-bar]');
    assert.equal(list.style.flexShrink, '0');
    assert.equal(bar.style.flexShrink, '0');
    assert.equal(bar.style.position, 'sticky');
    assert.ok(list.compareDocumentPosition(bar) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  });

  // Regression: E/R/A/F/S are upstream's keys too. With upstream's list or reading pane mounted
  // and a message selected there, one press ran both upstream's action and the reader's.
  test('keys: a letter upstream acts on (a listener mounted, a message selected there) is left to upstream', async () => {
    await cleanup();
    await render(h(Thread, { props: { item: await annaItem() } }));
    await settle(60);
    const key = async (k) => { await React.act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); }); await settle(); };
    const star = () => {};
    shortcutBus.on('toggleStar', star);
    useStore.setState({ selectedMessageId: 'upstream-1' });
    try {
      await key('s');
      assert.deepEqual(toastTitles(), [], 'S is upstream\'s star here, not Set Aside as well');
    } finally {
      shortcutBus.off('toggleStar', star);
      useStore.setState({ selectedMessageId: null });
    }
    await key('s');
    assert.deepEqual(toastTitles(), ['Set aside'], 'with nobody upstream listening, S is Set Aside');
    assert.equal(upstreamOwnsKey('e', { selectedMessageId: 'x', hasListener: (a) => a === 'archive' }), true);
    assert.equal(upstreamOwnsKey('e', { selectedMessageId: null, hasListener: () => true }), false, 'no upstream selection: nothing to act on');
    assert.equal(upstreamOwnsKey('e', { shortcuts: { archive: 'y' }, selectedMessageId: 'x', hasListener: () => true }), false, 'the user moved archive off E');
    assert.equal(upstreamOwnsKey('h', { selectedMessageId: 'x', hasListener: () => true }), false, 'H is not upstream\'s');
  });

  // Regression: a reader left mounted in a pane hidden beside a wide view (display:none) ran its
  // keys beside the overlay reader, so E archived twice.
  test('keys: a reader in a hidden pane stays quiet', async () => {
    await cleanup();
    await render(h('div', { style: { display: 'none' } }, h(Thread, { props: { item: await annaItem() } })));
    await settle(60);
    notifications.length = 0;
    await React.act(async () => { document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true })); });
    await settle();
    assert.deepEqual(toastTitles(), []);
    assert.equal(hiddenInPage(document.querySelector('section.hw-v2')), true);
  });

  // Regression: the width observer attached once at mount, when the reader showed "Pick a
  // conversation" (no section), so the toolbar never folded after the first selection.
  test('the toolbar folds at a narrow reader width even when the reader mounted empty', async () => {
    await cleanup();
    const RO = globalThis.ResizeObserver;
    const observed = [];
    globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(el) { observed.push(el); this.cb([{ contentRect: { width: 600 } }]); } unobserve() {} disconnect() {} };
    try {
      await render(h(Thread, { props: {} }));
      const item = await annaItem();
      await React.act(async () => { root.render(h(Thread, { props: { item } })); });
      await settle(60);
      assert.ok(observed.some((el) => el.tagName === 'SECTION'), 'the reader section is observed');
      const bar = document.querySelector('[role="toolbar"]');
      assert.ok(byLabel('Done (E)', bar));
      assert.equal(byLabel('Reply Later (L)', bar), null, 'Reply Later folds into More below 900px');
      assert.equal(byLabel('Move (V)', bar), null, 'Move folds into More below 900px');
    } finally { globalThis.ResizeObserver = RO; }
  });
});

// Regression: unread messages between read ones made the fold hide messages from both sides of
// the unread one and show the fold row before it, out of order.
describe('foldRuns', () => {
  test('only an unbroken run of more than four collapsed messages folds, where it starts', () => {
    const T = true; const F = false;
    assert.equal(foldRuns([T, T, T, F, T, T, F]).size, 0, 'five collapsed but split by an unread one: nothing folds');
    const two = foldRuns([T, T, T, T, T, F, T, T, T, T, T, T, F]);
    assert.deepEqual(two.get(0), { start: 0, count: 5 });
    assert.deepEqual(two.get(4), { start: 0, count: 5 });
    assert.equal(two.has(5), false);
    assert.deepEqual(two.get(6), { start: 6, count: 6 });
    assert.equal(two.has(12), false);
    assert.equal(foldRuns([T, T, T, T, F]).size, 0, 'four do not fold');
  });
});

describe('Thread on upstream mail: HTML bodies, quoted history, remote images, attachments, folding', () => {
  const account = 'acc-work';
  const row = (i, over = {}) => ({
    id: `h${i}`, account_id: account, folder: 'INBOX', thread_id: 't-html', subject: 'Venue for Friday',
    from_name: i % 2 ? 'Maria Lopez' : 'You', from_email: i % 2 ? 'maria@studio.example' : 'me@example.org',
    to_addresses: JSON.stringify([{ name: 'Prakhar', email: 'me@example.org' }]), cc_addresses: '[]',
    date: new Date(Date.UTC(2026, 8, 10 + i, 9, 0)).toISOString(), snippet: `Message ${i}`, is_read: true, has_attachments: false, ...over,
  });
  const rows = [1, 2, 3, 4, 5].map((i) => row(i)).concat(row(6, { subject: 'Re: Venue for Friday', is_read: false, has_attachments: true, in_reply_to: '<h5@x>' }));
  const bodies = {
    h3: { html: null, text: 'Thursday works for me.\n\nOn Tue, Maria Lopez wrote:\n> Does Thursday work?\n> Or Friday?', attachments: [] },
    h6: {
      html: '<div dir="ltr"><p>See you at the venue at 7.</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div><div class="gmail_quote"><div class="gmail_attr">On Mon, You wrote:</div><blockquote class="gmail_quote">Earlier question about the venue</blockquote></div>',
      text: 'See you at the venue at 7.', attachments: [{ part: '2', filename: 'floor-plan.pdf', type: 'application/pdf', size: 20480 }],
      hasBlockedRemoteImages: true, senderEmail: 'maria@studio.example',
    },
  };
  let requests = [];
  let realFetch;
  beforeEach(() => {
    requests = [];
    realFetch = globalThis.fetch;
    setMockMode(false);
    useV2.setState({ caps: { work: false } });
    globalThis.fetch = async (url) => {
      const u = String(url);
      requests.push(u);
      const ok = (json) => ({ ok: true, status: 200, json: async () => json, headers: { get: () => '' } });
      if (u.startsWith('/api/mail/thread/t-html')) return ok({ messages: rows });
      const m = /^\/api\/mail\/messages\/(h\d)\/body(\?remoteImages=1)?$/.exec(u);
      if (m && bodies[m[1]]) return ok({ ...bodies[m[1]], ...(m[2] ? { hasBlockedRemoteImages: false } : {}) });
      if (m) return ok({ html: null, text: `Body of ${m[1]}`, attachments: [] });
      return { ok: false, status: 404, json: async () => ({ error: 'not in this test' }), headers: { get: () => '' } };
    };
  });
  const restore = async () => { await cleanup(); globalThis.fetch = realFetch; setMockMode(true); };

  test('the latest HTML body renders in the sandboxed frame (no plain text), quoted history behind •••, remote images on consent, attachment chips; five read messages fold', async () => {
    try {
      await render(h(Thread, { props: { item: { threadId: 't-html', messageId: 'h6', subject: 'Re: Venue for Friday', from: { name: 'Maria Lopez', email: 'maria@studio.example' } } } }));
      await settle(80);
      const latest = document.querySelector('article#hw-msg-6');
      assert.ok(latest, 'the latest message is open');
      const frame = latest.querySelector('iframe[srcdoc]');
      assert.ok(frame, 'the HTML body is in a srcdoc frame');
      assert.equal(frame.getAttribute('sandbox'), 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      assert.equal(latest.querySelector('[data-text-body]'), null, 'no plain-text copy beside the frame');
      assert.match(frame.getAttribute('srcdoc'), /See you at the venue at 7\./);
      assert.doesNotMatch(frame.getAttribute('srcdoc'), /Earlier question about the venue/, 'quoted history is folded');
      assert.equal(requests.filter((r) => r.startsWith('/api/mail/messages/h6/body')).length, 1, 'one body request for the latest message');

      // ••• expands the quote in place and folds it again.
      const toggle = latest.querySelector('[data-quote-toggle]');
      assert.equal(toggle.textContent, '•••');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      await click(toggle);
      assert.match(latest.querySelector('iframe[srcdoc]').getAttribute('srcdoc'), /Earlier question about the venue/);
      await click(latest.querySelector('[data-quote-toggle]'));
      assert.doesNotMatch(latest.querySelector('iframe[srcdoc]').getAttribute('srcdoc'), /Earlier question about the venue/);

      // Remote images: a banner, and the images only after "Load images".
      const banner = latest.querySelector('[data-remote-images]');
      assert.match(banner.textContent, /Remote images are hidden to protect your privacy\./);
      assert.ok(byText('button', 'Always for this sender', banner));
      await click(byText('button', 'Load images', banner));
      await settle(40);
      assert.ok(requests.includes('/api/mail/messages/h6/body?remoteImages=1'));
      assert.equal(latest.querySelector('[data-remote-images]'), null);

      // Attachments under the body, with the paperclip count in the header.
      const chips = all('[data-attachments] button[data-attachment]', latest);
      assert.equal(chips.length, 1);
      assert.match(chips[0].textContent, /floor-plan\.pdf/);
      assert.match(chips[0].textContent, /20 KB/);
      assert.ok(byLabel('1 attachment', latest));

      // Five older read messages fold into one row; opening it shows them as 44px rows.
      assert.equal(all('article[id^="hw-msg-"]').length, 1);
      const fold = all('button').find((b) => b.textContent.trim() === '5 earlier messages');
      assert.ok(fold, 'the fold row');
      await click(fold);
      assert.equal(all('article[id^="hw-msg-"]').length, 6);

      // A plain-text message: its quote is kept behind ••• too, not deleted.
      await click(document.querySelector('article#hw-msg-3 button[aria-expanded="false"]'));
      await settle(40);
      const third = document.querySelector('article#hw-msg-3');
      assert.equal(third.querySelector('[data-text-body]').textContent, 'Thursday works for me.');
      assert.equal(third.querySelector('[data-quoted]'), null);
      await click(third.querySelector('[data-quote-toggle]'));
      assert.match(third.querySelector('[data-quoted]').textContent, /Does Thursday work\?/);
    } finally { await restore(); }
  });

  test('smart dark mode: in the dark theme the HTML message carries a sun (Show original colours) that brings back its white card, remembered per sender, and a moon (Darken this message) that undoes it; nothing in the light theme or with the setting Off', async () => {
    const prevTheme = useStore.getState().theme;
    const item = { threadId: 't-html', messageId: 'h6', subject: 'Re: Venue for Friday', from: { name: 'Maria Lopez', email: 'maria@studio.example' } };
    const glyph = () => document.querySelector('article#hw-msg-6 button[data-mail-dark]');
    const frameDoc = () => document.querySelector('article#hw-msg-6 iframe[srcdoc]').getAttribute('srcdoc');
    const card = () => document.querySelector('article#hw-msg-6 [data-html-body]');
    try {
      localStorage.removeItem('hedwig_mail_dark');
      useStore.setState({ theme: 'hedwig-night' });
      await render(h(Thread, { props: { item } }));
      await settle(80);

      // Darkened: the sun, the dark frame document and the content-coloured card.
      let g = glyph();
      assert.ok(g, 'the glyph is in the message header');
      assert.ok(g.closest('header'), 'in the header, beside the date');
      assert.equal(g.getAttribute('data-mail-dark'), 'dark');
      assert.equal(g.getAttribute('aria-label'), 'Show original colours');
      assert.equal(g.getAttribute('title'), 'Show original colours');
      assert.match(frameDoc(), /<html data-hw-dark="pending">/);
      assert.equal(card().hasAttribute('data-dark'), true);
      assert.match(card().getAttribute('style'), /var\(--hw-content/);
      assert.match(card().getAttribute('style'), /border-radius: 10px/);

      // Original colours: the moon, the light document, the white card, and the sender remembered.
      await click(g);
      g = glyph();
      assert.equal(g.getAttribute('data-mail-dark'), 'original');
      assert.equal(g.getAttribute('aria-label'), 'Darken this message');
      assert.doesNotMatch(frameDoc(), /data-hw-dark/);
      assert.match(frameDoc(), /background-color: #ffffff !important/);
      assert.equal(card().hasAttribute('data-dark'), false);
      assert.deepEqual(JSON.parse(localStorage.getItem('hedwig_mail_dark')), { 'maria@studio.example': 'light' });

      // The choice holds for the sender the next time a message from them opens.
      await cleanup();
      await render(h(Thread, { props: { item } }));
      await settle(80);
      assert.equal(glyph().getAttribute('data-mail-dark'), 'original');
      assert.doesNotMatch(frameDoc(), /data-hw-dark/);

      // The moon darkens it again and forgets the choice.
      await click(glyph());
      assert.equal(glyph().getAttribute('data-mail-dark'), 'dark');
      assert.match(frameDoc(), /data-hw-dark="pending"/);
      assert.equal(localStorage.getItem('hedwig_mail_dark'), null);

      // Settings → The look → Dark mode for mail: Off.
      await React.act(async () => { useV2.setState({ prefs: { ...UI_DEFAULTS, mailDark: 'off' } }); });
      await settle();
      assert.equal(glyph(), null);
      assert.doesNotMatch(frameDoc(), /data-hw-dark/);

      // The light theme never darkens and shows no glyph.
      await React.act(async () => { useV2.setState({ prefs: { ...UI_DEFAULTS } }); useStore.setState({ theme: 'hedwig' }); });
      await settle();
      assert.equal(glyph(), null);
      assert.doesNotMatch(frameDoc(), /data-hw-dark/);
      assert.equal(card().getAttribute('style').includes('background: rgb(255, 255, 255)') || card().getAttribute('style').includes('#FFFFFF'), true);
    } finally {
      localStorage.removeItem('hedwig_mail_dark');
      useStore.setState({ theme: prevTheme });
      await restore();
    }
  });
});

describe('quoted history', () => {
  test('splitQuotedHtml folds Gmail, Outlook and cite quotes; a bare blockquote only in a reply; a forward never', () => {
    const gmail = format.splitQuotedHtml('<p>New</p><div class="gmail_quote">On Mon, A wrote:<blockquote>old</blockquote></div>');
    assert.equal(gmail.main.trim(), '<p>New</p>');
    assert.match(gmail.quoted, /old/);
    const outlook = format.splitQuotedHtml('<div>Reply</div><div id="divRplyFwdMsg">From: A</div><div>older thread</div>');
    assert.doesNotMatch(outlook.main, /older thread|From: A/);
    const cite = format.splitQuotedHtml('<p>Yes.</p><div>On Tue, Anna wrote:</div><blockquote type="cite">Can you?</blockquote>');
    assert.doesNotMatch(cite.main, /Anna wrote|Can you/);
    const pull = '<p>Essay</p><blockquote>A pull quote</blockquote><p>More essay</p>';
    assert.equal(format.splitQuotedHtml(pull).quoted, null, 'a newsletter keeps its pull quotes');
    assert.match(format.splitQuotedHtml(pull, { isReply: true }).quoted, /A pull quote/);
    assert.equal(format.splitQuotedHtml('<div class="gmail_quote">---------- Forwarded message ---------<br>From: B</div>').quoted, null);
    assert.equal(format.isReplyMessage('Re: Venue', null), true);
    assert.equal(format.isReplyMessage('SV: Venue', null), true);
    assert.equal(format.isReplyMessage('Weekly digest', null), false);
    assert.equal(format.isReplyMessage('Weekly digest', '<a@b>'), true);
  });

  test('splitQuotedText keeps the history in `quoted`: On … wrote (one or two lines), Original Message, trailing > lines, a -- signature', () => {
    assert.deepEqual(format.splitQuotedText('Yes.\n\nOn Mon, Anna wrote:\n> old'), { main: 'Yes.', quoted: 'On Mon, Anna wrote:\n> old' });
    assert.equal(format.splitQuotedText('Yes.\nOn Mon, 22 Sep 2026 at 10:00, Anna Berg <\nanna@x.example> wrote:\n> old').main, 'Yes.');
    assert.equal(format.splitQuotedText('Fine.\n-----Original Message-----\nFrom: A').main, 'Fine.');
    assert.equal(format.splitQuotedText('Fine.\n\nFrom: Anna\nSent: Monday\nTo: me').main, 'Fine.');
    assert.equal(format.splitQuotedText('Thanks!\n-- \nPrakhar').quoted, '-- \nPrakhar');
    assert.equal(format.splitQuotedText('> a quote first\nthen my answer').quoted, null, 'interleaved: nothing folded');
    assert.equal(format.splitQuotedText('Just text.').quoted, null);
  });
});

describe('Daily Brief', () => {
  after(cleanup);

  test('date line, headline, Ask, Needs you, Waiting on with Nudge, the Records strip, Reading, the question and the Hedwig today line', async () => {
    await render(h(Brief));
    assert.equal(document.querySelector('h1').textContent, 'Three things need you. Two parcels land today.');
    assert.ok(byLabel('Ask your mail'));
    assert.match(text(), /Needs you today/);
    assert.match(text(), /Due Friday, the board pack prints that morning/);
    assert.match(text(), /Waiting on others/);
    const nudges = all('button[aria-label="Nudge"]');
    assert.equal(nudges.length, 2, 'Nudge is a bell icon button per waiting row');
    for (const b of nudges) { assert.equal(b.getAttribute('title'), 'Nudge'); assert.equal(b.textContent, ''); }
    assert.match(text(), /Today, from your Records/);
    assert.match(text(), /NOK 1,240/);
    assert.match(text(), /PDFcontract\.pdf · Lease renewal/, 'a file name moves to the caption, the figure says PDF');
    assert.match(text(), /Benedict's NewsletterWhy on-device models change the browser/, 'the source leads a reading pick');
    assert.match(text(), /Question 1 of 2 today/);
    assert.match(text(), /Hedwig screened 12, bundled 40, rescued 2 from spam, blocked 9\./);
    assert.match(text(), /Written from a template: Tier 2 was not answering\./);
    await click(byText('button', 'Yes, always'));
    assert.doesNotMatch(text(), /Keep her mail in People\?/);
    assert.deepEqual(mock.mockAnswers().at(-1), { id: 'q-anna', optionId: 'yes', always: true }, 'always only from its own button');
  });

  test('Ask falls back to search when the Ask view is not there', async () => {
    const input = byLabel('Ask your mail');
    await React.act(async () => {
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      set.call(input, 'deposit');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    let searched = null;
    useStore.setState({ setSearchQuery: (q) => { searched = q; } });
    await React.act(async () => { input.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(searched, 'deposit');
    assert.equal(useHedwig.getState().viewRequest.id, 'core.list');
  });

  test('the Brief sets no italic and no serif; its figures are the body face, 600, tabular', async () => {
    await cleanup();
    await render(h(Brief));
    await settle(40);
    const styled = all('[style]');
    assert.ok(styled.length > 20);
    for (const el of styled) {
      assert.notEqual(el.style.fontStyle, 'italic', `no italic: ${el.outerHTML.slice(0, 80)}`);
      assert.doesNotMatch(el.style.fontFamily || '', /Instrument|Georgia|--hw-font-display|--hw-font-why|(^|[\s,'"])serif/i, 'no display or serif face');
    }
    const h1 = document.querySelector('h1');
    assert.equal(h1.style.fontSize, '22px');
    assert.equal(h1.style.fontWeight, '600');
    assert.ok(h1.closest('[data-brief-summary]'), 'the headline sits in the summary box');
    const cards = all('[data-brief-card]');
    assert.equal(cards.length, 4, 'the Records cards are boxed');
    for (const card of cards) {
      const figure = card.querySelector('span');
      assert.match(figure.style.fontFamily, /--hw-font-body/, 'figures are the body face, not mono');
      assert.equal(figure.style.fontWeight, '600');
      assert.equal(figure.style.fontSize, '20px');
      assert.match(figure.getAttribute('style'), /font-variant-numeric: tabular-nums/);
    }
    await cleanup();
  });

  test('card and line helpers', () => {
    assert.deepEqual(cardParts({ figure: 'Fri', caption: 'Electricity' }), { figure: 'Fri', caption: 'Electricity' });
    assert.deepEqual(cardParts({ kind: 'attachment', figure: 'Lease-renewal-option-B-final.docx', caption: '24 months' }), { figure: 'DOCX', caption: 'Lease-renewal-option-B-final.docx · 24 months' });
    assert.equal(todayLine({ screened: 1, bundled: 2, rescued: 0, blocked: 3 }), 'Hedwig screened 1, bundled 2, rescued 0 from spam, blocked 3.');
    assert.deepEqual(normaliseStory({ text: 'A [1].', citations: [{ n: 1, messageId: 'x' }] }), { text: 'A [1].', cites: { 1: 'x' } });
    assert.equal(normaliseDeadline({ figure: 'Fri', caption: 'Numbers · Anna', dueAt: '2026-09-25T15:00:00Z', commitmentId: 9, direction: 'they_owe' }).note, 'they');
  });
});

describe('Hedwig today', () => {
  after(cleanup);

  test('lists what Hedwig did in the server\'s words, with Undo only where it can be undone', async () => {
    await render(h(Today));
    assert.match(text(), /Screened Nordlys Travel into Records/);
    assert.match(text(), /Rescued Erik Haugen from spam/);
    assert.match(text(), /Delivered 2 in Deliveries/);
    const undo = all('button[aria-label="Undo"]');
    assert.equal(undo.length, 3, 'a bundle delivery is not undoable');
    for (const b of undo) { assert.equal(b.getAttribute('title'), 'Undo'); assert.equal(b.textContent, '', 'an undo icon, no text'); }
    await click(undo[0]);
    assert.match(text(), /Undone/);
    const log = await mock.mockRequest('GET', '/sort/today');
    assert.equal(log.entries[0].undone, true);
  });

  test('opens with the four-figure strip that replaced the rail paragraph, then Review or undo', async () => {
    await cleanup();
    await render(h(Today));
    const strip = document.querySelector('[data-today-strip]');
    assert.ok(strip, 'the strip is there');
    assert.equal(strip.getAttribute('aria-label'), todayLine({ screened: 12, bundled: 40, rescued: 2, blocked: 9 }));
    assert.equal(strip.compareDocumentPosition(document.querySelector('[role="list"]')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the strip comes before the entries');
    assert.match(strip.textContent, /12screened40bundled2rescued9blocked/);
    const figure = all('span', strip).find((s) => s.textContent === '12');
    assert.equal(figure.style.fontSize, '20px');
    assert.equal(figure.style.fontWeight, '600');
    await click(byText('button', 'Review or undo', strip));
    assert.equal(document.activeElement.getAttribute('aria-label'), 'Undo', 'Review or undo takes focus to the first Undo');
    await cleanup();
  });
});

describe('UI pass', () => {
  after(cleanup);

  test('Hedwig today: an entry with no message (a bundle delivery) has no empty title line', async () => {
    await render(h(Today));
    const row = all('[role="listitem"]').find((li) => li.textContent.includes('Delivered 2 in Deliveries'));
    assert.ok(row, 'the delivery entry is listed');
    assert.equal(all('button', row).length, 0, 'no empty link to a message, no Undo');
    const withMessage = all('[role="listitem"]').find((li) => li.textContent.includes('Screened Nordlys Travel into Records'));
    assert.ok(all('button', withMessage).some((b) => b.textContent.includes('Nordlys Travel')), 'a message entry still links to it');
    await cleanup();
  });

  test('why door: lower-case layer mid-sentence, no signal that repeats the reason', () => {
    const d = { reason: 'A reply in a thread you wrote in', signals: ['A reply in a thread you wrote in', { label: 'You wrote last' }, 'You wrote last', ''] };
    assert.deepEqual(whySignals(d), ['You wrote last']);
    assert.deepEqual(whySignals({ signals: [{ name: 'list' }] }, 'From a list'), ['list']);
    assert.deepEqual(whySignals(null), []);
  });

  test('routing reads as the model in use, not the raw status JSON', () => {
    assert.equal(routingLine({ primary: 'Qwen/Qwen3.8-Flash-Next', fallback: null, active: 'Qwen/Qwen3.8-Flash-Next', degraded: false }), 'Qwen/Qwen3.8-Flash-Next');
    assert.equal(routingLine({ primary: 'Qwen', fallback: 'Gemma', active: 'Qwen', degraded: false }), 'Qwen · falls back to Gemma');
    assert.equal(routingLine({ primary: 'Qwen', fallback: 'Gemma', active: 'Gemma', degraded: true }), 'Gemma · standing in for Qwen');
    assert.equal(routingLine('google/gemma'), 'google/gemma');
    assert.doesNotMatch(routingLine({ primary: 'a', active: 'a' }), /[{}"]/);
  });

  test('j / k with no row focused steps into the list of the focused pane (or with nothing focused)', () => {
    document.body.innerHTML = '<section data-pane-key="p1" tabindex="-1"><div id="list"><button data-row-button id="r1"></button><button data-row-button id="r2"></button></div></section>'
      + '<section data-pane-key="p2" tabindex="-1"><input id="field"></section>';
    const list = document.getElementById('list');
    assert.equal(firstRowFor(document.body, list)?.id, 'r1');
    assert.equal(firstRowFor(document.querySelector('[data-pane-key="p1"]'), list)?.id, 'r1');
    assert.equal(firstRowFor(document.getElementById('r2'), list), null, 'a focused row moves on its own');
    assert.equal(firstRowFor(document.getElementById('field'), list), null, 'typing is never taken');
    assert.equal(firstRowFor(document.querySelector('[data-pane-key="p2"]'), list), null, 'another pane has focus');
    document.body.innerHTML = '';
  });
});

describe('Settings → Hedwig (Simple and Power)', () => {
  after(cleanup);

  test('Simple shows the five controls; Power adds rules with dry run, routing, prompts and the index', async () => {
    await render(h(HedwigSettingsV2));
    assert.equal(all('input[role="switch"]').length, 5, 'the Power mode switch and four Simple switches');
    const powerSwitch = document.querySelector('[data-power-switch]');
    assert.equal(powerSwitch.closest('label').textContent.startsWith('Power mode'), true, 'Power lives in Settings now, not the rail');
    assert.equal(powerSwitch.checked, false);
    assert.match(text(), /Bundle delivery times/);
    await click(all('button[aria-expanded]').find((b) => b.closest('div').textContent.includes('Bundle delivery times')));
    await settle();
    const bills = byLabel('When Bills arrives');
    assert.equal(bills.value, 'daily');
    await React.act(async () => {
      bills.value = 'instant';
      bills.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await settle();
    const bundles = await mock.mockRequest('GET', '/sort/bundles');
    assert.deepEqual(bundles.bundles.find((b) => b.key === 'bills').schedule, { mode: 'instant' });
    assert.doesNotMatch(text(), /Dry run/);
    await click(powerSwitch);
    assert.equal(useV2.getState().prefs.powerMode, true);
    assert.equal(document.querySelector('[data-power-switch]').checked, true);
    await settle(60);
    assert.match(text(), /Receipts to Records/);
    assert.match(text(), /subject contains receipt or subject contains kvittering → stream records, bundle receipts/);
    assert.match(text(), /Routing/);
    assert.match(text(), /sort\.reflex/);
    assert.match(text(), /62%/);
    await click(all('button').find((b) => b.textContent === 'Dry run'));
    await settle();
    assert.match(text(), /Would match 128 messages/);
  });

  test('The look: Dark mode for mail, Smart (the default) or Off, saved as ui.mailDark', async () => {
    await cleanup();
    await render(h(HedwigSettingsV2));
    const group = document.querySelector('[data-mail-dark-setting]');
    assert.ok(group, 'the row is in The look');
    assert.equal(group.getAttribute('aria-label'), 'Dark mode for mail');
    const radios = all('button[role="radio"]', group);
    assert.deepEqual(radios.map((b) => b.textContent), ['Smart', 'Off']);
    assert.deepEqual(radios.map((b) => b.getAttribute('aria-checked')), ['true', 'false']);
    await click(radios[1]);
    assert.equal(useV2.getState().prefs.mailDark, 'off');
    assert.deepEqual(all('button[role="radio"]', document.querySelector('[data-mail-dark-setting]')).map((b) => b.getAttribute('aria-checked')), ['false', 'true']);
    assert.deepEqual(prefsFromFields([{ key: 'ui.mailDark', value: 'off' }]), { mailDark: 'off' });
    assert.deepEqual(prefsFromFields([{ key: 'ui.mailDark', value: 'weird' }]), { mailDark: 'smart' });
  });
});

describe('registration', () => {
  test('every v2 view is registered with the contract ids, the thread yields to the wide Brief', () => {
    const ids = v2Views().map((v) => v.id);
    for (const id of ['hedwig.rail', 'hedwig.stream.people', 'hedwig.stream.reading', 'hedwig.stream.records', 'hedwig.screener', 'hedwig.thread', 'hedwig.brief', 'hedwig.today', 'hedwig.drafts']) {
      assert.ok(ids.includes(id), id);
    }
    const byId = Object.fromEntries(v2Views().map((v) => [v.id, v]));
    assert.equal(byId['hedwig.brief'].wide, true);
    assert.equal(byId['hedwig.thread'].hideBesideWide, true);
  });
});

describe('list and rail (redesign)', () => {
  after(cleanup);
  const annaLabel = 'Anna Berg: Q3 report: can you send the final numbers?, unread';

  test('rowDate: clock today, Yesterday, weekday this week, day and month, and the year when it is not this year', async () => {
    const { rowDate } = await import('./rows.jsx');
    const now = new Date('2026-09-23T12:00:00');
    assert.equal(rowDate(new Date('2026-09-23T09:14:00'), now), '09:14');
    assert.equal(rowDate(new Date('2026-09-22T09:14:00'), now), 'Yesterday');
    assert.equal(rowDate(new Date('2026-09-21T09:14:00'), now), 'Mon');
    assert.equal(rowDate(new Date('2026-09-12T09:14:00'), now), '12 Sep');
    assert.equal(rowDate(new Date('2025-09-12T09:14:00'), now), '12 Sep 2025');
    assert.equal(rowDate('not a date', now), '');
    assert.equal(rowDate(null, now), '');
  });

  test('a row shows the sender\'s avatar initials and the date, the subject and a preview', async () => {
    await render(h(StreamView, { props: { stream: 'people' } }));
    const anna = byLabel(annaLabel);
    const avatar = anna.querySelector('[data-avatar]');
    assert.ok(avatar, 'the row has an avatar');
    assert.equal(avatar.textContent, 'AB');
    assert.equal(avatar.style.width, '36px');
    assert.match(anna.textContent, /09:40/, 'today\'s mail shows its time');
    const jonas = byLabel('Jonas Weber: Re: Weekend plans');
    assert.equal(jonas.querySelector('[data-avatar]').textContent, 'JW');
    assert.match(jonas.textContent, /sounds good, see you there/, 'no TL;DR: the snippet is the preview');
    assert.equal(anna.closest('article').style.minHeight, '76px');
  });

  test('a TL;DR row starts its preview with the sparkles glyph and keeps data-tldr', async () => {
    const { Icon } = await import('../icons.jsx');
    const anna = byLabel(annaLabel);
    const line = anna.querySelector('[data-tldr]');
    assert.equal(line.textContent, 'Wants the final Q3 numbers by Thursday evening for Friday’s board pack.');
    const glyph = line.previousElementSibling;
    assert.equal(glyph?.tagName.toLowerCase(), 'svg', 'a glyph sits right before the TL;DR');
    const ref = document.createElement('div');
    const refRoot = createRoot(ref);
    await React.act(async () => { refRoot.render(h(Icon, { name: 'sparkles', size: 11 })); });
    assert.equal(glyph.innerHTML, ref.querySelector('svg').innerHTML, 'it is the sparkles glyph');
    assert.equal(glyph.getAttribute('width'), '11');
    await React.act(async () => refRoot.unmount());
    const jonas = byLabel('Jonas Weber: Re: Weekend plans');
    assert.equal(jonas.querySelector('svg'), null, 'no TL;DR, no sparkle');
  });

  test('the reason line of a Needs-you row has the alert glyph and opens the why door; the hover buttons are Done, Snooze and Reply Later', async () => {
    const why = byLabel('Why: Asked for the report by Friday. Open to see or change');
    assert.ok(why.querySelector('svg'), 'the reason has a glyph');
    assert.notEqual(why.style.fontStyle, 'italic');
    const article = byLabel(annaLabel).closest('article');
    const actions = article.querySelector('[data-row-actions]');
    assert.equal(actions.style.visibility, 'hidden', 'hidden until hover or focus');
    await React.act(async () => { article.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    assert.equal(article.querySelector('[data-row-actions]').style.visibility, 'visible');
    const labels = all('button', actions).map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(labels.slice(0, 2), ['Done (E)', 'Snooze']);
    assert.equal(labels.includes('Reply Later (L)'), useV2.getState().caps.work === true, 'Reply Later when the work routes are there');
    assert.equal(all('button', actions)[0].style.height, '24px');
  });

  test('the list header has the search field above the title; a question goes to Ask, anything else to search', async () => {
    const input = document.querySelector('input[data-list-search]');
    assert.ok(input, 'the search field is in the list header');
    assert.equal(input.getAttribute('aria-label'), 'Search or ask');
    assert.equal(input.getAttribute('placeholder'), 'Search or ask');
    assert.ok(input.compareDocumentPosition(document.querySelector('h1')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'above the title');
    assert.ok(byLabel('Open the command palette'), 'with the ⌘K hint');
    assert.ok(byLabel('Filter and sort'), 'and the filter button on the title row');
    let searched = null;
    useStore.setState({ setSearchQuery: (q) => { searched = q; } });
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'deposit');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await React.act(async () => { input.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.equal(searched, 'deposit');
    assert.equal(useHedwig.getState().viewRequest.id, 'core.list');
  });

  test('the filter menu narrows the list to unread', async () => {
    const before = all('[data-row-button]').length;
    await click(byLabel('Filter and sort'));
    await click(all('[role="menuitemcheckbox"]').find((b) => b.textContent === 'Unread'));
    const after = all('[data-row-button]');
    assert.ok(after.length < before, 'fewer rows');
    assert.ok(after.every((b) => /, unread$/.test(b.getAttribute('aria-label'))), 'only unread rows');
    await cleanup();
  });

  test('the rail: places with glyphs, no "screened" paragraph, no Power or search, and the account line in the footer', async () => {
    const Rail = (await import('./Rail.jsx')).default;
    await useV2.getState().refreshCounts();
    await render(h(Rail, {}));
    const nav = document.querySelector('nav');
    assert.doesNotMatch(nav.textContent, /screened/i, 'the Hedwig today paragraph moved to Today');
    assert.doesNotMatch(nav.textContent, /Power/);
    assert.equal(nav.querySelector('input'), null, 'search moved to the list header');
    assert.ok(byLabel('New message (C)', nav), 'compose sits in the top row');
    const people = all('button.hw-nav', nav).find((b) => b.textContent.startsWith('People'));
    assert.ok(people.querySelector('svg'), 'each place has a glyph');
    assert.equal(people.style.height, '28px');
    assert.equal(people.lastElementChild.style.color, 'var(--hw-attention-ink, #A8420F)', 'the Needs-you count is in the attention ink');
    assert.deepEqual(all('h2', nav).map((x) => x.textContent), ['Later', 'Hedwig'], 'Later always holds Drafts; Reply Later and the rest join it with the work routes');
    assert.ok(all('button.hw-nav', nav).some((b) => b.textContent.startsWith('Drafts')), 'Drafts under Later');
    const account = nav.querySelector('footer [data-account-line]');
    assert.ok(account, 'the account line is in the footer');
    assert.equal(account.querySelector('[data-avatar]').style.width, '20px');
    assert.match(account.textContent, /me@example\.org$/, 'one account: its address');
    useStore.getState().setAccounts?.([{ id: 'acc-work', email_address: 'me@example.org', enabled: true, aliases: [] }, { id: 'acc-home', email_address: 'home@example.org', enabled: true, aliases: [] }]);
    await settle();
    assert.match(nav.querySelector('footer [data-account-line]').textContent, /2 accounts$/);
    useStore.getState().setAccounts?.([{ id: 'acc-work', email_address: 'me@example.org', enabled: true, aliases: [] }]);
    await settle();
    assert.match(nav.querySelector('footer').textContent, /Up to date/, 'one quiet status line');
    await cleanup();
  });
});

after(async () => { await cleanup(); dom.window.close(); });
