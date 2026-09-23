// Spam precision and rescue: the production false positives (plane.so, bookmyshow, Amazon's CDN),
// the rescue score, the rescue sweep recording its state, and re-judging stored verdicts.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

const db = { calls: [], handler: null };
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params) => {
    db.calls.push({ sql, params });
    if (db.handler) {
      const out = await db.handler(sql, params);
      if (out) return out;
    }
    if (/INSERT INTO hedwig_ai_calls/.test(sql)) return { rows: [{ id: 1 }] };
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';
const gw = mockGateway();
let cfg = {};
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) };
});

const { SCHEMA } = await import('../config.js');
const DEFAULTS = Object.fromEntries(SCHEMA.map((f) => [f.key, f.default]));
function resetConfig(over = {}) {
  cfg = {
    ...DEFAULTS, 'llm.baseUrl': gw.baseUrl, 'llm.catalogUrl': gw.catalogUrl, 'llm.models.fast': GEMMA, 'llm.models.long': QWEN,
    'llm.fallbackModel': '', 'llm.timeoutMs': 5000, ...over,
  };
}
resetConfig();

const spam = await import('./spam.js');
const engine = await import('./engine.js');
const { _resetPrompts } = await import('../prompts/index.js');
const { _resetLlmState } = await import('../llm.js');

const ME = new Set(['me@example.com']);
const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TRUSTED_PASS = { spf: 'pass', dkim: 'pass', dmarc: 'pass', trusted: true };

function msg(over = {}) {
  return {
    id: over.id || '00000000-0000-4000-8000-000000000001',
    account_id: ACCOUNT, user_id: USER, folder: 'INBOX', subject: 'Hello', from_name: 'Alex Morgan', from_email: 'alex@example.org',
    to_addresses: [{ address: 'me@example.com' }], cc_addresses: [], reply_to: [], date: new Date(Date.now() - 86400_000),
    is_bulk: false, list_unsubscribe: null, category: null, has_attachments: false, attachments: [], thread_key: 't1',
    body_text: 'Hi, are you free on Thursday to talk about the lease?', body_html: null, user_addresses: ME, is_outgoing: false,
    spam_details: null, spam_verdict: null, spam_user_override: null, spam_score_ml: null,
    ...over,
  };
}
const junk = (over = {}) => msg({ folder: 'Bulk', special_use: '\\Junk', ...over });
const signalNames = (row, ctx) => spam.phishingSignals(row, ctx).map((s) => s.name);

beforeEach(() => {
  db.calls.length = 0;
  db.handler = null;
  resetConfig();
});

afterAll(() => gw.restore());

// ── Phishing precision: the production false positives ─────────────────────

