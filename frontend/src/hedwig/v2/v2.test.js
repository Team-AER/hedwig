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
const Brief = (await import('./Brief.jsx')).default;
const Today = (await import('./Today.jsx')).default;
const HedwigSettingsV2 = (await import('./HedwigSettings.jsx')).default;
const { v2Views, v2SessionAllowed, startV2Session, stopV2Session, isV2SessionRunning } = await import('./index.js');

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

beforeEach(() => { mock.resetMock(); notifications.length = 0; useV2.setState({ selected: null, prefs: { ...UI_DEFAULTS }, caps: { work: null } }); });
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
  test('the Hedwig themes carry the v2 palette from the contract, light and dark', () => {
    const light = tokens.hwVarsFor('hedwig');
    assert.equal(light['--hw-paper'], '#F4F2EC');
    assert.equal(light['--hw-ink'], '#17181A');
    assert.equal(light['--hw-accent'], '#E0561A');
    assert.equal(light['--hw-accent-ink'], '#9E3B0E');
    assert.equal(light['--hw-on-accent'], '#FFFFFF');
    assert.equal(light['--hw-glass'], 'rgba(255,255,255,0.52)');
    const dark = tokens.hwVarsFor('hedwig-night');
    assert.equal(dark['--hw-paper'], '#111214');
    assert.equal(dark['--hw-accent'], '#FF7A40');
    assert.equal(dark['--hw-edge'], 'rgba(255,255,255,0.10)');
    assert.equal(dark['--hw-on-accent'], '#111214', 'dark icons on the bright dark-theme accent');
    assert.match(light['--hw-font-why'], /Instrument Serif/);
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
    ]), { powerMode: true, blur: 48, accent: '#E0561A' });
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
    assert.equal(door.style.fontStyle, 'italic');
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
    assert.match(text(), /5 need you/);
    const needs = document.querySelector('section[aria-label="Needs you"]');
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

    await click(byText('button', 'Accept all'));
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
});

