import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

// ── Mocks: database, config, retrieval (as in ask2.test.js), plus the thread and the owner ─────────
const db = { calls: [], rows: new Map(), log: new Map(), nextAi: 1, prev: null, thread: [], threadKey: 't-news', owner: [] };
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    db.calls.push({ sql, params });
    if (/INSERT INTO hedwig_ai_calls/.test(sql)) return { rows: [{ id: db.nextAi++ }] };
    if (/FROM hedwig_ai_calls/.test(sql)) return { rows: [{ calls: 0, tokens: 0, n: 0 }] };
    if (/INSERT INTO hedwig_ask_log/.test(sql)) { const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(db.log.size + 1).padStart(12, '0')}`; db.log.set(id, { id, params }); return { rows: [{ id }] }; }
    if (/UPDATE hedwig_ask_log SET status/.test(sql)) { const row = db.log.get(params[0]); if (row) row.finish = params; return { rows: [] }; }
    if (/FROM hedwig_ask_log WHERE id = \$1 AND user_id = \$2/.test(sql)) return { rows: db.prev && db.prev.id === params[0] ? [db.prev] : [] };
    if (/SELECT m\.thread_key FROM messages m/.test(sql)) return { rows: params[1] === db.threadKey || db.thread.some((r) => r.id === params[1]) ? [{ thread_key: db.threadKey }] : [] };
    if (/SELECT DISTINCT ON \(COALESCE\(m\.message_id/.test(sql)) return { rows: params[1] === db.threadKey ? db.thread.map((r) => ({ ...r })) : [] };
    if (/FROM messages m JOIN email_accounts a/.test(sql) && /ANY\(\$2::uuid\[\]\)/.test(sql)) {
      return { rows: params[1].map((id) => db.rows.get(id) || db.thread.find((r) => r.id === id)).filter(Boolean) };
    }
    if (/lower\(a\.email_address\) AS email/.test(sql)) return { rows: db.owner.map((email) => ({ user_id: params[0][0], email })) };
    if (/display_name FROM hedwig_entities WHERE user_id = \$1 AND kind = 'self'/.test(sql)) return { rows: [{ name: 'Priya Raman' }] };
    return { rows: [] };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../core/bodies.js', () => ({ requestBody: vi.fn(async () => {}) }));

const gw = mockGateway();
const { SCHEMA } = await vi.importActual('../config.js');
const defaults = Object.fromEntries(SCHEMA.map((f) => [f.key, f.default]));
let cfg;
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })), SCHEMA: [] }));

const retrieveMock = vi.fn();
vi.mock('../indexer/retrieve.js', () => ({ retrieve: (...a) => retrieveMock(...a) }));
vi.mock('../context/cards.js', () => ({ ownsEntity: vi.fn(async () => true), ownsTopic: vi.fn(async () => true) }));
vi.mock('../context/search.js', () => ({ indexComplete: vi.fn(async () => true), searchIndexed: vi.fn(async () => ({ results: [] })) }));

const {
  webSettings, siteOf, unsubscribeUrls, researchRules, planResearch, researchWeb, linkCandidates, linksOnPages, webEvidence, publicWebSource,
} = await import('./web.js');
const { buildEvidence, groupByThread, focusShare } = await import('./evidence.js');
const { answerQuestion } = await import('./answer.js');
const { _resetPrompts } = await import('../prompts/index.js');
const { _resetLlmState } = await import('../llm.js');
const { _resetShareCache } = await import('../indexer/truth.js');

const USER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-17T10:00:00Z');
const M = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SEARX = 'http://search.test:8080';

const NEWSLETTER_HTML = `<p>In this issue:</p>
<a href="https://click.infoq.example/ls/click?upn=${'x'.repeat(48)}">Pizza Bot: Open-Source Inbox for Background AI Agents</a>
<a href="https://www.infoq.example/presentations/genai-platform-doordash/">Building GenAI Platform at DoorDash</a>
<a href="https://www.infoq.example/account/verify?token=${'k'.repeat(32)}">Verify your email</a>
<a href="https://mail.infoq.example/unsub?u=42">Unsubscribe</a>`;
const threadRow = (n, extra = {}) => ({
  id: M(100 + n), thread_key: 't-news', subject: 'AI, ML and Data Engineering Round-Up', from_name: 'InfoQ', from_email: 'special-reports@mail.infoq.example',
  date: new Date(NOW.getTime() - (3 - n) * 86400_000), folder: 'INBOX', body_text: `Newsletter text ${n}. `.repeat(20), body_html: null,
  attachments: [], list_unsubscribe: null, mine: false, ...extra,
});

/** A search service and a web that answer from tables, and record every URL asked for. */
function fakeWeb({ results = {}, pages = {} } = {}) {
  const searched = [];
  const read = [];
  return {
    searched,
    read,
    fetchers: {
      search: async (q) => { searched.push(q); return (results[q] || results['*'] || []).map((r) => ({ host: new URL(r.url).hostname.replace(/^www\./, ''), snippet: '', published: null, ...r })); },
      read: async (url) => {
        read.push(url);
        const p = pages[url];
        if (!p) return { ok: false, url, reason: 'status' };
        return { ok: true, url, title: p.title || url, text: p.text || 'Page text.', links: p.links || [] };
      },
    },
  };
}

beforeEach(() => {
  cfg = {
    ...defaults, 'llm.baseUrl': gw.baseUrl, 'llm.catalogUrl': gw.catalogUrl, 'insights.timezone': 'Europe/London', 'ask.searchRounds': 0,
    'ask.web.searchUrl': SEARX, 'ask.web.cacheHours': 0,
  };
  db.calls.length = 0; db.rows.clear(); db.log.clear(); db.prev = null; db.thread = []; db.owner = ['priya@home.example'];
  _resetShareCache();
  retrieveMock.mockReset();
  retrieveMock.mockResolvedValue({ chunks: [], floor: true });
  gw.reset(); gw.install();
  _resetPrompts({ keepFiles: true }); _resetLlmState();
});
afterEach(() => gw.restore());

describe('web settings and small helpers', () => {
  it('is on only when the user allows it and a search service is set up; the request decides for itself', () => {
    expect(webSettings({ ...defaults, 'ask.web.searchUrl': SEARX })).toMatchObject({ allowed: true, available: true, on: true });
    expect(webSettings({ ...defaults, 'ask.web.searchUrl': '' })).toMatchObject({ allowed: true, available: false, on: false });
    expect(webSettings({ ...defaults, 'ask.web.searchUrl': SEARX, 'ask.web.enabled': false })).toMatchObject({ allowed: false, on: false });
    expect(webSettings({ ...defaults, 'ask.web.searchUrl': SEARX, 'ask.web.enabled': false }, true)).toMatchObject({ on: true });
    expect(webSettings({ ...defaults, 'ask.web.searchUrl': SEARX }, false)).toMatchObject({ on: false });
  });

  it('names the organisation behind a mail host', () => {
    expect(siteOf('mail.infoq.com')).toBe('infoq.com');
    expect(siteOf('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('example.org')).toBe('example.org');
    expect(siteOf('')).toBe('');
  });

  it('reads the web addresses out of List-Unsubscribe headers', () => {
    expect(unsubscribeUrls([{ list_unsubscribe: '<mailto:u@x.example>, <https://x.example/u?id=1>' }, {}])).toEqual(['https://x.example/u?id=1']);
  });

  it('without a plan searches the web only when the question asks for it, without private words', () => {
    expect(researchRules('what did Anna say about the lease?')).toMatchObject({ web: [], links: [], searchMail: true });
    const r = researchRules('look up the latest news about Pizza Bot for priya@home.example', { emails: ['priya@home.example'] });
    expect(r.web).toHaveLength(1);
    expect(r.web[0]).not.toContain('priya@home.example');
  });
});

describe('planResearch', () => {
  it('keeps only link ids Hedwig numbered and scrubs the searches', async () => {
    db.thread = [threadRow(1, { body_html: NEWSLETTER_HTML })];
    const links = linkCandidates(db.thread);
    // The verify and unsubscribe links are never offered to the planner.
    expect(links.map((l) => l.text)).toEqual(['Pizza Bot: Open-Source Inbox for Background AI Agents', 'Building GenAI Platform at DoorDash']);
    gw.on('ask.research', { searchMail: false, web: ['pizza bot inbox agents priya@home.example'], links: ['L1', 'https://evil.example/?d=secret', 'L9'], deep: false });
    const plan = await planResearch(USER, {
      question: 'summarise the top articles', threadRows: db.thread, links, owner: { names: ['Priya Raman'], emails: ['priya@home.example'] },
      settings: webSettings(cfg), today: '2026-10-17',
    });
    expect(plan).toMatchObject({ searchMail: false, links: ['L1'], via: 'reflex' });
    expect(plan.web[0]).not.toMatch(/priya/i);
    const call = gw.callsFor('ask.research')[0];
    expect(call.text).toContain('L1 · Pizza Bot: Open-Source Inbox for Background AI Agents · click.infoq.example (tracked)');
    expect(call.text).not.toContain('Verify your email');
  });

  it('falls back to the rules when the planner fails, so the answer still comes', async () => {
    gw.on('ask.research', gw.error(500, 'down'));
    const plan = await planResearch(USER, { question: 'what is the lease end date?', threadRows: [], links: [], settings: webSettings(cfg), today: '2026-10-17' });
    expect(plan).toMatchObject({ via: 'rules', web: [], links: [], searchMail: true });
  });
});

describe('researchWeb', () => {
  const settings = () => webSettings(cfg);
  const candidates = () => linkCandidates([threadRow(1, { body_html: NEWSLETTER_HTML })]);

  it('fetches only search results and numbered links; a planner URL is never fetched', async () => {
    const web = fakeWeb({
      results: { 'genai platform': [{ url: 'https://a.example/one', title: 'One' }, { url: 'https://b.example/two', title: 'Two' }] },
      pages: { 'https://a.example/one': { title: 'One', text: 'First page.' }, 'https://b.example/two': { title: 'Two', text: 'Second page.' }, 'https://www.infoq.example/presentations/genai-platform-doordash/': { title: 'DoorDash', text: 'Talk.' } },
    });
    const out = await researchWeb({
      userId: USER, question: 'q', plan: { web: ['genai platform'], links: ['L2', 'https://evil.example/?d=x'] }, links: candidates(), settings: settings(), fetchers: web.fetchers,
    });
    expect(web.read).toEqual(expect.arrayContaining(['https://www.infoq.example/presentations/genai-platform-doordash/', 'https://a.example/one', 'https://b.example/two']));
    expect(web.read.some((u) => u.includes('evil'))).toBe(false);
    expect(out.sources.map((s) => s.via)).toEqual(['link', 'search', 'search']);
  });

  it('never opens a tracker: it finds the article by its words on the sender\'s site', async () => {
    const article = 'https://www.infoq.example/news/2026/10/pizza-bot/';
    const web = fakeWeb({
      results: { '*': [{ url: 'https://elsewhere.example/copy', title: 'Copy' }, { url: article, title: 'Pizza Bot' }] },
      pages: { [article]: { title: 'Pizza Bot', text: 'An inbox for agents.' } },
    });
    const events = [];
    const out = await researchWeb({
      userId: USER, question: 'q', plan: { web: [], links: ['L1'] }, links: candidates(), senderHost: 'mail.infoq.example', settings: settings(), fetchers: web.fetchers, onEvent: (e) => events.push(e),
    });
    expect(web.read).toEqual([article]);
    expect(web.read.some((u) => u.includes('click.infoq'))).toBe(false);
    expect(web.searched[0]).toContain('"Pizza Bot Open-Source Inbox for Background AI Agents"');
    expect(web.searched[0]).toContain('infoq.example');
    expect(out.sources[0]).toMatchObject({ url: article, via: 'link-search' });
    expect(events.find((e) => e.type === 'links')).toMatchObject({ opened: 1 });
  });

  it('opens a tracked link only when the user allows it, and never an action link', async () => {
    cfg['ask.web.openTrackedLinks'] = true;
    const tracked = candidates()[0].url;
    const web = fakeWeb({ pages: { [tracked]: { title: 'Pizza Bot', text: 'Via the tracker.' } } });
    const rows = [threadRow(1, { body_html: NEWSLETTER_HTML })];
    const all = (await import('../research/links.js')).emailLinks(rows);
    const verify = all.find((l) => /verify/.test(l.url));
    const out = await researchWeb({
      userId: USER, question: 'q', plan: { web: [], links: ['L1', verify.id] }, links: [...candidates(), verify], settings: settings(), fetchers: web.fetchers,
    });
    expect(web.read).toEqual([tracked]);
    expect(out.skipped).toEqual([expect.objectContaining({ reason: expect.any(String) })]);
  });

  it('replaces a page that will not open, keeps the rest as snippets, and leaves private words out of searches', async () => {
    cfg['ask.web.pages'] = 1;
    cfg['ask.web.snippets'] = 2;
    const web = fakeWeb({
      results: { '*': [
        { url: 'https://dead.example/a', title: 'Dead', snippet: 'dead' },
        { url: 'https://ok.example/b', title: 'Ok', snippet: 'ok' },
        { url: 'https://c.example/c', title: 'C', snippet: 'third' },
        { url: 'https://d.example/d', title: 'D', snippet: 'fourth' },
      ] },
      pages: { 'https://ok.example/b': { title: 'Ok', text: 'Read in full.' } },
    });
    const out = await researchWeb({
      userId: USER, question: 'q', plan: { web: ['visa fees for priya@home.example 4111 1111 1111 1111'], links: [] }, links: [], owner: { emails: ['priya@home.example'] }, settings: webSettings(cfg), fetchers: web.fetchers,
    });
    expect(web.searched[0]).not.toMatch(/priya|4111/);
    expect(out.sources.filter((s) => !s.snippetOnly).map((s) => s.url)).toEqual(['https://ok.example/b']);
    expect(out.sources.filter((s) => s.snippetOnly).map((s) => s.url)).toEqual(['https://dead.example/a', 'https://c.example/c']);
  });

  it('digs deeper through links on the pages read, by id only', async () => {
    const web = fakeWeb({
      results: { 'agents inbox': [{ url: 'https://a.example/one', title: 'One' }] },
      pages: {
        'https://a.example/one': { title: 'One', text: 'Start.', links: [{ url: 'https://a.example/deeper-story', text: 'The deeper story behind agent inboxes' }, { url: 'https://a.example/login', text: 'Sign in to your account now' }] },
        'https://a.example/deeper-story': { title: 'Deeper', text: 'More.' },
      },
    });
    gw.on('ask.research.refine', [{ enough: false, web: [], links: ['P1', 'https://evil.example/'] }, { enough: true, web: [], links: [] }]);
    const out = await researchWeb({ userId: USER, question: 'q', plan: { web: ['agents inbox'], links: [], deep: true }, links: [], settings: settings(), fetchers: web.fetchers });
    expect(web.read).toEqual(['https://a.example/one', 'https://a.example/deeper-story']);
    expect(gw.callsFor('ask.research.refine')[0].text).not.toContain('Sign in');
    expect(out.rounds).toBe(2);
  });

  it('numbers links on pages only for pages Hedwig may open and has not read', () => {
    const pages = [{ links: [{ url: 'https://x.example/a', text: 'A long enough link text' }, { url: 'https://x.example/a', text: 'A long enough link text' }, { url: 'https://x.example/b', text: 'short' }] }];
    expect(linksOnPages(pages).map((l) => l.id)).toEqual(['P1']);
  });
});

describe('evidence for a thread and the web', () => {
  it('reads the open thread whole and first, and fits a long thread in the budget', () => {
    const rows = new Map([[M(101), threadRow(1)], [M(102), threadRow(2)], [M(7), { ...threadRow(7), id: M(7), thread_key: 'other', subject: 'Other' }]]);
    const groups = groupByThread([{ chunkId: 1, messageId: M(7), threadId: 'other', kind: 'body', ordinal: 0, text: 'h\nother passage', score: 0.9 }], rows, { pinned: [M(101), M(102)], focus: 't-news' });
    expect(groups.map((g) => g.key)).toEqual(['t-news', 'other']);
    const ev = buildEvidence(groups, { focus: 't-news', focusChars: 12000 });
    expect(ev.block.startsWith('## The thread the user is reading: AI, ML and Data Engineering Round-Up (2 messages)')).toBe(true);
    expect(ev.sources.map((s) => s.messageId)).toEqual([M(101), M(102), M(7)]);
    expect(focusShare(100, { contextTokens: 24000, focusChars: 12000 })).toBe(600);
    expect(focusShare(2, { contextTokens: 24000, focusChars: 12000 })).toBe(12000);
  });

  it('numbers web sources after the mail, within their own budget', () => {
    const src = [
      { url: 'https://a.example/', title: 'A', host: 'a.example', via: 'link', text: 'x'.repeat(400) },
      { url: 'https://b.example/', title: 'B', host: 'b.example', via: 'search', text: 'y'.repeat(4000) },
      { url: 'https://c.example/', title: 'C', host: 'c.example', via: 'search', text: 'snippet', snippetOnly: true },
    ];
    const ev = webEvidence(src, { startAt: 4, contextTokens: 400 });
    expect(ev.used.map((u) => u.n)).toEqual([4, 5]);
    expect(ev.omitted).toBe(1);
    expect(ev.block).toContain('[4] WEB · a.example · A · opened from a link in the email');
    expect(ev.block).toContain('[5] WEB · c.example · C · search result only, page not read');
    expect(publicWebSource({ ...ev.used[0] })).toMatchObject({ n: 4, url: 'https://a.example/', excerpt: expect.stringMatching(/^x+…$/) });
  });
});

describe('answerQuestion about a thread, with the web', () => {
  const collect = () => { const events = []; return { events, onEvent: (e) => events.push(e) }; };

  it('reads the thread first, looks up the web beside the mail, cites both and saves the pages', async () => {
    db.thread = [threadRow(1), threadRow(2, { body_html: NEWSLETTER_HTML })];
    const article = 'https://www.infoq.example/news/2026/10/pizza-bot/';
    const web = fakeWeb({
      results: { '*': [{ url: article, title: 'Pizza Bot' }] },
      pages: { [article]: { title: 'Pizza Bot: Open-Source Inbox', text: 'Pizza Bot is an inbox where background agents post their work.' } },
    });
    gw.on('ask.research', { searchMail: false, web: [], links: ['L1'], deep: false });
    gw.on('ask.answer', 'The round-up leads with Pizza Bot [2]. It is an inbox for background agents, according to infoq.example [3]. See [9].');
    const { events, onEvent } = collect();
    const out = await answerQuestion(USER, 'What is Pizza Bot?', { threadKey: M(102), onEvent, now: NOW, fetchers: web.fetchers });

    expect(retrieveMock).not.toHaveBeenCalled(); // the planner said the thread is enough
    expect(events[0]).toMatchObject({ type: 'thread', status: 'running' });
    expect(events[1]).toMatchObject({ type: 'thread', status: 'done', messages: 2, subject: 'AI, ML and Data Engineering Round-Up' });
    expect(events.find((e) => e.type === 'read' && e.status === 'done').pages[0]).toMatchObject({ host: 'infoq.example', ok: true });
    const sourcesEv = events.find((e) => e.type === 'sources');
    expect(sourcesEv.sources.map((s) => s.n)).toEqual([1, 2]);
    expect(sourcesEv.web).toEqual([expect.objectContaining({ n: 3, url: article, via: 'link-search' })]);

    const call = gw.callsFor('ask.answer')[0];
    expect(call.text).toContain('The user is reading one email thread');
    expect(call.text).toContain('## The thread the user is reading');
    expect(call.text).toContain('[3] WEB · infoq.example');
    expect(call.text).toContain('Do not write web addresses or links');
    expect(out.citations).toEqual([2, 3]);
    expect(out.answer).not.toContain('[9]');

    const log = [...db.log.values()][0];
    expect(log.params[5]).toBe('t-news'); // thread_key
    expect(log.params[6]).toBe(true); // web
    expect(JSON.parse(log.finish[13])).toEqual([expect.objectContaining({ n: 3, url: article })]);
    expect(JSON.parse(log.finish[6]).research).toMatchObject({ via: 'reflex', links: ['L1'], read: 1 });
  });

  it('keeps a follow-up on its conversation\'s thread, and asks no planner with the web off', async () => {
    db.thread = [threadRow(1)];
    const PREV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    db.prev = { id: PREV, question: 'What is in this issue?', answer: 'Several talks [1].', sources: [M(101)], status: 'done', thread_key: 't-news', web: false };
    gw.on('ask.answer', 'The first one is about agents [1].');
    const out = await answerQuestion(USER, 'and the first one?', { followUpOf: PREV, web: false, onEvent: () => {}, now: NOW });
    expect(gw.callsFor('ask.research')).toHaveLength(0);
    expect(out.web).toEqual([]);
    expect([...db.log.values()][0].params.slice(5, 7)).toEqual(['t-news', false]);
    expect(gw.callsFor('ask.answer')[0].text).toContain('Answer only from the numbered emails');
  });

  it('refuses a thread the user does not have', async () => {
    await expect(answerQuestion(USER, 'what is this?', { threadKey: 'not-mine', onEvent: () => {}, now: NOW })).rejects.toMatchObject({ status: 404 });
  });

  it('answers from the web alone when the mail has nothing, and a web stage failure never ends the answer', async () => {
    gw.on('ask.research', { searchMail: true, web: ['pizza bot'], links: [], deep: false });
    gw.on('ask.answer', 'It is an inbox for agents [1].');
    const boom = { search: async () => { throw new Error('searx exploded'); }, read: async () => ({ ok: false, reason: 'error' }) };
    const out = await answerQuestion(USER, 'what is pizza bot on the web?', { onEvent: () => {}, now: NOW, fetchers: boom });
    expect(out.notFound).toBe(true); // nothing in mail, the web stage failed quietly
    const web = fakeWeb({ results: { '*': [{ url: 'https://p.example/', title: 'P' }] }, pages: { 'https://p.example/': { title: 'P', text: 'An inbox for agents.' } } });
    const out2 = await answerQuestion(USER, 'what is pizza bot on the web?', { onEvent: () => {}, now: NOW, fetchers: web.fetchers });
    expect(out2.web).toEqual([expect.objectContaining({ n: 1, url: 'https://p.example/' })]);
    expect(out2.citations).toEqual([1]);
  });
});