describe('phishing precision', () => {
  it('plane.so is not a lookalike of planet.com (short names need a same-length one-letter swap)', () => {
    const row = msg({ from_name: 'Plane', from_email: 'hello@plane.so', subject: 'Your workspace digest' });
    expect(spam.lookalikeOf('plane.so', ['planet.com'])).toBeNull();
    expect(signalNames(row, { knownDomains: ['planet.com'] })).not.toContain('lookalike');
    expect(spam.assessSpam(row, { knownDomains: ['planet.com'] }).verdict).toBe('clean');
    // A real one-letter swap of a domain the user writes to is still caught.
    expect(spam.lookalikeOf('vantaqe.example', ['vantage.example'])).toBe('vantage.example');
    expect(spam.lookalikeOf('amazom.com', ['amazon.com'])).toBe('amazon.com');
    expect(spam.lookalikeOf('ymail.com', ['gmail.com'])).toBeNull(); // mail providers are not lookalikes of each other
  });

  it('the same brand on two suffixes is not a lookalike (bookmyshow.com vs bookmyshow.email)', () => {
    const row = msg({ from_name: 'BookMyShow', from_email: 'tickets@bookmyshow.com', subject: 'Your tickets for Dune' });
    expect(spam.lookalikeOf('bookmyshow.com', ['bookmyshow.email'])).toBeNull();
    expect(spam.lookalikeOf('in.bookmyshow.com', ['bookmyshow.email'])).toBeNull();
    const v = spam.assessSpam(row, { knownDomains: ['bookmyshow.email'] });
    expect(v.verdict).toBe('clean');
    expect(v.signals.map((s) => s.name)).not.toContain('lookalike');
  });

  it('near misses only count against domains the user corresponds with, and not when the sender authenticates', () => {
    expect(spam.lookalikeOf('amazom.com')).toBeNull(); // amazon.com is a brand, not a correspondent here
    const row = msg({ from_email: 'accounts@vantaqe.example' });
    expect(signalNames(row, { knownDomains: ['vantage.example'] })).toContain('lookalike');
    expect(signalNames(row, { knownDomains: ['vantage.example'], auth: TRUSTED_PASS })).not.toContain('lookalike');
    // Homoglyph swaps of well-known brands stay caught, whatever the authentication says.
    expect(signalNames(msg({ from_email: 'service@paypa1.com' }), { auth: TRUSTED_PASS })).toContain('lookalike');
    expect(spam.lookalikeOf('paypal-secure-login.com')).toBe('paypal.com');
    expect(spam.lookalikeOf('paypal-community.com')).toBeNull();
  });

  it("Amazon's own CDN and Wikimedia images are not foreign links", () => {
    const row = msg({
      from_name: 'Amazon', from_email: 'account-update@amazon.com', subject: 'Unusual sign-in activity on your account',
      body_html: '<img src="https://m.media-amazon.com/images/G/01/logo.png"><img src="https://upload.wikimedia.org/x.svg"><p>If this was not you, verify your account in the Amazon app.</p>',
    });
    const text = 'If this was not you, verify your account in the Amazon app.';
    expect(signalNames(row, { text })).not.toContain('linkDomain');
    expect(spam.assessSpam(row, { text }).verdict).not.toBe('phishing');
    expect(spam.assessSpam(row, { text, auth: TRUSTED_PASS }).verdict).toBe('clean');
    expect(spam.sameFamily('media-amazon.com', 'amazon.com')).toBe(true);
    expect(spam.trustedLinkHost('upload.wikimedia.org')).toBe(true);
    expect(spam.trustedLinkHost('u123.ct.sendgrid.net')).toBe(true);
  });

  it('keeps the real phish: a credential lure whose links go to unrelated domains', () => {
    const row = msg({
      from_name: 'SBT Trust', from_email: 'alerts@sbttrust.com', subject: 'Your account will be suspended',
      body_html: '<a href="https://login.fefpc.com/sbt">Verify your account</a> <a href="https://strategicsystems.shop/r">here</a>',
    });
    const text = 'Your account will be suspended. Verify your account now.';
    const v = spam.assessSpam(row, { text });
    expect(v.verdict).toBe('phishing');
    expect(v.reason).toMatch(/Links go to fefpc\.com, strategicsystems\.shop, not sbttrust\.com/);
    expect(v.reason).toMatch(/verify an account/); // both signals explain the verdict
  });

  it('a link mismatch does not make phishing when DMARC passes; one signal alone is only suspected', () => {
    const row = msg({
      from_email: 'billing@shop.example', subject: 'Update your billing details',
      body_html: '<a href="https://pay.checkout-partner.example/x">Update your payment details</a>',
    });
    const text = 'Please update your payment details.';
    expect(spam.assessSpam(row, { text }).verdict).toBe('phishing');
    const passed = spam.assessSpam(row, { text, auth: TRUSTED_PASS });
    expect(passed.verdict).not.toBe('phishing');
    expect(passed.signals.find((s) => s.name === 'linkDomain').label).toMatch(/passed DMARC/);

    const lookalikeOnly = spam.assessSpam(msg({ from_email: 'hr@vantaqe.example' }), { knownDomains: ['vantage.example'] });
    expect(lookalikeOnly.verdict).toBe('suspected');
    expect(lookalikeOnly.reason).toMatch(/looks like vantage\.example \(one sign of phishing\)/);
    // A trusted authentication failure plus one sign is enough.
    const failed = spam.assessSpam(msg({ from_email: 'hr@vantaqe.example' }), { knownDomains: ['vantage.example'], auth: { dmarc: 'fail', trusted: true } });
    expect(failed.verdict).toBe('phishing');
    expect(spam.phishingDecision([{ name: 'lookalike', weight: 0.55 }], {}).phishing).toBe(false);
  });

  it('reads spam.trustedLinkHosts from config, whose default matches the module list', () => {
    const def = SCHEMA.find((f) => f.key === 'spam.trustedLinkHosts');
    expect(def.default).toEqual([...spam.DEFAULT_TRUSTED_LINK_HOSTS]);
    const row = msg({ from_email: 'a@shop.example', subject: 'Verify your account', body_html: '<a href="https://go.partner.example/x">x</a>' });
    expect(signalNames(row, { text: 'verify your account' })).toContain('linkDomain');
    expect(signalNames(row, { text: 'verify your account', trustedLinkHosts: ['partner.example'] })).not.toContain('linkDomain');
  });
});

