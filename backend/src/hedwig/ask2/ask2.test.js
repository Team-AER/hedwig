import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

// ── Mocks: database, config, retrieval ───────────────────────────────────────
const db = { calls: [], rows: new Map(), log: new Map(), nextAi: 1, prev: null, entities: [] };
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    db.calls.push({ sql, params });
    if (/INSERT INTO hedwig_ai_calls/.test(sql)) return { rows: [{ id: db.nextAi++ }] };
    if (/FROM hedwig_ai_calls/.test(sql)) return { rows: [{ calls: 0, tokens: 0, n: 0 }] };
    if (/INSERT INTO hedwig_ask_log/.test(sql)) { const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(db.log.size + 1).padStart(12, '0')}`; db.log.set(id, { id, params }); return { rows: [{ id }] }; }
    if (/UPDATE hedwig_ask_log SET status/.test(sql)) { const row = db.log.get(params[0]); if (row) row.finish = params; return { rows: [] }; }
    if (/FROM hedwig_ask_log WHERE id = \$1 AND user_id = \$2/.test(sql)) return { rows: db.prev && db.prev.id === params[0] ? [db.prev] : [] };
    if (/FROM messages m JOIN email_accounts a/.test(sql) && /ANY\(\$2::uuid\[\]\)/.test(sql)) return { rows: params[1].map((id) => db.rows.get(id)).filter(Boolean) };
    if (/FROM hedwig_entities e JOIN hedwig_entity_addresses/.test(sql)) return { rows: db.entities.filter((e) => e.name.toLowerCase().startsWith(String(params[1]).toLowerCase())).map((e) => ({ email: e.email })) };
    return { rows: [] };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const gw = mockGateway();
const { SCHEMA } = await vi.importActual('../config.js');
const defaults = Object.fromEntries(SCHEMA.map((f) => [f.key, f.default]));
let cfg;
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })), SCHEMA: [] }));

const retrieveMock = vi.fn();
vi.mock('../indexer/retrieve.js', () => ({ retrieve: (...a) => retrieveMock(...a) }));
vi.mock('../context/cards.js', () => ({ ownsEntity: vi.fn(async () => true), ownsTopic: vi.fn(async () => true) }));
vi.mock('../context/search.js', () => ({ indexComplete: vi.fn(async () => true), searchIndexed: vi.fn(async () => ({ results: [] })) }));

const { planRules, normaliseModelPlan, isStructured, planQuery } = await import('./plan.js');
const { groupByThread, buildEvidence, stripContextLine } = await import('./evidence.js');
const { checkCitations, citedNumbers, numberResults, runSources, sourcesFromMessages, _resetCitations } = await import('./citations.js');
const { answerQuestion, NOTHING_RELEVANT } = await import('./answer.js');
const { _resetPrompts } = await import('../prompts/index.js');
const { _resetLlmState } = await import('../llm.js');

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-23T10:00:00Z'); // a Wednesday
const M = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  cfg = { ...defaults, 'llm.baseUrl': gw.baseUrl, 'llm.catalogUrl': gw.catalogUrl, 'insights.timezone': 'Europe/London' };
  db.calls.length = 0; db.rows.clear(); db.log.clear(); db.prev = null; db.entities = [];
  retrieveMock.mockReset();
  gw.reset(); gw.install();
  _resetPrompts({ keepFiles: true }); _resetLlmState(); _resetCitations();
});
afterEach(() => gw.restore());

// ── Query plan rules ─────────────────────────────────────────────────────────
describe('planRules', () => {
  const plan = (q, extra = {}) => planRules(q, { now: NOW, tz: 'Europe/London', ...extra });

  it('reads "last month" as the previous calendar month in the user zone', () => {
    const p = plan('What did the solicitor charge last month?');
    expect(p.after).toBe('2026-07-31T23:00:00.000Z');
    expect(p.before).toBe('2026-08-31T23:00:00.000Z');
    expect(p.text).toBe('What did the solicitor charge?');
    expect(p.rules).toContain('last_month');
  });

  it('reads "in June" as June this year, and a future month as last year', () => {
    expect(plan('invoices in June')).toMatchObject({ after: '2026-05-31T23:00:00.000Z', before: '2026-06-30T23:00:00.000Z' });
    expect(plan('invoices in November').after).toBe('2025-11-01T00:00:00.000Z');
    expect(plan('receipts in March 2024').after).toBe('2024-03-01T00:00:00.000Z');
  });

  it('keeps "may" the verb out of the date rules', () => {
    const p = plan('what may I have missed from Priya');
    expect(p.after).toBeNull();
    expect(p.people).toEqual(['priya']);
  });

  it('reads yesterday, today, last week and last N days', () => {
    expect(plan('who wrote yesterday')).toMatchObject({ after: '2026-09-21T23:00:00.000Z', before: '2026-09-22T23:00:00.000Z' });
    expect(plan('anything today')).toMatchObject({ after: '2026-09-22T23:00:00.000Z', before: '2026-09-23T23:00:00.000Z' });
    expect(plan('mail last week')).toMatchObject({ after: '2026-09-13T23:00:00.000Z', before: '2026-09-20T23:00:00.000Z' });
    expect(plan('orders in the last 10 days').after).toBe(new Date(NOW.getTime() - 10 * 86400_000).toISOString());
  });

  it('takes people after from/by, addresses anywhere, and not ordinary words', () => {
    expect(plan('What did Priya Nair say about the visa').people).toEqual([]);
    expect(plan('latest from Priya Nair').people).toEqual(['priya nair']);
    expect(plan('mail from thomas@reedlaw.example about fees').people).toEqual(['thomas@reedlaw.example']);
    expect(plan('anything from work about the offsite').people).toEqual([]);
    expect(plan('what did marta send', { knownPeople: ['marta'] }).people).toEqual([]);
    expect(plan('invoice from marta', { knownPeople: ['marta'] }).people).toEqual(['marta']);
    // "to"/"with" names are only kept for resolution to addresses, never as a sender filter.
    const p = plan('what did I send to Priya');
    expect(p.people).toEqual([]);
    expect(p.names).toEqual([{ name: 'Priya', from: false }]);
  });

  it('flags attachments, "latest", quoted phrases and the user\'s folders', () => {
    const a = plan('the contract from Thomas with a PDF');
    expect(a.hasAttachment).toBe(true);
    expect(a.text).toContain('PDF');
    expect(plan('latest from Amazon')).toMatchObject({ latest: true, people: ['amazon'] });
    expect(plan('last email from Sam').latest).toBe(true);
    expect(plan('mail last week').latest).toBe(false);
    const q = plan('who said "reference number" first?');
    expect(q.quoted).toEqual(['reference number']);
    expect(q.text).toContain('reference number');
    expect(plan('the offer in my Receipts folder', { folders: ['INBOX', 'Receipts', 'Sent'] }).folders).toEqual(['Receipts']);
    expect(plan('what I sent in June', { folders: ['Sent'] }).folders).toEqual([]);
  });

  it('isStructured is false for a plain question', () => {
    expect(isStructured(plan('what is the solicitor fee'))).toBe(false);
    expect(isStructured(plan('what is the solicitor fee from Thomas'))).toBe(true);
  });

  it('normalises the Reflex plan: bad dates dropped, only own folders', () => {
    const p = normaliseModelPlan({ text: 'fee', people: ['Thomas'], after: 'soon', before: '2026-09-01', folders: ['Receipts', 'Nope'], hasAttachment: false, latest: true }, { folders: ['Receipts'], question: 'q' });
    expect(p).toMatchObject({ text: 'fee', people: ['thomas'], after: null, before: '2026-09-01T00:00:00.000Z', folders: ['Receipts'], hasAttachment: null, latest: true });
  });
});

describe('planQuery', () => {
  it('uses the rules alone when they find structure (no model call)', async () => {
    const p = await planQuery(USER, 'invoices from Marta last month', { now: NOW });
    expect(p.via).toBe('rules');
    expect(gw.callsFor('ask.plan')).toHaveLength(0);
  });

  it('resolves named people to their addresses', async () => {
    db.entities = [{ name: 'Priya Nair', email: 'priya.nair@vantage.example' }];
    const p = await planQuery(USER, 'what did I send to Priya about the visa', { now: NOW });
    expect(p.people).toEqual(['priya.nair@vantage.example']);
  });

  it('asks the Reflex model for a plain question and merges its filters', async () => {
    gw.on('ask.plan', { text: 'solicitor fee', people: [], after: '2026-01-01', before: null, folders: [], hasAttachment: null, latest: false });
    const p = await planQuery(USER, 'how much is the solicitor charging', { now: NOW });
    expect(p.via).toBe('reflex');
    expect(p).toMatchObject({ text: 'solicitor fee', after: '2026-01-01T00:00:00.000Z' });
    expect(gw.callsFor('ask.plan')[0].maxTokens).toBeLessThanOrEqual(160);
  });

  it('falls back to the rules when the Reflex plan takes longer than ask.planTimeoutMs', async () => {
    cfg['ask.planTimeoutMs'] = 150;
    gw.on('ask.plan', gw.hang());
    const started = Date.now();
    const p = await planQuery(USER, 'how much is the solicitor charging', { now: NOW });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(p).toMatchObject({ via: 'rules', reflexError: 'timeout', text: 'how much is the solicitor charging' });
  });
});

// ── Evidence grouping ────────────────────────────────────────────────────────
const row = (n, thread, daysAgo, extra = {}) => ({
  id: M(n), thread_key: thread, subject: `Subject ${thread}`, from_name: `Sender ${n}`, from_email: `s${n}@x.test`,
  date: new Date(NOW.getTime() - daysAgo * 86400_000), folder: 'INBOX', body_text: `Body of message ${n}. `.repeat(30), attachments: [], ...extra,
});
const chunk = (n, thread, score, extra = {}) => ({ chunkId: n * 10 + (extra.ordinal || 0), messageId: M(n), threadId: thread, kind: 'body', ordinal: 0, text: `Header line\nPassage from ${n}`, score, ...extra });

describe('groupByThread / buildEvidence', () => {
  const rows = new Map([[M(1), row(1, 't1', 10)], [M(2), row(2, 't1', 5)], [M(3), row(3, 't2', 1)], [M(4), row(4, null, 3)]]);

  it('groups by thread, best thread first, messages oldest first, drops unknown messages', () => {
    const groups = groupByThread([chunk(2, 't1', 0.9), chunk(1, 't1', 0.4), chunk(3, 't2', 0.6), chunk(9, 't9', 1)], rows);
    expect(groups.map((g) => g.key)).toEqual(['t1', 't2']);
    expect(groups[0].messages.map((m) => m.id)).toEqual([M(1), M(2)]);
  });

  it('orders by recency when the plan wants the latest, and puts pinned follow-up sources first', () => {
    const chunks = [chunk(2, 't1', 0.9), chunk(3, 't2', 0.2)];
    expect(groupByThread(chunks, rows, { latest: true }).map((g) => g.key)).toEqual(['t2', 't1']);
    expect(groupByThread(chunks, rows, { pinned: [M(4)] })[0].key).toBe(`msg:${M(4)}`);
  });

  it('keeps thread rollups out of the numbered messages', () => {
    const groups = groupByThread([chunk(1, 't1', 0.5, { kind: 'thread', text: 'Subject · thread of 2\n2026 Sender: hi' }), chunk(2, 't1', 0.5)], rows);
    const ev = buildEvidence(groups);
    expect(ev.sources.map((s) => s.messageId)).toEqual([M(2)]);
    expect(ev.block).toContain('Thread outline (not citable)');
  });

  it('numbers one entry per message and stops at the token budget', () => {
    const groups = groupByThread([chunk(1, 't1', 0.9), chunk(2, 't1', 0.8), chunk(3, 't2', 0.7)], rows);
    const all = buildEvidence(groups, { contextTokens: 100000 });
    expect(all.sources.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(all.block).toMatch(/\[1\] From: Sender 1/);
    expect(all.block).toMatch(/\[3\] From: Sender 3/);
    const small = buildEvidence(groups, { contextTokens: 300, messageChars: 600 });
    expect(small.sources.length).toBeGreaterThanOrEqual(1);
    expect(small.sources.length).toBeLessThan(3);
    expect(small.omitted).toBeGreaterThan(0);
    expect(small.sources.map((s) => s.n)).toEqual(small.sources.map((_, i) => i + 1));
  });

  it('strips the chunk context line', () => {
    expect(stripContextLine('Subject · Sender · 2026\nThe passage')).toBe('The passage');
  });
});

// ── Citation check ───────────────────────────────────────────────────────────
describe('checkCitations', () => {
  it('keeps valid citations and removes ones that point at nothing', () => {
    const r = checkCitations('The fee is £1,450 [2]. It takes 8 weeks [1, 7]. Reference VNT [9].', 3);
    expect(r.citations).toEqual([1, 2]);
    expect(r.invalid).toEqual([7, 9]);
    expect(r.answer).toBe('The fee is £1,450 [2]. It takes 8 weeks [1]. Reference VNT.');
    expect(r.unsupported).toBe(false);
  });

  it('flags an answer with no valid citation as unsupported, but not a plain not-found', () => {
    expect(checkCitations('The fee is £1,450.', 3)).toMatchObject({ unsupported: true, notFound: false, citations: [] });
    expect(checkCitations('The fee is £1,450 [4].', 3)).toMatchObject({ unsupported: true, invalid: [4] });
    expect(checkCitations("I couldn't find that in your mail.", 3)).toMatchObject({ unsupported: false, notFound: true });
  });

  it('reads [1][3] and [1, 3] alike and ignores markdown links', () => {
    expect(citedNumbers('a [1][3] b [2, 4] c [5](http://x)')).toEqual([1, 3, 2, 4]);
  });
});

describe('agent citation numbers', () => {
  it('numbers search results per run, keeping a message its first number', async () => {
    const RUN = '99999999-9999-4999-8999-999999999999';
    const a = await numberResults(USER, RUN, [{ id: 'm1' }, { id: 'm2' }]);
    const b = await numberResults(USER, RUN, [{ id: 'm3' }, { id: 'm1' }]);
    expect(a.map((r) => r.n)).toEqual([1, 2]);
    expect(b.map((r) => r.n)).toEqual([3, 1]);
    expect(await runSources(USER, RUN)).toEqual([{ n: 1, id: 'm1' }, { n: 2, id: 'm2' }, { n: 3, id: 'm3' }]);
    expect((await numberResults(USER, null, [{ id: 'x' }]))[0].n).toBe(1);
  });

  it('rebuilds the numbers from a stored run', () => {
    const messages = [
      { role: 'tool', name: 'search_mail', content: JSON.stringify({ results: [{ n: 1, id: 'a' }, { n: 2, id: 'b' }] }) },
      { role: 'tool', name: 'get_person', content: '{}' },
      { role: 'tool', name: 'search_mail', content: JSON.stringify({ results: [{ n: 3, id: 'c' }, { n: 1, id: 'a' }] }) },
    ];
    expect(sourcesFromMessages(messages)).toEqual(['a', 'b', 'c']);
  });
});

// ── The whole answer path ────────────────────────────────────────────────────
describe('answerQuestion', () => {
  const collect = () => { const events = []; return { events, onEvent: (e) => events.push(e) }; };

  it('answers "nothing relevant" without a model call when the floor cuts everything', async () => {
    retrieveMock.mockResolvedValue({ chunks: [], floor: true });
    const { events, onEvent } = collect();
    const out = await answerQuestion(USER, 'What colour is the office carpet in Oslo?', { onEvent, now: NOW });
    expect(out).toMatchObject({ answer: NOTHING_RELEVANT, notFound: true, unsupported: false });
    expect(events.map((e) => e.type)).toEqual(['sources', 'delta', 'done']);
    expect(gw.calls.filter((c) => c.workflow === 'ask.answer')).toHaveLength(0);
    const log = [...db.log.values()][0];
    expect(JSON.parse(log.finish[6])).toMatchObject({ retrieval: { floor: true, chunks: 0 } });
  });

  it('retrieves with the plan, streams a cited answer and records the check', async () => {
    db.rows.set(M(1), row(1, 'visa', 20, { subject: 'Sponsorship – fees', body_text: 'Our fee is £1,450 plus the government fee.' }));
    db.rows.set(M(2), row(2, 'visa', 8, { subject: 'Re: Sponsorship', body_text: 'Reference VNT-2026-0448 is confirmed.' }));
    retrieveMock.mockResolvedValue({ chunks: [chunk(1, 'visa', 0.8), chunk(2, 'visa', 0.5)], floor: false });
    gw.on('ask.answer', 'The fee is £1,450 plus the government fee [1]. The reference is VNT-2026-0448 [2][5].');
    const { events, onEvent } = collect();
    const out = await answerQuestion(USER, 'What is the solicitor fee from Thomas last month?', { onEvent, now: NOW });
    const call = retrieveMock.mock.calls[0][0];
    expect(call).toMatchObject({ userId: USER, expandThreads: true, limit: 50 });
    expect(call.filters.people).toEqual(['thomas']);
    expect(call.filters.after).toBe('2026-07-31T23:00:00.000Z');
    const answerCall = gw.callsFor('ask.answer')[0];
    expect(answerCall.stream).toBe(true);
    expect(answerCall.text).toContain('[1] From: Sender 1');
    expect(answerCall.text).toContain('Answer only from the numbered emails');
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ citations: [1, 2], invalidCitations: [5], unsupported: false, askLogId: out.askLogId });
    expect(done.answer).not.toContain('[5]');
    expect(events[0]).toMatchObject({ type: 'sources', sources: [{ n: 1, message: { id: M(1) } }, { n: 2, message: { id: M(2) } }] });
    const log = [...db.log.values()][0];
    expect(JSON.parse(log.finish[4])).toEqual([M(1), M(2)]);
    expect(log.finish[7]).toBe(false); // unsupported
    expect(log.finish[11]).toBe('ask.answer');
  });

  it('flags an answer without a valid citation as unsupported', async () => {
    db.rows.set(M(1), row(1, 't', 2));
    retrieveMock.mockResolvedValue({ chunks: [chunk(1, 't', 0.9)], floor: false });
    gw.on('ask.plan', { text: 'fee', people: [], after: null, before: null, folders: [], hasAttachment: null, latest: false });
    gw.on('ask.answer', 'It is probably £2,000.');
    const { events, onEvent } = collect();
    const out = await answerQuestion(USER, 'how much is it', { onEvent, now: NOW });
    expect(out.unsupported).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', unsupported: true, citations: [] });
  });

  it('carries the previous answer\'s sources into a follow-up', async () => {
    const PREV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    db.prev = { id: PREV, question: 'What is the solicitor fee?', answer: 'It is £1,450 [1].', sources: [M(7)], status: 'done' };
    db.rows.set(M(7), row(7, 'visa', 30, { body_text: 'Our fee is £1,450; the timeline is 8–10 weeks.' }));
    db.rows.set(M(3), row(3, 'other', 1));
    retrieveMock.mockResolvedValue({ chunks: [chunk(3, 'other', 0.4)], floor: false });
    gw.on('ask.plan', { text: 'timeline', people: [], after: null, before: null, folders: [], hasAttachment: null, latest: false });
    gw.on('ask.answer', 'About 8–10 weeks [1].');
    const out = await answerQuestion(USER, 'and the timeline?', { followUpOf: PREV, onEvent: () => {}, now: NOW });
    expect(out.sources[0].message.id).toBe(M(7));
    expect(retrieveMock.mock.calls[0][0].query).toContain('What is the solicitor fee?');
    const text = gw.callsFor('ask.answer')[0].messages;
    expect(text.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(text[2].content).not.toContain('[1]');
    expect([...db.log.values()][0].params[4]).toBe(PREV);
  });

  it('rejects a follow-up of someone else\'s answer', async () => {
    await expect(answerQuestion(USER, 'and then?', { followUpOf: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', now: NOW })).rejects.toMatchObject({ status: 404 });
  });
});