describe('Thread', () => {
  after(cleanup);

  test('story with citations, deadline slip, earlier fold, latest message, why with Change, quick replies and the reply bar', async () => {
    const item = (await mock.mockRequest('GET', '/sort/stream/people')).items.find((i) => i.messageId === 'm-anna');
    await render(h(Thread, { props: { item } }));
    await settle(60);
    assert.equal(document.querySelector('h2').textContent, 'Q3 report: can you send the final numbers?');
    assert.match(text(), /Anna Berg and you · 5 messages · Work/);
    const story = document.querySelector('section[aria-label="The story so far"]');
    assert.equal(all('button[aria-label^="Message "]', story).length, 3);
    // Citation 1 names m-anna-2 (the second message), so it opens the earlier messages.
    await click(byLabel('Message 1', story));
    assert.match(text(), /Two revenue lines look off/);
    await click(all('button[aria-expanded]').find((b) => b.textContent.includes('earlier messages')));
    const slip = document.querySelector('[aria-label="Deadline"]');
    assert.match(slip.textContent, /Final Q3 numbers/);
    assert.match(slip.textContent, /Deadline, asked by Anna/);
    assert.match(text(), /4 earlier messages/);
    assert.match(text(), /the board pack goes to print Friday morning/);
    assert.match(text(), /In People because you reply to Anna within an hour\./);
    assert.match(text(), /1 tracker blocked/);
    for (const label of ['Done', 'Reply Later', 'Snooze', 'Set Aside', 'Draft in my voice', 'Send']) {
      assert.ok(all('button').some((b) => b.textContent.trim() === label), `${label} button`);
    }
    await click(all('button[aria-expanded]').find((b) => b.textContent.includes('earlier messages')));
    await settle();
    assert.match(text(), /Two revenue lines look off/);

    await click(byText('button', 'Sending them now.'));
    const input = byLabel('Reply to Anna');
    assert.equal(input.value, 'Sending them now.');
    await click(byText('button', 'Draft in my voice'));
    await settle();
    assert.match(input.value, /Hi Anna, yes/);
    assert.ok(mock.mockRequests().includes('POST /work/draft'));
    const submit = async () => { await React.act(async () => { input.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }); await settle(); };
    // The send guard warns first (a mentioned attachment, nothing attached); a second press sends.
    await React.act(async () => {
      const set = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      set.call(input, 'The numbers are attached.');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
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
    const item = (await mock.mockRequest('GET', '/sort/stream/people')).items.find((i) => i.messageId === 'm-anna');
    await render(h(Thread, { props: { item } }));
    await settle(60);
    for (const label of ['Reply Later', 'Set Aside', 'Draft in my voice']) assert.equal(byText('button', label), undefined, label);
    assert.ok(byText('button', 'Done'));
    assert.doesNotMatch(text(), /Not available yet/);
  });

  test('Reply Later posts the thread to /work/lists/reply_later', async () => {
    await cleanup();
    const item = (await mock.mockRequest('GET', '/sort/stream/people')).items.find((i) => i.messageId === 'm-anna');
    await render(h(Thread, { props: { item } }));
    await settle(60);
    await click(byText('button', 'Reply Later'));
    assert.equal(notifications.at(-1).title, 'Added to Reply Later.');
    const list = await mock.mockRequest('GET', '/work/lists/replyLater');
    assert.ok(list.items.some((i) => i.threadId === 't-anna'));
    assert.equal(useV2.getState().counts.replyLater, 4);
  });

  test('help me write off hides quick replies and drafting', async () => {
    await cleanup();
    useV2.setState({ prefs: { ...UI_DEFAULTS, helpMeWrite: false } });
    const item = (await mock.mockRequest('GET', '/sort/stream/people')).items.find((i) => i.messageId === 'm-anna');
    await render(h(Thread, { props: { item } }));
    await settle(60);
    assert.equal(byText('button', 'Sending them now.'), undefined);
    assert.equal(byText('button', 'Draft in my voice'), undefined);
  });

  test('no selection is a quiet line, not an error', async () => {
    await cleanup();
    await render(h(Thread, { props: {} }));
    assert.match(text(), /Pick a conversation to read it here\./);
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
    assert.equal(all('button').filter((b) => b.textContent === 'Nudge').length, 2);
    assert.match(text(), /Today, from your Records/);
    assert.match(text(), /NOK 1,240/);
    assert.match(text(), /PDFcontract\.pdf · Lease renewal/, 'a file name moves to the caption, the figure says PDF');
    assert.match(text(), /Benedict's NewsletterWhy on-device models change the browser/, 'the source leads a reading pick');
    assert.match(text(), /Question 1 of 2 today/);
    assert.match(text(), /Hedwig screened 12, bundled 40, rescued 2 from spam, blocked 9\./);
    assert.match(text(), /Compiled from your mail, no model call\./);
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
    const undo = all('button').filter((b) => b.textContent === 'Undo');
    assert.equal(undo.length, 3, 'a bundle delivery is not undoable');
    await click(undo[0]);
    assert.match(text(), /Undone/);
    const log = await mock.mockRequest('GET', '/sort/today');
    assert.equal(log.entries[0].undone, true);
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
    assert.equal(all('input[role="switch"]').length, 4);
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
    await click(byText('button', 'Turn on Power'));
    assert.equal(useV2.getState().prefs.powerMode, true);
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
});

describe('registration', () => {
  test('every v2 view is registered with the contract ids, the thread yields to the wide Brief', () => {
    const ids = v2Views().map((v) => v.id);
    for (const id of ['hedwig.rail', 'hedwig.stream.people', 'hedwig.stream.reading', 'hedwig.stream.records', 'hedwig.screener', 'hedwig.thread', 'hedwig.brief', 'hedwig.today']) {
      assert.ok(ids.includes(id), id);
    }
    const byId = Object.fromEntries(v2Views().map((v) => [v.id, v]));
    assert.equal(byId['hedwig.brief'].wide, true);
    assert.equal(byId['hedwig.thread'].hideBesideWide, true);
  });
});

after(async () => { await cleanup(); dom.window.close(); });