// ── Rescue score ────────────────────────────────────────────────────────────

describe('rescue score', () => {
  const above = 0.7;
  it('any one strong sign that you know the sender reaches spam.rescueAbove on its own', () => {
    expect(spam.rescueScore({ row: msg(), sender: { replied: 1 } }).score).toBeGreaterThanOrEqual(above);
    expect(spam.rescueScore({ row: msg(), wroteTo: true }).score).toBeGreaterThanOrEqual(above);
    expect(spam.rescueScore({ row: msg(), replyToOwn: true }).score).toBeGreaterThanOrEqual(above);
    expect(spam.rescueScore({ row: msg(), decision: 'people', decisionSource: 'user' }).score).toBeGreaterThanOrEqual(above);
    expect(spam.rescueScore({ row: msg(), markedNotSpam: true }).score).toBeGreaterThanOrEqual(above);
    expect(spam.rescueScore({ row: msg(), wroteTo: true, auth: TRUSTED_PASS }).reasons).toEqual(expect.arrayContaining(['Passed DMARC']));
  });

  it('an order or receipt from a shop you already buy from, with or without an order number', () => {
    const tickets = spam.rescueScore({ row: msg({ from_email: 'tickets@bookmyshow.com', subject: 'Your tickets for Dune: Part Three' }), orderDomains: ['in.bookmyshow.com'] });
    expect(tickets.score).toBeGreaterThanOrEqual(above);
    expect(tickets.reasons[0]).toBe('Looks like an order you placed with bookmyshow.com');
    expect(spam.rescueScore({ row: msg({ from_email: 'tickets@bookmyshow.com', subject: 'Your tickets' }) }).score).toBeLessThan(above);
  });

  it('weak signs alone are borderline, an automatic screen is weak, block and phishing pull it down', () => {
    const s1 = { senderKind: 'person', flags: { to: true, question: true } };
    const weak = spam.rescueScore({ row: msg(), auth: TRUSTED_PASS, s1 });
    expect(weak.score).toBeGreaterThanOrEqual(above - 0.35);
    expect(weak.score).toBeLessThan(above);
    expect(spam.rescueScore({ row: msg(), decision: 'reading', decisionSource: 'auto' }).score).toBeLessThan(above);
    expect(spam.rescueScore({ row: msg(), sender: { replied: 4 }, decision: 'block' }).score).toBe(0);
    const phishy = spam.rescueScore({ row: msg(), sender: { replied: 1 }, phishingScore: 0.55 });
    expect(phishy.score).toBeLessThan(above);
    expect(phishy.reasons.join(' ')).toMatch(/Signs of phishing/);
  });
});

// ── Engine: rescue sweep, every sort path, re-evaluation ────────────────────

