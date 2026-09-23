// Component and unit tests for the Hedwig v2 wave-2 frontend: Records cards on messages and in
// Records, the ledgers, Ask on the saved-answer backend, agent citations, Waiting On with nudges,
// the reply bar's "remind me if no reply", and the why door's sender scope. Rendered against the
// mock backend (mock.js), which answers with the shapes of backend/src/hedwig/{cards,ask2,work}.
//
// Same harness as v2.test.js. Run with: node --test src/hedwig/v2/wave2.test.js
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
const fetched = [];
globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: false, status: 404, json: async () => ({ error: 'not in this test' }), headers: { get: () => '' } }; };

// Browser bits the card actions use: the clipboard, window.open, and a link click for downloads.
let copied = null;
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } }, configurable: true });
let opened = null;
dom.window.open = (url) => { opened = url; return null; };
const downloads = [];
dom.window.HTMLAnchorElement.prototype.click = function click() { downloads.push({ name: this.download, href: this.href }); };

const React = await import('react');
const h = React.createElement;
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../../store/index.js');
const { setMockMode } = await import('./client.js');
const mock = await import('./mock.js');
const { useV2, UI_DEFAULTS } = await import('./state.js');
const { useHedwig } = await import('../store.js');
const cards = await import('./cards.js');
const { sortRows, totalFigures, ledgerColumns } = await import('./Ledger.jsx');
const { hasListKey, scopeOptions } = await import('./WhyDoor.jsx');
const { reduceAsk2, fromSaved, historyMark, askStarted, ASK2_INITIAL } = await import('./ask.js');
const { reduceAgent, AGENT_INITIAL, sourcesFromRun, citeResolver } = await import('../views/helpers.js');
const { askedLabel } = await import('./Waiting.jsx');
const Thread = (await import('./Thread.jsx')).default;
const StreamView = (await import('./StreamView.jsx')).default;
const Ledger = (await import('./Ledger.jsx')).default;
const Waiting = (await import('./Waiting.jsx')).default;
const Brief = (await import('./Brief.jsx')).default;
const Ask = (await import('../views/Ask.jsx')).default;
const { Markdown } = await import('../views/ui.jsx');
const { v2Views } = await import('./index.js');

