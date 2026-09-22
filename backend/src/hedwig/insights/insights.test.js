import { describe, it, expect, vi, beforeEach } from 'vitest';

// A tiny in-memory hedwig_insights table plus canned evidence for briefing queries.
const db = vi.hoisted(() => {
  const state = { insights: [], state: new Map(), seq: 0, commitments: [], volume: { received: 4, sent: 1, bulk: 2 } };
  const res = (rows) => ({ rows, rowCount: rows.length });
  async function query(text, params = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM system_settings') || sql.includes('FROM hedwig_user_settings')) return res([]);
    if (sql.startsWith('SELECT value FROM hedwig_state')) return res(state.state.has(params[0]) ? [{ value: state.state.get(params[0]) }] : []);
    if (sql.startsWith('INSERT INTO hedwig_state')) { state.state.set(params[0], JSON.parse(params[1])); return res([]); }
    if (sql.startsWith("SELECT data->>'key' AS key, data->>'fingerprint' AS fp FROM hedwig_insights")) {
      return res(state.insights.filter((i) => i.user_id === params[0] && i.kind === 'card' && i.dismissed_at)
        .map((i) => ({ key: i.data.key, fp: i.data.fingerprint })));
    }
    if (sql.startsWith('INSERT INTO hedwig_insights') && sql.includes('ON CONFLICT')) {
      const [userId, periodStart, periodEnd, title, body, data, sources, severity] = params;
      const d = JSON.parse(data);
      const existing = state.insights.find((i) => i.user_id === userId && i.kind === 'card' && i.data.key === d.key && +i.period_start === +periodStart);
      if (existing) {
        if (!existing.dismissed_at) Object.assign(existing, { title, body, data: d, sources: JSON.parse(sources), severity });
        return res([]);
      }
      state.insights.push({ id: `i${++state.seq}`, user_id: userId, kind: 'card', period_start: periodStart, period_end: periodEnd, title, body, data: d, sources: JSON.parse(sources), severity, created_at: new Date(), dismissed_at: null });
      return res([]);
    }
    if (sql.startsWith('INSERT INTO hedwig_insights')) {
      const [userId, kind, periodStart, periodEnd, title, body, data, sources, severity] = params;
      const row = { id: `i${++state.seq}`, user_id: userId, kind, period_start: periodStart, period_end: periodEnd, title, body, data: JSON.parse(data), sources: JSON.parse(sources), severity, created_at: new Date(), dismissed_at: null };
      state.insights.push(row);
      return res([row]);
    }
    if (sql.startsWith('DELETE FROM hedwig_insights')) {
      const before = state.insights.length;
      state.insights = state.insights.filter((i) => !(i.user_id === params[0] && i.kind === 'card' && +i.period_start === +params[1] && !i.dismissed_at && !params[2].includes(i.data.key)));
      return { rows: [], rowCount: before - state.insights.length };
    }
    if (sql.startsWith("SELECT * FROM hedwig_insights WHERE user_id = $1 AND kind = 'card' AND period_start = $2")) {
      return res(state.insights.filter((i) => i.user_id === params[0] && i.kind === 'card' && +i.period_start === +params[1] && !i.dismissed_at));
    }
    if (sql.includes('FROM hedwig_commitments') && sql.includes('due_at < NOW() + make_interval')) return res(state.commitments);
    if (sql.includes('COUNT(*) FILTER (WHERE NOT outgoing)::int AS received')) return res([state.volume]);
    return res([]);
  }
  return { state, query };
});

const llm = vi.hoisted(() => ({ chat: null }));
const triage = vi.hoisted(() => ({ listTriage: null }));

vi.mock('../../services/db.js', () => ({ query: db.query, pool: {} }));
vi.mock('../llm.js', () => ({ chat: (opts) => llm.chat(opts) }));
vi.mock('../triage/service.js', () => ({ listTriage: (...args) => triage.listTriage(...args) }));
vi.mock('../hooks.js', () => ({ HEDWIG_HOOKS: { collectInsights: 'hedwig.collectInsights' }, collectHedwigHook: async () => [] }));

const { percentile, median, responseSamples, summarizeResponseTimes, responseTrend } = await import('./stats.js');
const { oweRepliesCard, newsletterCard, overdueCommitmentsCard, senderSpikeCard, responseTrendCard, normalisePluginCards, storeCards } = await import('./cards.js');
const { composeBriefing, renderDeterministic, sanitizeCitations, stripThinking } = await import('./briefing.js');
const { isDue } = await import('./index.js');
const { clampDays } = await import('./overview.js');