/** A small in-memory stand-in for the tables the rescue paths touch. */
function fakeDb({ rows = [], stats = {}, sorts = {}, sentTo = {}, threads = {}, known = [] } = {}) {
  const state = new Map();
  const sort = new Map(Object.entries(sorts));
  const jobs = [];
  const logs = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  db.handler = (sql, params) => {
    if (/SELECT value FROM hedwig_state WHERE key/.test(sql)) return { rows: state.has(params[0]) ? [{ value: state.get(params[0]) }] : [] };
    if (/INSERT INTO hedwig_state/.test(sql)) { state.set(params[0], JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    if (/lower\(a\.email_address\) AS email/.test(sql)) return { rows: [{ user_id: USER, email: 'me@example.com' }] };
    if (/LEFT JOIN hedwig_sort s ON s\.message_id = m\.id\s/.test(sql) && /make_interval\(days => \$2\)/.test(sql)) return { rows: rows.map((r) => ({ ...r })) };
    if (/WHERE m\.id = ANY\(\$1::uuid\[\]\) AND a\.user_id = \$2 AND NOT m\.is_deleted/.test(sql)) return { rows: params[0].map((id) => byId.get(id)).filter(Boolean).map((r) => ({ ...r })) };
    if (/s\.in_spam_folder OR s\.spam = 'phishing'/.test(sql)) return { rows: [...sort.keys()].filter((id) => !params[1] || id > params[1]).sort().map((id) => ({ message_id: id })) };
    if (/SELECT message_id, spam FROM hedwig_sort/.test(sql)) return { rows: params[1].filter((id) => sort.has(id)).map((id) => ({ message_id: id, spam: sort.get(id).spam })) };
    if (/SELECT message_id, layer, stream, spam, pending FROM hedwig_sort/.test(sql)) return { rows: params[1].filter((id) => sort.has(id)).map((id) => ({ message_id: id, ...sort.get(id) })) };
    if (/FROM hedwig_sender_stats WHERE user_id = \$1 AND sender_email = ANY/.test(sql)) return { rows: Object.entries(stats).map(([e, s]) => ({ sender_email: e, ...s })) };
    if (/UNION\s+SELECT CASE WHEN scope/.test(sql)) return { rows: known.map((d) => ({ domain: d })) };
    if (/AS reply_to_own/.test(sql)) return { rows: Object.entries(threads).map(([id, t]) => ({ id, reply_to_own: Boolean(t.replyToOwn), replied_after: false })) };
    if (/jsonb_array_elements/.test(sql) && /GROUP BY 1/.test(sql)) return { rows: Object.entries(sentTo).map(([email, n]) => ({ email, n })) };
    if (/COUNT\(\*\)::int AS n FROM hedwig_bundles/.test(sql)) return { rows: [{ n: 99 }] };
    if (/INSERT INTO hedwig_sort_log/.test(sql)) { logs.push({ action: params[2], to: JSON.parse(params[4]) }); return { rows: [{ id: logs.length }] }; }
    if (/INSERT INTO hedwig_sort\b/.test(sql)) {
      sort.set(params[0], { layer: params[12], stream: params[3], spam: params[9], spam_reason: params[10], signals: JSON.parse(params[14]), in_spam_folder: params[23] });
      return { rows: [{ message_id: params[0], stream: params[3] }] };
    }
    if (/INSERT INTO hedwig_jobs/.test(sql)) { jobs.push({ kind: params[0], payload: JSON.parse(params[1]), userId: params[2], dedupeKey: params[3] }); return { rows: [{ id: jobs.length }] }; }
    if (/SELECT DISTINCT user_id FROM email_accounts WHERE enabled/.test(sql)) return { rows: [{ user_id: USER }] };
    return null;
  };
  return { state, sort, jobs, logs };
}

describe('rescue sweep', () => {
  let logSpy;
  beforeEach(() => {
    gw.reset().install();
    _resetPrompts();
    _resetLlmState();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  const REPLIED = '00000000-0000-4000-8000-0000000000c1';
  const STRANGER = '00000000-0000-4000-8000-0000000000c2';

  it('re-judges spam-folder mail the classifier already sorted, rescues replied-to senders, records its state and logs a line', async () => {
    const rows = [
      junk({ id: REPLIED, from_name: 'Dana Kim', from_email: 'dana@studio.example', subject: 'Contract draft' }),
      junk({ id: STRANGER, from_name: 'Deals', from_email: 'win@prize-now.example', subject: 'You won', body_text: 'Claim your prize today', to_addresses: [] }),
    ];
    const fake = fakeDb({
      rows,
      stats: { 'dana@studio.example': { replied: 3, received: 5, domain: 'studio.example' } },
      // What production had: every spam-folder row already stored by the classifier.
      sorts: { [REPLIED]: { layer: 'classifier', stream: 'spam', spam: 'suspected' }, [STRANGER]: { layer: 'classifier', stream: 'spam', spam: 'suspected' } },
    });
    const res = await engine.rescueSweep({ userIds: [USER] });
    expect(res).toMatchObject({ users: 1, scanned: 2, rescued: 1, errors: 0 });

    const candidates = db.calls.find((c) => /make_interval\(days => \$2\)/.test(c.sql) && /hedwig_sort s ON/.test(c.sql));
    expect(candidates.sql).toMatch(/s\.message_id IS NULL OR/); // sorted rows are candidates too
    expect(candidates.params[4]).toBe(JSON.stringify([{ name: 'rescue', v: spam.SPAM_SIGNALS_VERSION }]));

    expect(fake.sort.get(REPLIED)).toMatchObject({ spam: 'rescued', in_spam_folder: true });
    expect(fake.sort.get(REPLIED).stream).not.toBe('spam');
    expect(fake.sort.get(REPLIED).spam_reason).toMatch(/You have replied to Dana Kim/);
    expect(fake.sort.get(REPLIED).signals[0]).toMatchObject({ name: 'rescue', v: spam.SPAM_SIGNALS_VERSION });
    expect(fake.sort.get(STRANGER)).toMatchObject({ spam: 'suspected', stream: 'spam' });
    expect(fake.sort.get(STRANGER).signals[0].label).toMatch(/no sign you know this sender/);
    expect(fake.logs.filter((l) => l.action === 'rescue')).toHaveLength(1);

    expect(fake.state.get('schedule.sort.rescue')).toMatchObject({ users: 1, scanned: 2, rescued: 1, signalsVersion: spam.SPAM_SIGNALS_VERSION, at: expect.any(String) });
    const line = logSpy.mock.calls.map((c) => c[0]).find((l) => /sort\.rescue:/.test(l));
    expect(line).toMatch(/2 spam-folder message\(s\) checked for 1 user\(s\), 1 rescued/);

    // A second run over the same rows does not log the rescue again.
    await engine.rescueSweep({ userIds: [USER] });
    expect(fake.logs.filter((l) => l.action === 'rescue')).toHaveLength(1);
  });

  it('rescues on the sender you wrote to, and on a reply in a thread you wrote in', async () => {
    const WROTE = '00000000-0000-4000-8000-0000000000c3';
    const THREAD = '00000000-0000-4000-8000-0000000000c4';
    const fake = fakeDb({
      rows: [
        junk({ id: WROTE, from_email: 'lee@agency.example', from_name: 'Lee', subject: 'Invoice 42', to_addresses: [] }),
        junk({ id: THREAD, from_email: 'noreply@forms.example', from_name: 'Forms', subject: 'Re: your application', to_addresses: [] }),
      ],
      sentTo: { 'lee@agency.example': 2 },
      threads: { [THREAD]: { replyToOwn: true } },
    });
    await engine.rescueSweep({ userIds: [USER] });
    expect(fake.sort.get(WROTE)).toMatchObject({ spam: 'rescued' });
    expect(fake.sort.get(WROTE).spam_reason).toMatch(/You have written to Lee/);
    expect(fake.sort.get(THREAD)).toMatchObject({ spam: 'rescued' });
    expect(fake.sort.get(THREAD).spam_reason).toMatch(/A reply in a thread you wrote in/);
  });

  it('asks spam.reflex about borderline mail and rescues what it confirms', async () => {
    const BORDER = '00000000-0000-4000-8000-0000000000c5';
    gw.on('spam.reflex', () => ({ items: [{ id: 'm1', verdict: 'legit', confidence: 0.9, reason: 'A person asking you about a booking' }] }));
    const fake = fakeDb({
      rows: [junk({ id: BORDER, from_email: 'maria@guesthouse.example', from_name: 'Maria', subject: 'Your stay', body_text: 'Hi, can you confirm your arrival time on Friday?', spam_details: { authTrusted: true, rulesFired: [] } })],
    });
    await engine.rescueSweep({ userIds: [USER] });
    expect(gw.callsFor('spam.reflex')).toHaveLength(1);
    expect(fake.sort.get(BORDER)).toMatchObject({ spam: 'rescued', layer: 'reflex' });
  });

  it('a spam-folder message re-sorted on another path (body landed, retrain) is judged by rescue, not overwritten', async () => {
    const fake = fakeDb({
      rows: [],
      stats: { 'dana@studio.example': { replied: 2, received: 2 } },
      sorts: { [REPLIED]: { layer: 'classifier', stream: 'screener', spam: 'rescued' } },
    });
    await engine.sortRows([junk({ id: REPLIED, from_name: 'Dana Kim', from_email: 'dana@studio.example' })]);
    expect(fake.sort.get(REPLIED).spam).toBe('rescued');
  });
});

describe('re-evaluating stored spam verdicts', () => {
  beforeEach(() => {
    gw.reset().install();
    _resetPrompts();
    _resetLlmState();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const PLANE = '00000000-0000-4000-8000-0000000000d1';
  const BMS = '00000000-0000-4000-8000-0000000000d2';
  const DANA = '00000000-0000-4000-8000-0000000000d3';

  it('fixes false phishing flags and missing rescues once, then records the signals version', async () => {
    const rows = [
      msg({ id: PLANE, from_name: 'Plane', from_email: 'hello@plane.so', subject: 'Weekly digest', is_bulk: true }),
      junk({ id: BMS, from_name: 'BookMyShow', from_email: 'tickets@bookmyshow.com', subject: 'Offers this weekend', is_bulk: true, to_addresses: [] }),
      junk({ id: DANA, from_name: 'Dana Kim', from_email: 'dana@studio.example', subject: 'Contract draft' }),
    ];
    const fake = fakeDb({
      rows,
      known: ['planet.com', 'bookmyshow.email'],
      stats: { 'dana@studio.example': { replied: 1, received: 3 } },
      sorts: {
        [PLANE]: { layer: 'classifier', stream: 'spam', spam: 'phishing' },
        [BMS]: { layer: 'classifier', stream: 'spam', spam: 'phishing' },
        [DANA]: { layer: 'classifier', stream: 'spam', spam: 'suspected' },
      },
    });
    const res = await engine.runReevaluateSpamJob({}, { user_id: USER });
    expect(res).toMatchObject({ checked: 3, done: true });
    expect(fake.sort.get(PLANE).spam).toBe('clean');
    expect(fake.sort.get(PLANE).stream).not.toBe('spam');
    expect(fake.sort.get(BMS)).toMatchObject({ spam: 'suspected', stream: 'spam' }); // still the provider's spam, no longer phishing
    expect(fake.sort.get(BMS).spam_reason).not.toMatch(/looks like/);
    expect(fake.sort.get(DANA).spam).toBe('rescued');
    expect(fake.state.get(`spam.signalsVersion:${USER}`)).toMatchObject({ version: spam.SPAM_SIGNALS_VERSION, checked: 3, doneAt: expect.any(String) });
    expect(fake.state.get(`spam.signalsVersion:${USER}`).changed).toMatchObject({ 'phishing→clean': 1, 'phishing→suspected': 1, 'suspected→rescued': 1 });
    expect(fake.jobs.filter((j) => j.kind === 'sort.reevaluateSpam')).toHaveLength(0); // one batch, no continuation
  });

  it('is enqueued once per user when the signals version changes, and not again', async () => {
    const fake = fakeDb();
    fake.state.set('spam.signalsVersion', { version: '2026-09-23.0' });
    const first = await engine.ensureSpamSignalsCurrent();
    expect(first).toEqual({ version: spam.SPAM_SIGNALS_VERSION, enqueued: 1 });
    expect(fake.jobs).toEqual([expect.objectContaining({ kind: 'sort.reevaluateSpam', userId: USER, dedupeKey: `sort.reevaluateSpam:${USER}:${spam.SPAM_SIGNALS_VERSION}:start` })]);
    expect(fake.state.get('spam.signalsVersion')).toMatchObject({ version: spam.SPAM_SIGNALS_VERSION, previous: '2026-09-23.0' });
    expect(await engine.ensureSpamSignalsCurrent()).toBeNull();
    expect(fake.jobs).toHaveLength(1);
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────

describe('rescue wiring', () => {
  it('the worker registers the rescue and re-evaluation jobs and both schedules', async () => {
    const { definedSchedules, _resetSchedules } = await import('../schedule.js');
    const { jobKinds, _resetJobs } = await import('../jobs.js');
    _resetSchedules();
    _resetJobs();
    const sort = (await import('./index.js')).default;
    sort.worker();
    const schedules = definedSchedules().map((s) => s.name);
    expect(schedules).toEqual(expect.arrayContaining(['sort.rescue', 'sort.spamSignals']));
    expect(jobKinds().map((j) => j.kind)).toEqual(expect.arrayContaining(['sort.rescue', 'sort.reevaluateSpam']));
    _resetSchedules();
    _resetJobs();
  });

  it('POST /sort/rescue/run queues a full check for the signed-in user; admin can queue any user', async () => {
    const { mountSortRoutes, mountSortAdminRoutes } = await import('./routes.js');
    const routes = [];
    const router = {};
    for (const m of ['get', 'post', 'patch', 'delete']) router[m] = (path, h) => routes.push({ method: m.toUpperCase(), path, h });
    mountSortRoutes(router);
    const run = routes.find((r) => r.method === 'POST' && r.path === '/sort/rescue/run').h;
    const fake = fakeDb();
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await run({ body: { userId: 'someone-else' }, session: { userId: USER } }, res);
    expect(res.body).toMatchObject({ queued: true, jobId: 1 });
    expect(fake.jobs[0]).toMatchObject({ kind: 'sort.rescue', userId: USER, payload: { all: true } });

    const admin = [];
    const ar = {};
    for (const m of ['get', 'post']) ar[m] = (path, h) => admin.push({ method: m.toUpperCase(), path, h });
    mountSortAdminRoutes(ar);
    expect(admin.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(['GET /sort/rescue', 'POST /sort/rescue/run', 'POST /sort/spam/reevaluate']));
    const bad = { ...res, code: 200 };
    await admin.find((r) => r.path === '/sort/rescue/run').h({ body: { userId: 'nope' }, session: { userId: USER }, method: 'POST', originalUrl: '/x' }, bad);
    expect(bad.code).toBe(400);
  });

  it('undoing a rescue is the user’s decision, so later sweeps leave it in spam', async () => {
    const service = await import('./service.js');
    db.handler = (sql) => {
      if (/FROM hedwig_sort_log WHERE id/.test(sql)) return { rows: [{ id: 7, action: 'rescue', message_id: '00000000-0000-4000-8000-0000000000e1', from: {}, to: {} }] };
      if (/UPDATE hedwig_sort_log SET undone_at/.test(sql)) return { rows: [{ id: 7 }] };
      return null;
    };
    await service.undo(USER, { logId: 7 });
    const upd = db.calls.find((c) => /UPDATE hedwig_sort SET spam = 'suspected'/.test(c.sql));
    expect(upd.sql).toMatch(/layer = 'user'/);
  });
});