setMockMode(true);
const notifications = [];
const composed = [];
useStore.setState({ addNotification: (n) => notifications.push(n), openCompose: (d) => composed.push(d) });
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
async function type(input, value) {
  const proto = input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function submit(form) {
  await React.act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  await settle(60);
}
const all = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const byText = (sel, text, scope = document) => all(sel, scope).find((e) => e.textContent.trim() === text);
const byLabel = (label, scope = document) => scope.querySelector(`[aria-label="${label}"]`);
const text = () => document.body.textContent;
const requests = () => mock.mockRequests();

async function cleanup() {
  if (root) await React.act(async () => root.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
}

beforeEach(async () => {
  await cleanup();
  mock.resetMock();
  mock.mockRequests({ clear: true });
  notifications.length = 0;
  composed.length = 0;
  copied = null;
  opened = null;
  downloads.length = 0;
  useV2.setState({ selected: null, prefs: { ...UI_DEFAULTS }, caps: { work: true }, settingsFields: null });
});

const recordsItem = async (messageId) => (await mock.mockRequest('GET', '/sort/stream/records?limit=100')).items.find((i) => i.messageId === messageId);
const peopleItem = async (messageId) => (await mock.mockRequest('GET', '/sort/stream/people?limit=100')).items.find((i) => i.messageId === messageId);

// ── cards: pure helpers ──────────────────────────────────────────────────────
describe('card helpers', () => {
  const now = new Date(2026, 8, 23, 9, 0);
  test('each kind reads as a figure and a caption', () => {
    assert.deepEqual(
      cards.cardFigure({ kind: 'delivery', fields: { carrier: 'DHL', status: 'out_for_delivery', expectedDate: '2026-09-23', item: 'Running shoes' } }, now),
      { figure: 'Today', caption: 'DHL, out for delivery', sub: 'Running shoes' },
    );
    assert.equal(cards.cardFigure({ kind: 'delivery', fields: { carrier: 'Posten', status: 'in_transit', expectedDate: '2026-09-24', expectedBy: '16:00' } }, now).caption, 'Posten, by 16:00');
    assert.equal(cards.cardFigure({ kind: 'delivery', fields: { carrier: 'Posten', status: 'in_transit', expectedDate: '2026-09-24' } }, now).figure, 'Tomorrow');
    const bill = cards.cardFigure({ kind: 'invoice', fields: { issuer: 'Fjordkraft', amount: 1240, currency: 'NOK', dueDate: '2026-09-23' } }, now);
    assert.match(bill.figure, /NOK\s1,240/);
    assert.equal(bill.caption, 'Fjordkraft, due Today');
    const code = cards.cardFigure({ kind: 'code', fields: { code: '482913', service: 'Vipps' } }, now);
    assert.equal(code.figure, '482913');
    assert.equal(code.code, true);
    const sub = cards.cardFigure({ kind: 'subscription', fields: { merchant: 'Spotify', amount: 129, currency: 'NOK', cadence: 'monthly', nextRenewal: '2026-10-17' } }, now);
    assert.equal(sub.caption, 'Spotify, monthly');
    assert.match(sub.sub, /^Renews (17 Oct|Oct 17)$/);
    assert.equal(cards.cardFigure({ kind: 'event', fields: { title: 'Dentist', start: new Date(2026, 8, 24, 10, 30).toISOString() } }, now).figure, '10:30');
  });

  test('an edit sends only what changed, clears emptied fields, and times go out as instants', () => {
    const c = { kind: 'delivery', fields: { carrier: 'DHL', item: 'Shoes', expectedDate: '2026-09-23' } };
    assert.equal(cards.editPatch(c, { carrier: 'DHL', item: 'Shoes', expectedDate: '2026-09-23' }), null);
    assert.deepEqual(cards.editPatch(c, { carrier: 'DHL', item: 'Boots', expectedDate: '' }), { fields: { item: 'Boots', expectedDate: null } });
    const ev = { kind: 'event', fields: { start: new Date(2026, 8, 30, 10, 30).toISOString() } };
    assert.equal(cards.inputValue(ev, 'start'), '2026-09-30T10:30');
    assert.equal(cards.editPatch(ev, { start: '2026-09-30T11:00' }).fields.start, new Date(2026, 8, 30, 11, 0).toISOString());
    assert.equal(cards.editPatch({ kind: 'invoice', fields: { amount: 10 } }, { amount: '12,50' }).fields.amount, 12.5);
  });

  test('G\'s reminder becomes F\'s reminder body, on the thread when there is one', () => {
    const r = { title: 'Pay Fjordkraft', remindAt: '2026-09-24T07:00:00.000Z', note: 'From "Invoice"', messageId: 'm', threadId: 't-1', source: {} };
    assert.deepEqual(cards.reminderBody(r), { threadId: 't-1', note: 'Pay Fjordkraft', until: '2026-09-24T07:00:00.000Z' });
    assert.deepEqual(cards.reminderBody({ ...r, threadId: null }), { note: 'Pay Fjordkraft · From "Invoice"', until: '2026-09-24T07:00:00.000Z' });
    assert.equal(cards.reminderBody({ title: 'x' }), null);
    assert.equal(cards.safeUrl('javascript:alert(1)'), null);
    assert.equal(cards.safeUrl('https://dhl.example/t'), 'https://dhl.example/t');
  });

  test('a bundle summary counts its cards, what arrives today and what is due this week', () => {
    const list = [
      { id: 1, kind: 'delivery', fields: { status: 'out_for_delivery' } },
      { id: 2, kind: 'delivery', fields: { expectedDate: '2026-09-23', status: 'in_transit' } },
      { id: 3, kind: 'delivery', fields: { status: 'delivered', expectedDate: '2026-09-23' } },
      { id: 4, kind: 'invoice', fields: { dueDate: '2026-09-26' } },
    ];
    assert.equal(cards.bundleCardSummary(list, now), '3 deliveries, 2 arriving today · 1 bill, 1 due this week');
    assert.equal(cards.bundleCardSummary([], now), '');
    const by = cards.cardsByMessage([{ id: 'a', messageId: 'm1', messageIds: ['m1', 'm2'] }, { id: 'b', messageId: 'm3', messageIds: [], dismissedAt: 'x' }]);
    assert.deepEqual([...by.keys()], ['m1', 'm2']);
    assert.deepEqual(cards.cardsForItems([{ messageId: 'm1' }, { messageId: 'm2' }], by).map((c) => c.id), ['a'], 'a card merged from two messages counts once');
  });
});

// ── cards on a message ───────────────────────────────────────────────────────
describe('cards in the thread', () => {
  test('a delivery card: figure and caption above the message, a field shows its source, correct, actions, dismiss', async () => {
    await render(h(Thread, { props: { item: await recordsItem('m-dhl') } }));
    await settle(60);
    const slip = byLabel('Today · DHL, out for delivery');
    assert.ok(slip, 'the slip is labelled with its figure and caption');
    assert.match(slip.textContent, /Running shoes/);
    const article = document.querySelector('article#hw-msg-1');
    assert.ok(slip.compareDocumentPosition(article) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the card sits above the message');

    // Tap a field: the sentence it came from.
    const tracking = byText('button', 'JD014600006251', slip);
    await click(tracking);
    assert.equal(tracking.getAttribute('aria-expanded'), 'true');
    assert.match(slip.textContent, /“Tracking number JD014600006251”/);

    // Actions from GET /cards/:id/actions.
    await click(byText('button', 'Track parcel', slip));
    assert.equal(opened, 'https://www.dhl.example/track?id=JD014600006251');
    await click(byText('button', 'Add to calendar', slip));
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].name, /\.ics$/);
    assert.match(downloads[0].href, /^blob:/);
    await click(byText('button', 'Remind me', slip));
    assert.ok(requests().includes('POST /work/lists/reminder'));
    assert.match(notifications.at(-1).title, /^Reminder set for /);

    // Correct: only the changed field goes out, and the edit is marked as the user's.
    await click(byText('button', 'Correct', slip));
    const item = byLabel('Correct this card').querySelector('input[id$="-item"]');
    assert.equal(item.value, 'Running shoes');
    await type(item, 'Trail shoes');
    await submit(byLabel('Correct this card'));
    assert.ok(requests().includes('PATCH /cards/c-dhl'));
    const stored = await mock.mockRequest('GET', '/cards/c-dhl');
    assert.equal(stored.fields.item, 'Trail shoes');
    assert.equal(stored.sources.item.via, 'user');
    assert.equal(notifications.at(-1).title, 'Card corrected.');
    const shoes = byText('button', 'Trail shoes');
    await click(shoes);
    assert.match(shoes.closest('dd').textContent, /You changed this from Running shoes\./);

    // Dismiss hides it.
    await click(byText('button', 'Dismiss', byLabel('Today · DHL, out for delivery')));
    assert.equal(byLabel('Today · DHL, out for delivery'), null);
    assert.ok((await mock.mockRequest('GET', '/cards/c-dhl')).dismissedAt);
  });

  test('a code is shown large and copies; without the work routes there is no reminder action', async () => {
    useV2.setState({ caps: { work: false } });
    await render(h(Thread, { props: { item: await recordsItem('m-vipps') } }));
    await settle(60);
    const code = byLabel('Copy the code 482913');
    assert.ok(code);
    await click(code);
    assert.equal(copied, '482913');
    assert.equal(notifications.at(-1).title, 'Copied.');
    const invoice = await mock.mockRequest('GET', '/cards/c-fjordkraft/actions');
    assert.ok(invoice.actions.some((a) => a.id === 'reminder'), 'the route offers a reminder');
    await cleanup();
    await render(h(Thread, { props: { item: await recordsItem('m-fjordkraft') } }));
    await settle(60);
    await settle(60);
    const slip = document.querySelector('section[aria-label="What Hedwig read from this message"]');
    assert.ok(byText('button', 'Add to calendar', slip));
    assert.equal(byText('button', 'Remind me', slip), undefined, 'hidden: a reminder needs the work module');
  });
});

describe('cards in Records', () => {
  test('a closed bundle says what its cards say and shows their figures', async () => {
    await render(h(StreamView, { props: { stream: 'records' } }));
    await settle(60);
    const deliveries = all('button[aria-expanded]').find((b) => b.textContent.includes('Deliveries'));
    assert.match(deliveries.textContent, /2 deliveries, 2 arriving today · DHL, Posten/);
    assert.match(deliveries.textContent, /TodayDHL, out for delivery/);
    const bills = all('button[aria-expanded]').find((b) => b.textContent.includes('Bills'));
    assert.match(bills.textContent, /2 bills, 1 due this week/, 'Telia is due in 8 days');
    await click(deliveries);
    assert.doesNotMatch(deliveries.textContent, /TodayDHL/, 'open, the rows show instead of the figures');
  });
});

// ── ledgers ─────────────────────────────────────────────────────────────────
describe('ledgers', () => {
  test('sorting keeps nulls last both ways; totals read as figures', () => {
    const rows = [{ id: 1, amount: 5 }, { id: 2, amount: null }, { id: 3, amount: 20 }];
    assert.deepEqual(sortRows(rows, 'amount', 'desc').map((r) => r.id), [3, 1, 2]);
    assert.deepEqual(sortRows(rows, 'amount', 'asc').map((r) => r.id), [1, 3, 2]);
    const [nok] = totalFigures('purchases', [{ currency: 'NOK', total: 3286, count: 4 }]);
    assert.match(nok.figure, /NOK\s3,286/);
    assert.equal(nok.caption, '4 purchases');
    const [subs] = totalFigures('subscriptions', [{ currency: 'NOK', total: 308, monthly: 308, count: 2 }]);
    assert.equal(subs.caption, 'a month');
    assert.equal(subs.sub, '2 subscriptions');
    assert.ok(ledgerColumns('travel').some((c) => c.id === 'route' && !c.sort), 'a column the route cannot sort by is not sortable');
  });

  test('purchases: a table with totals by currency, sortable by its headers', async () => {
    await render(h(Ledger, { props: { kind: 'purchases' } }));
    assert.equal(document.querySelector('h1').textContent, 'Purchases');
    const totals = byLabel('Totals');
    assert.match(totals.textContent, /NOK\s3,286/);
    assert.match(totals.textContent, /4 purchases/);
    assert.match(totals.textContent, /£34\.99/);
    const firstCell = () => document.querySelector('tbody tr td:nth-child(2)').textContent;
    assert.equal(firstCell(), 'Fjordkraft', 'newest first by default (an invoice dates from its message)');
    const amount = byText('th button', 'Amount');
    await click(amount);
    assert.equal(amount.closest('th').getAttribute('aria-sort'), 'descending');
    assert.equal(firstCell(), 'Fjellsport');
    await click(byText('th button', 'Amount ↓'));
    assert.equal(document.querySelector('th[aria-sort]').getAttribute('aria-sort'), 'ascending');
    assert.equal(firstCell(), 'Amazon');
    assert.equal(byText('th', 'Reference').querySelector('button'), null, 'not a sort the route offers');
  });

  test('subscriptions show the monthly total; the rail and palette reach every ledger', async () => {
    await render(h(Ledger, { props: { kind: 'subscriptions' } }));
    const totals = byLabel('Totals');
    assert.match(totals.textContent, /NOK\s308/);
    assert.match(totals.textContent, /a month/);
    assert.match(totals.textContent, /\$5/);
    assert.equal(document.querySelector('tbody tr td').textContent, 'Netflix', 'next renewal first');
    const ids = v2Views().map((v) => v.id);
    assert.ok(ids.includes('hedwig.ledger') && ids.includes('hedwig.waiting'));
  });
});

// ── Ask ─────────────────────────────────────────────────────────────────────
describe('Ask', () => {
  test('answer state: events fold in, and a saved answer reads back the same way', () => {
    let s = askStarted('Deposit?', { followUpOf: 'a-1' });
    s = reduceAsk2(s, { type: 'sources', sources: [{ n: 1, message: { id: 'm' } }], askLogId: 'a-2' });
    s = reduceAsk2(s, { type: 'delta', text: 'It is ' });
    s = reduceAsk2(s, { type: 'done', answer: 'It is fine [1].', citations: [1], unsupported: false, notFound: false, invalidCitations: [3], askLogId: 'a-2' });
    assert.equal(s.status, 'done');
    assert.equal(s.id, 'a-2');
    assert.equal(s.followUpOf, 'a-1');
    assert.deepEqual(s.invalidCitations, [3]);
    const saved = fromSaved({ id: 'a-9', question: 'Q', status: 'done', answer: 'A [1]', citations: [1], sources: [{ n: 1, message: { id: 'm' } }, { n: 2, message: null }], notFound: false, unsupported: true, feedback: { wrong: true } });
    assert.equal(saved.saved, true);
    assert.equal(saved.sources.length, 1, 'a source the user can no longer see is left out');
    assert.equal(historyMark({ feedback: { wrong: true }, unsupported: true }), 'wrong');
    assert.equal(historyMark({ status: 'done', notFound: true }), 'notFound');
    assert.equal(reduceAsk2(ASK2_INITIAL, { type: 'error', error: 'x' }).status, 'error');
  });

  test('history opens a saved answer with its citations instead of asking again', async () => {
    await render(h(Ask, { props: {} }));
    const history = byLabel('Earlier questions');
    assert.match(history.textContent, /What did the landlord say about the deposit\?/);
    assert.match(history.textContent, /marked wrong/);
    assert.match(history.textContent, /nothing found/);
    await click(all('button', history).find((b) => b.textContent.includes('the deposit')));
    assert.ok(requests().includes('GET /context/ask/a-deposit'));
    assert.ok(!requests().some((r) => r.startsWith('STREAM')), 'no new question');
    assert.match(text(), /carries over if you renew/);
    assert.match(text(), /Saved answer from/);
    assert.equal(all('.hw-cite').length, 2);
    assert.match(byLabel('Sources').textContent, /Move-in checklist and deposit/);

    await click(all('button', history).find((b) => b.textContent.includes('passport')));
    assert.match(text(), /Nothing in your mail answers this\./);
    assert.match(text(), /no model was asked/);
    assert.equal(byLabel('Sources'), null);
    await click(all('button', history).find((b) => b.textContent.includes('electricity')));
    assert.match(text(), /Unsupported/);
    assert.match(text(), /cites none of your messages/);
    assert.match(text(), /Marked wrong\. Hedwig learns from this\./);
  });

  test('a new question streams; a follow-up names the answer it follows; citations to nothing are reported; Wrong answer posts feedback', async () => {
    await render(h(Ask, { props: {} }));
    const input = byLabel('Ask your mail');
    await type(input, 'What is the deposit? cite it');
    await submit(input.closest('form'));
    await settle(120);
    assert.ok(requests().includes('STREAM /context/ask'));
    assert.match(text(), /deposit stays with the deposit scheme/);
    assert.match(text(), /Citation \[4\] named no source and was removed\./);

    const follow = byLabel('Ask a follow-up');
    assert.ok(follow, 'after an answer the field asks a follow-up');
    assert.match(text(), /Following up on “What is the deposit\? cite it”/);
    await type(follow, 'and if I renew?');
    await submit(follow.closest('form'));
    await settle(120);
    const log = await mock.mockRequest('GET', '/context/ask/history');
    assert.equal(log[0].question, 'and if I renew?');
    assert.equal(log[0].followUpOf, log[1].id);
    assert.match(text(), /Renewing keeps the same deposit/);

    await click(byText('button', 'Wrong answer'));
    await type(byLabel('What was wrong with the answer'), 'It is not the same deposit');
    await submit(byLabel('What was wrong with the answer').closest('form'));
    assert.ok(requests().includes(`POST /context/ask/${log[0].id}/feedback`));
    assert.deepEqual((await mock.mockRequest('GET', `/context/ask/${log[0].id}`)).feedback.note, 'It is not the same deposit');
    assert.match(text(), /Marked wrong\. Hedwig learns from this\./);
    await click(byText('button', 'Undo'));
    assert.equal((await mock.mockRequest('GET', `/context/ask/${log[0].id}`)).feedback.wrong, false);
  });

  test('nothing found says so plainly and makes no model call', async () => {
    await render(h(Ask, { props: {} }));
    const input = byLabel('Ask your mail');
    await type(input, 'When does my passport expire?');
    await submit(input.closest('form'));
    await settle(80);
    assert.match(text(), /Nothing in your mail answers this\./);
    assert.doesNotMatch(text(), /couldn't find anything relevant/, 'our line, not the canned sentence');
    assert.equal(byText('button', 'Wrong answer'), undefined);
  });
});

// ── Agent citations ─────────────────────────────────────────────────────────
describe('agent citations', () => {
  const RUN = {
    messages: [
      { role: 'user', content: 'find the lease' },
      { role: 'tool', name: 'search_mail', content: JSON.stringify({ results: [{ n: 1, id: 'aaa' }, { n: 2, id: 'bbb' }] }) },
      { role: 'tool', name: 'search_mail', content: JSON.stringify({ results: [{ n: 2, id: 'bbb' }, { n: 3, id: 'ccc' }] }) },
      { role: 'tool', name: 'read_message', content: JSON.stringify({ results: [{ n: 9, id: 'zzz' }] }) },
    ],
  };

  test('the done event carries the run\'s sources; a stored run rebuilds them from its search_mail results', () => {
    const s = reduceAgent({ ...AGENT_INITIAL, status: 'running' }, { type: 'done', runId: 'r', status: 'done', sources: [{ n: 1, id: 'aaa' }] });
    assert.deepEqual(s.sources, [{ n: 1, id: 'aaa' }]);
    assert.deepEqual(reduceAgent(s, { type: 'done', runId: 'r' }).sources, [{ n: 1, id: 'aaa' }], 'a done without sources keeps them');
    assert.deepEqual(sourcesFromRun(RUN), [{ n: 1, id: 'aaa' }, { n: 2, id: 'bbb' }, { n: 3, id: 'ccc' }]);
    const resolve = citeResolver(sourcesFromRun(RUN));
    assert.equal(resolve(3), 'ccc');
    assert.equal(resolve(9), null);
  });

  test('[n] opens the message the run numbered; [msg:id] from older runs still opens', async () => {
    fetched.length = 0;
    await render(h(Markdown, { text: 'The lease ends in May [2]. Older [msg:old-1].', resolveCite: citeResolver([{ n: 2, id: 'bbb' }]) }));
    await click(document.querySelector('[data-cite="2"]'));
    assert.ok(fetched.some((u) => u.endsWith('/mail/messages/bbb')), fetched.join(', '));
    await click(document.querySelector('[data-msg="old-1"]'));
    assert.ok(fetched.some((u) => u.endsWith('/mail/messages/old-1')));
  });
});

// ── Waiting On and nudges ───────────────────────────────────────────────────
describe('Waiting on', () => {
  test('rows say who, what and how long ago; Nudge opens the composer with the drafted follow-up; Resolve stops waiting', async () => {
    assert.equal(askedLabel(0), 'asked today');
    assert.equal(askedLabel(1), 'asked yesterday');
    assert.equal(askedLabel(6), 'asked 6 days ago');
    await render(h(Waiting));
    assert.equal(document.querySelector('h1').textContent, 'Waiting on');
    assert.match(text(), /Tom Ellis · the signed contract/);
    assert.match(text(), /asked 6 days ago/);
    assert.match(text(), /No reply in 3 days, as you asked to be reminded/);
    await click(all('button').filter((b) => b.textContent === 'Nudge')[0]);
    assert.ok(requests().includes('POST /work/waiting/t-tom/nudge'));
    assert.equal(composed.length, 1);
    assert.match(composed[0].body, /^Hi Tom, just checking in on the signed contract/);
    assert.deepEqual(composed[0].to, [{ name: 'Tom Ellis', email: 'tom@ellis.example' }]);
    assert.equal(composed[0].subject, 'Re: the signed contract');
    await click(all('button').filter((b) => b.textContent === 'Resolve')[0]);
    assert.ok(requests().includes('POST /work/waiting/t-tom/resolve'));
    assert.doesNotMatch(text(), /Tom Ellis/);
    assert.equal(notifications.at(-1).title, 'No longer waiting on Tom Ellis.');
    assert.ok(!(await mock.mockRequest('GET', '/work/waiting')).some((w) => w.threadId === 't-tom'));
  });

  test('the Brief\'s Nudge uses the same drafted nudge', async () => {
    await render(h(Brief));
    await click(all('button').filter((b) => b.textContent === 'Nudge')[0]);
    await settle(60);
    assert.ok(requests().includes('POST /work/waiting/t-tom/nudge'));
    assert.match(composed.at(-1).body, /^Hi Tom, just checking in/);
    assert.ok(byText('button', 'See all'));
  });

  test('without the work routes the nudge is the plain opener', async () => {
    useV2.setState({ caps: { work: false } });
    await render(h(Brief));
    await click(all('button').filter((b) => b.textContent === 'Nudge')[0]);
    await settle(60);
    assert.ok(!requests().some((r) => r.includes('/nudge')));
    assert.equal(composed.at(-1).body, 'Hi Tom, just checking in on this.');
  });

  test('"Remind me if no reply" posts a watch after the reply is sent, with the default days from settings', async () => {
    useV2.setState({ settingsFields: [{ key: 'work.waitingDefaultDays', value: 7 }] });
    await render(h(Thread, { props: { item: await peopleItem('m-anna') } }));
    await settle(60);
    const days = byLabel('Remind me after');
    assert.equal(days.value, '7');
    await type(days, '5');
    const box = all('input[type="checkbox"]').find((b) => b.closest('label').textContent.includes('Remind me if no reply'));
    assert.equal(box.checked, true, 'picking a number of days ticks the box');
    const input = byLabel('Reply to Anna');
    await type(input, 'Sending them tonight.');
    await submit(input.closest('form'));
    assert.ok(requests().includes('POST /work/waiting'));
    const { watch } = await mock.mockRequest('POST', '/work/waiting', { threadId: 't-anna', days: 5 });
    assert.equal(watch.days, 5);
    assert.ok(notifications.some((n) => n.title === 'Sent.'));
    assert.equal(notifications.at(-1).title, 'Hedwig will remind you if there is no reply in 5 days.');
    assert.equal(box.checked, false, 'the box clears after the send');
  });

  test('left unticked, a send posts no watch', async () => {
    await render(h(Thread, { props: { item: await peopleItem('m-anna') } }));
    await settle(60);
    const input = byLabel('Reply to Anna');
    await type(input, 'Sending them tonight.');
    await submit(input.closest('form'));
    assert.ok(!requests().includes('POST /work/waiting'));
    assert.equal(notifications.at(-1).title, 'Sent.');
  });
});

// ── why door: sender scope ──────────────────────────────────────────────────
describe('why door sender scope', () => {
  test('senderScope decides "Everything from this list", over any signal', () => {
    const listSignal = [{ name: 'list', label: 'Mailing list weekly.example.org' }];
    assert.equal(hasListKey({ senderScope: 'list' }), true);
    assert.equal(hasListKey({ senderScope: 'address', signals: listSignal }), false);
    assert.equal(hasListKey({ senderScope: null, senderDecision: { scope: 'list' } }), false);
    assert.equal(hasListKey({ signals: listSignal }), true, 'an older server is still read the old way');
    assert.deepEqual(scopeOptions({ senderScope: 'domain' }).map((o) => o.id), ['one', 'sender', 'kind']);
    assert.deepEqual(scopeOptions({ senderScope: 'list' }).map((o) => o.id), ['one', 'sender', 'list', 'kind']);
  });

  test('the mock\'s why records carry the sender key and scope like the backend', async () => {
    assert.deepEqual((({ senderKey, senderScope }) => ({ senderKey, senderScope }))(await mock.mockRequest('GET', '/sort/message/m-ben/why')), { senderKey: 'weekly.benedict.example', senderScope: 'list' });
    assert.equal((await mock.mockRequest('GET', '/sort/message/m-jonas/why')).senderScope, 'address');
  });
});

after(async () => { await cleanup(); useHedwig.getState(); dom.window.close(); });