const USER = '11111111-1111-4111-8111-111111111111';
const H = 3600_000;
const D = 24 * H;
const t0 = Date.parse('2026-09-01T09:00:00Z');
const at = (h) => new Date(t0 + h * H);

describe('response time maths', () => {
  it('interpolates percentiles', () => {
    expect(median([1, 3])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
    expect(median([])).toBeNull();
  });

  it('measures from the first unanswered message to the reply, once per reply', () => {
    const rows = [
      { thread: 'a', date: at(0), outgoing: false },
      { thread: 'a', date: at(2), outgoing: false }, // still waiting since hour 0
      { thread: 'a', date: at(5), outgoing: true }, // 5 h
      { thread: 'a', date: at(6), outgoing: true }, // nothing new to answer
      { thread: 'a', date: at(30), outgoing: false },
      { thread: 'a', date: at(31), outgoing: true }, // 1 h
      { thread: 'b', date: at(1), outgoing: true }, // user started it: no sample
      { thread: 'b', date: at(3), outgoing: false }, // never answered: no sample
    ];
    expect(responseSamples(rows).map((s) => s.hours)).toEqual([5, 1]);
  });

  it('does not measure a reply against a message with the same timestamp that it answers', () => {
    const rows = [{ thread: 'a', date: at(0), outgoing: true }, { thread: 'a', date: at(0), outgoing: false }];
    expect(responseSamples(rows)).toEqual([]);
  });

  it('summarises overall and by local week (Monday start)', () => {
    const samples = [
      { at: new Date('2026-08-31T10:00:00Z'), hours: 2 }, // Mon 31 Aug
      { at: new Date('2026-09-06T10:00:00Z'), hours: 4 }, // Sun 6 Sep, same week
      { at: new Date('2026-09-06T23:30:00Z'), hours: 10 }, // Mon 7 Sep in Berlin (UTC+2)
    ];
    const utc = summarizeResponseTimes(samples, 'UTC');
    expect(utc).toMatchObject({ median_hours: 4, samples: 3 });
    expect(utc.p90_hours).toBeCloseTo(8.8);
    expect(utc.weekly).toEqual([{ week: '2026-08-31', median_hours: 4, replies: 3 }]);
    expect(summarizeResponseTimes(samples, 'Europe/Berlin').weekly).toEqual([
      { week: '2026-08-31', median_hours: 3, replies: 2 },
      { week: '2026-09-07', median_hours: 10, replies: 1 },
    ]);
  });

  it('detects a slowing trend only with enough replies on both sides', () => {
    const now = new Date(t0 + 28 * D);
    const mk = (daysAgo, hours) => ({ at: new Date(now.getTime() - daysAgo * D), hours });
    const samples = [mk(20, 2), mk(18, 2), mk(16, 2), mk(10, 6), mk(5, 6), mk(1, 6)];
    expect(responseTrend(samples, { now })).toMatchObject({ recent_hours: 6, previous_hours: 2, ratio: 3 });
    expect(responseTrend(samples.slice(0, 5), { now })).toBeNull();
    expect(responseTrendCard(responseTrend(samples, { now }))).toMatchObject({ key: 'response_trend', severity: 'warn' });
  });
});

describe('card builders', () => {
  const now = t0 + 10 * D;
  const own = new Set(['me@x.example']);
  const thread = (over) => ({ id: over.id, outgoing: false, bulk: false, resolved_at: null, category: null, needs_you: null, date: new Date(now - 5 * D), subject: 'Hi', from_name: 'Sam', to_addresses: [{ address: 'me@x.example' }], ...over });

  it('counts replies owed from triage when present and direct mail otherwise', () => {
    const card = oweRepliesCard([
      thread({ id: 'm1' }), // direct, 5 days
      thread({ id: 'm2', date: new Date(now - D) }), // too recent
      thread({ id: 'm3', bulk: true }), // newsletter
      thread({ id: 'm4', to_addresses: [{ address: 'list@x.example' }] }), // not addressed to the user
      thread({ id: 'm5', category: 'needs_you', needs_you: true, to_addresses: [], date: new Date(now - 9 * D) }),
      thread({ id: 'm6', category: 'notifications', needs_you: false }),
      thread({ id: 'm7', outgoing: true }),
    ], own, { now });
    expect(card.sources).toEqual(['m1', 'm5']);
    expect(card.title).toBe('You owe 2 replies older than 3 days');
    expect(card.severity).toBe('alert');
    expect(card.body).toContain('[2]');
    expect(oweRepliesCard([thread({ id: 'm2', date: new Date(now - D) })], own, { now })).toBeNull();
  });

  it('suggests unsubscribing from newsletters never opened', () => {
    const card = newsletterCard({ incoming: 10, bulk: 5 }, [
      { from_email: 'a@news.example', from_name: 'A News', count: 4, opened: 0, sample_id: 's1' },
      { from_email: 'b@news.example', from_name: 'B News', count: 4, opened: 1, sample_id: 's2' },
    ]);
    expect(card).toMatchObject({ key: 'newsletters', sources: ['s1'], data: { unsubscribe: ['a@news.example'], share: 0.5 } });
    expect(newsletterCard({ incoming: 10, bulk: 1 }, [])).toBeNull();
  });

  it('flags overdue promises and cites only those with a source', () => {
    const card = overdueCommitmentsCard([
      { id: 'c1', direction: 'i_owe', what: 'send the form', counterparty: 'Priya', due_at: new Date(now - 2 * D), source_message_id: 'm9' },
      { id: 'c2', direction: 'i_owe', what: 'call back', due_at: new Date(now - D), source_message_id: null },
      { id: 'c3', direction: 'they_owe', what: 'pay', due_at: new Date(now - D), source_message_id: 'm8' },
    ], { now });
    expect(card.sources).toEqual(['m9']);
    expect(card.data.commitment_ids).toEqual(['c1', 'c2']);
    expect(card.body).toMatch(/send the form to Priya — due 2 days ago \[1\]/);
  });

  it('spots a sender spike against their usual volume', () => {
    expect(senderSpikeCard([{ from_email: 'x@y.example', from_name: 'X', this_week: 9, prior_weeks_avg: 1, sample_id: 's' }])).toMatchObject({ key: 'sender_spike:x@y.example', sources: ['s'] });
    expect(senderSpikeCard([{ from_email: 'x@y.example', this_week: 9, prior_weeks_avg: 4, sample_id: 's' }])).toBeNull();
  });

  it('keeps only well-formed plugin cards', () => {
    const cards = normalisePluginCards([
      { title: 'From plugin', body: 'b', severity: 'nope', sources: ['m1', 5], data: { x: 1 } },
      [{ title: '  ' }, null, 'junk'],
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: 'From plugin', severity: 'info', sources: ['m1'], data: { x: 1 } });
    expect(cards[0].key).toMatch(/^plugin:/);
  });
});

describe('card storage', () => {
  beforeEach(() => { db.state.insights = []; db.state.state.clear(); });
  const card = (over = {}) => ({ key: 'owe_replies', title: 'You owe 1 reply', body: 'b', severity: 'warn', sources: ['m1'], data: {}, ...over });
  const now = Date.parse('2026-09-23T10:00:00Z');

  it('keeps one card per key per local day, updating it in place', async () => {
    await storeCards(USER, [card()], { now });
    const listed = await storeCards(USER, [card({ title: 'You owe 2 replies', sources: ['m1', 'm2'] })], { now: now + H });
    expect(db.state.insights).toHaveLength(1);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ title: 'You owe 2 replies', sources: ['m1', 'm2'] });
    await storeCards(USER, [card()], { now: now + D });
    expect(db.state.insights).toHaveLength(2);
  });

  it('uses the local day in the user timezone', async () => {
    // 23:30 UTC on the 23rd is already the 24th in Tokyo: a new card day.
    await storeCards(USER, [card()], { now: Date.parse('2026-09-23T10:00:00Z'), tz: 'Asia/Tokyo' });
    await storeCards(USER, [card()], { now: Date.parse('2026-09-23T23:30:00Z'), tz: 'Asia/Tokyo' });
    expect(db.state.insights.map((i) => i.period_start.toISOString())).toEqual(['2026-09-22T15:00:00.000Z', '2026-09-23T15:00:00.000Z']);
  });

  it('withdraws cards whose evidence disappeared the same day', async () => {
    await storeCards(USER, [card(), card({ key: 'newsletters', title: 'n', sources: [] })], { now });
    const listed = await storeCards(USER, [card()], { now: now + H });
    expect(listed.map((c) => c.data.key)).toEqual(['owe_replies']);
  });

  it('does not bring back a dismissed card while its evidence is unchanged', async () => {
    await storeCards(USER, [card()], { now });
    db.state.insights[0].dismissed_at = new Date(now);
    expect(await storeCards(USER, [card()], { now: now + D })).toEqual([]);
    const listed = await storeCards(USER, [card({ title: 'You owe 2 replies', sources: ['m1', 'm2'] })], { now: now + D });
    expect(listed).toHaveLength(1);
  });
});

describe('briefings', () => {
  const now = Date.parse('2026-09-23T07:00:00Z');
  const needs = {
    message: { id: 'aaaaaaaa-0000-4000-8000-000000000001', from_name: 'Marta', from_email: 'marta@k.example', subject: 'Invoice 2041', date: new Date(now - 13 * H), snippet: '€1,840 due' },
    triage: { reason_label: 'Asks you to pay' },
  };
  beforeEach(() => {
    db.state.insights = [];
    db.state.state.clear();
    db.state.commitments = [{ id: 'c1', direction: 'i_owe', counterparty: 'Priya', what: 'signed form', due_at: new Date(now + 7 * D), source_message_id: 'aaaaaaaa-0000-4000-8000-000000000002' }];
    triage.listTriage = async (_u, { view }) => ({ items: view === 'needs_you' ? [needs] : [], counts: {} });
  });

  it('falls back to a deterministic briefing when the model is unavailable', async () => {
    llm.chat = async () => { throw Object.assign(new Error('model features are disabled'), { code: 'llm_disabled' }); };
    const b = await composeBriefing(USER, { now });
    expect(b.data.generated_by).toBe('deterministic');
    expect(b.data.model_error).toBe('llm_disabled');
    expect(b.sources).toEqual(['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']);
    expect(b.body).toContain('### Needs you');
    expect(b.body).toContain('**Marta** — Invoice 2041 · 13 h ago [1]');
    expect(b.body).toContain('You owe Priya: signed form — due in 7 days [2]');
    expect(b.data.cited).toEqual([1, 2]);
    expect(b.title).toBe('Daily briefing · Wed 23 Sept');
  });

  it('falls back when the model answers with nothing usable', async () => {
    llm.chat = async () => ({ content: '<think>hmm</think>\n##' });
    const b = await composeBriefing(USER, { now });
    expect(b.data.generated_by).toBe('deterministic');
    expect(b.body.length).toBeGreaterThan(20);
  });

  it('is never empty, even with no evidence at all', async () => {
    triage.listTriage = async () => ({ items: [] });
    db.state.commitments = [];
    llm.chat = async () => { throw new Error('gateway 502'); };
    const b = await composeBriefing(USER, { now });
    expect(b.body).toContain('Nothing needs you today.');
    expect(b.sources).toEqual([]);
  });

  it('keeps model prose but drops citations that point at nothing', async () => {
    llm.chat = async (opts) => {
      expect(opts).toMatchObject({ feature: 'insights', role: 'long' });
      expect(opts.messages[1].content).toContain('[1] from Marta');
      return { content: 'Pay Marta\'s invoice today [1, 7]. Priya needs the form [2][9].' };
    };
    const b = await composeBriefing(USER, { now });
    expect(b.data.generated_by).toBe('model');
    expect(b.body).toBe('Pay Marta\'s invoice today [1]. Priya needs the form [2].');
  });

  it('renders the weekly review sections', () => {
    const body = renderDeterministic({
      period: 'week', tz: 'UTC', now, volume: { received: 40, sent: 12 }, needsYou: [], waitingOn: [], commitments: [], topics: [],
      cards: [], topSenders: [{ from_email: 'p@x', from_name: 'Priya', count: 5 }], commitmentStats: { done: 2, open: 3 }, trend: null,
    });
    expect(body).toContain('40 received, 12 sent this week');
    expect(body).toContain('- Most mail from: Priya (5)');
    expect(body).toContain('Nothing is waiting on you from this week.');
  });

  it('sanitises citations and strips thinking', () => {
    expect(sanitizeCitations('a [1] b [0] c [3, 2] d [12]', 3)).toEqual({ text: 'a [1] b  c [3][2] d', cited: [1, 2, 3] });
    expect(stripThinking('<think>secret</think> Hello')).toBe('Hello');
  });
});

describe('scheduling helpers', () => {
  it('is due once per local day at or after the briefing time', () => {
    const now = new Date('2026-09-23T06:30:00Z'); // 08:30 in Berlin
    expect(isDue({ now, tz: 'Europe/Berlin', briefingTime: '08:00', lastDay: null })).toMatchObject({ due: true, day: '2026-09-23', weekday: 3 });
    expect(isDue({ now, tz: 'Europe/Berlin', briefingTime: '09:00', lastDay: null }).due).toBe(false);
    expect(isDue({ now, tz: 'Europe/Berlin', briefingTime: '08:00', lastDay: '2026-09-23' }).due).toBe(false);
    expect(isDue({ now, tz: 'UTC', briefingTime: 'garbage', lastDay: null }).due).toBe(false); // falls back to 07:00
  });

  it('clamps overview days', () => {
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays('7')).toBe(7);
    expect(clampDays(0)).toBe(30);
    expect(clampDays(5000)).toBe(365);
  });
});
