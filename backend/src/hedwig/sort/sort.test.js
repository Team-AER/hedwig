import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
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

const headers = await import('./headers.js');
const spam = await import('./spam.js');
const rules = await import('./rules.js');
const reflex = await import('./reflex.js');
const bundles = await import('./bundles.js');
const classifier = await import('./classifier.js');
const engine = await import('./engine.js');
const senders = await import('./senders.js');
const { train } = await import('../triage/model.js');
const { _resetPrompts } = await import('../prompts/index.js');
const { _resetLlmState } = await import('../llm.js');
const reflexPrompt = (await import('../prompts/sort.reflex.js')).default;

const NOW = new Date('2026-09-23T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400_000);
const ME = new Set(['me@example.com']);
const USER = '11111111-1111-4111-8111-111111111111';

function msg(over = {}) {
  return {
    id: over.id || '00000000-0000-4000-8000-000000000001',
    account_id: '22222222-2222-4222-8222-222222222222',
    user_id: USER,
    folder: 'INBOX',
    subject: 'Hello',
    from_name: 'Alex Morgan',
    from_email: 'alex@example.org',
    to_addresses: [{ address: 'me@example.com' }],
    cc_addresses: [],
    reply_to: [],
    date: daysAgo(1),
    is_bulk: false,
    list_unsubscribe: null,
    category: null,
    has_attachments: false,
    attachments: [],
    thread_key: 't1',
    body_text: 'Hi, are you free on Thursday to talk about the lease?',
    user_addresses: ME,
    is_outgoing: false,
    ...over,
  };
}

beforeEach(() => {
  db.calls.length = 0;
  db.handler = null;
  resetConfig();
});

afterAll(() => gw.restore());

// ── Header layer ────────────────────────────────────────────────────────────

describe('header layer', () => {
  it('treats list mail as Reading and reads the List-Id as the sender key', () => {
    const row = msg({ from_email: 'news@moneystuff.example', is_bulk: true, list_unsubscribe: '<mailto:u@moneystuff.example>', headers: { 'List-Id': 'Money Stuff <money.stuff.example>' } });
    const h = headers.headerLayer(row, { userAddresses: ME });
    expect(h.list).toBe(true);
    expect(h.keys).toEqual({ address: 'news@moneystuff.example', domain: 'moneystuff.example', list: 'money.stuff.example' });
    expect(headers.screenerKey(h.keys)).toEqual({ key: 'money.stuff.example', scope: 'list' });
    expect(h.prior).toMatchObject({ stream: 'reading' });
    expect(h.hard).toBeNull();
    expect(h.signals.map((s) => s.name)).toContain('list');
  });

  it('files calendar MIME, Auto-Submitted and Precedence: bulk', () => {
    const cal = headers.headerLayer(msg({ attachments: [{ filename: 'invite.ics', contentType: 'text/calendar' }] }), { userAddresses: ME });
    expect(cal.calendar).toBe(true);
    expect(cal.prior).toMatchObject({ stream: 'records', bundle: 'calendar' });
    const auto = headers.headerLayer(msg({ headers: ['Auto-Submitted: auto-generated'] }), { userAddresses: ME });
    expect(auto.auto).toBe(true);
    expect(auto.prior.stream).toBe('records');
    expect(headers.isListMail(msg({ headers: { Precedence: 'bulk' } }))).toBe(true);
    expect(headers.isAutoSubmitted(msg({ headers: { 'Auto-Submitted': 'no' } }))).toBe(false);
  });

  it('own sent mail and replies to own threads are always People', () => {
    const own = headers.headerLayer(msg({ from_email: 'me@example.com', is_outgoing: true }), { userAddresses: ME });
    expect(own.hard).toMatchObject({ stream: 'people', confidence: 1, reason: 'You sent this' });
    const reply = headers.headerLayer(msg({ is_bulk: true }), { userAddresses: ME, replyToOwn: true });
    expect(reply.hard).toMatchObject({ stream: 'people', reason: 'A reply in a thread you wrote in' });
  });

  it('marks the server spam folder as a weak signal', () => {
    const h = headers.headerLayer(msg({ folder: 'Junk', special_use: '\\Junk' }), { userAddresses: ME });
    expect(h.spamFolder).toBe(true);
    expect(h.signals.find((s) => s.name === 'spamFolder').weight).toBeLessThan(0.5);
  });

  it('reads Authentication-Results: trusted from upstream analysis, untrusted from a raw header', () => {
    const trusted = headers.authResults(msg({ spam_details: { authTrusted: true, rulesFired: [{ name: 'AUTH_DKIM_FAIL' }] } }));
    expect(trusted).toEqual({ spf: 'pass', dkim: 'fail', dmarc: 'pass', trusted: true });
    const raw = headers.authResults(msg({ headers: { 'Authentication-Results': 'mx.example; spf=softfail smtp.mailfrom=x; dkim=pass; dmarc=fail' } }));
    expect(raw).toEqual({ spf: 'fail', dkim: 'pass', dmarc: 'fail', trusted: false });
    expect(headers.authResults(msg())).toEqual({ spf: null, dkim: null, dmarc: null, trusted: false });
  });
});

// ── Spam and phishing ───────────────────────────────────────────────────────

describe('spam and phishing signals', () => {
  it('finds lookalike domains without flagging the real ones', () => {
    expect(spam.registrable('mail.service.hmrc.gov.uk')).toBe('hmrc.gov.uk');
    expect(spam.registrable('email.apple.com')).toBe('apple.com');
    expect(spam.lookalikeOf('paypa1.com')).toBe('paypal.com');
    expect(spam.lookalikeOf('rnicrosoft.com')).toBe('microsoft.com');
    expect(spam.lookalikeOf('paypal-secure-login.com')).toBe('paypal.com');
    expect(spam.lookalikeOf('mail.paypal.com')).toBeNull();
    expect(spam.lookalikeOf('vantage.example', ['vantage.example'])).toBeNull();
    expect(spam.lookalikeOf('vantaqe.example', ['vantage.example'])).toBe('vantage.example');
    expect(spam.lookalikeOf('github.com')).toBeNull();
  });

  it('flags reply-to and link domains that differ from the sender, and trusted auth failures', () => {
    const row = msg({
      from_name: 'PayPal', from_email: 'service@paypa1.com', reply_to: [{ address: 'help@collect.example' }],
      subject: 'Unusual sign-in', body_html: '<a href="https://paypal.verify-now.example/login">Verify your account</a>',
    });
    const signals = spam.phishingSignals(row, { auth: { dmarc: 'fail', trusted: true }, text: 'Please verify your account now' });
    const names = signals.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['lookalike', 'brandName', 'replyTo', 'credential', 'linkDomain', 'authDmarc']));
    const verdict = spam.assessSpam(row, { auth: { dmarc: 'fail', trusted: true }, text: 'Please verify your account now' });
    expect(verdict.verdict).toBe('phishing');
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('treats the spam folder as weak, user overrides as final, and known senders as trusted', () => {
    expect(spam.assessSpam(msg(), { spamFolder: true })).toMatchObject({ verdict: 'suspected', confidence: 0.55 });
    expect(spam.assessSpam(msg({ spam_user_override: 'ham' }), { spamFolder: true })).toMatchObject({ verdict: 'clean' });
    expect(spam.assessSpam(msg())).toMatchObject({ verdict: 'clean' });
    const brand = msg({ from_name: 'LinkedIn', from_email: 'messages@linkedin.example' });
    expect(spam.phishingSignals(brand).map((s) => s.name)).toContain('brandName');
    expect(spam.phishingSignals(brand, { knownDomains: ['linkedin.example'] })).toEqual([]);
  });

  it('scores rescue candidates: replied-to senders, DMARC, personal tone and orders you placed', () => {
    const s1 = { senderKind: 'person', flags: { to: true, question: true } };
    const good = spam.rescueScore({ row: msg(), sender: { replied: 2 }, auth: { dmarc: 'pass', trusted: true }, s1 });
    expect(good.score).toBeGreaterThanOrEqual(0.7);
    expect(good.reasons[0]).toMatch(/replied/);
    const order = spam.rescueScore({ row: msg({ from_email: 'orders@shop.example', subject: 'Order #AB12345 confirmed' }), orderDomains: ['shop.example'] });
    expect(order.reasons.join(' ')).toMatch(/order you placed/);
    expect(spam.rescueScore({ row: msg(), sender: { replied: 3 }, decision: 'block' }).score).toBe(0);
    expect(spam.rescueScore({ row: msg(), sender: { replied: 3 }, phishingScore: 0.9 }).score).toBeLessThan(0.1);
  });
});

// ── Rules engine ────────────────────────────────────────────────────────────

describe('rules engine', () => {
  const base = { id: 'r1', enabled: true, name: 'Invoices', conditions: { match: 'all', items: [] }, actions: [{ type: 'bundle', value: 'finance' }] };

  it('validates rules and rejects the actions that are not available yet with a clear error', () => {
    expect(() => rules.validateRule({ name: 'x', conditions: { items: [{ field: 'from', op: 'contains', value: 'a' }] }, actions: [{ type: 'webhook', value: 'http://x' }] }))
      .toThrow(/"webhook" is not available yet/);
    expect(() => rules.validateRule({ name: 'x', conditions: { items: [{ field: 'nope', value: 'a' }] }, actions: [{ type: 'label', value: 'x' }] }))
      .toThrow(/unknown field/);
    expect(() => rules.validateRule({ name: 'x', conditions: { items: [{ field: 'confidence', op: 'under', value: 2 }] }, actions: [{ type: 'notify' }] }))
      .toThrow(/between 0 and 1/);
    expect(() => rules.validateRule({ name: 'x', conditions: { items: [{ field: 'from', value: 'a' }] }, actions: [{ type: 'bundle', value: 'nope' }] }, { bundleKeys: ['finance'] }))
      .toThrow(/unknown bundle/);
    const ok = rules.validateRule({ name: ' Header rule ', conditions: { match: 'any', items: [{ field: 'header', name: 'X-Mailer', op: 'contains', value: 'Mailchimp' }] }, actions: [{ type: 'stream', value: 'reading' }, { type: 'notify' }] });
    expect(ok).toEqual({ name: 'Header rule', enabled: true, conditions: { match: 'any', items: [{ field: 'header', name: 'x-mailer', op: 'contains', value: 'Mailchimp' }] }, actions: [{ type: 'stream', value: 'reading' }, { type: 'notify' }] });
  });

  it('evaluates header, sender, account, attachment and list conditions', () => {
    const row = msg({ from_email: 'billing@acme.co.uk', subject: 'Invoice 42', has_attachments: true, attachments: [{ filename: 'inv-42.pdf' }], headers: { 'List-Id': '<billing.acme.co.uk>', 'X-Mailer': 'Mailchimp 1.0' } });
    const m = { row };
    const ev = (c) => rules.evalCondition(c, m);
    expect(ev({ field: 'sender', op: 'is', value: 'acme.co.uk' })).toBe(true);
    expect(ev({ field: 'sender', op: 'is', value: 'billing@acme.co.uk' })).toBe(true);
    expect(ev({ field: 'sender', op: 'is', value: 'other.com' })).toBe(false);
    expect(ev({ field: 'fromDomain', op: 'is', value: 'co.uk' })).toBe(true);
    expect(ev({ field: 'subject', op: 'startsWith', value: 'invoice' })).toBe(true);
    expect(ev({ field: 'header', name: 'x-mailer', op: 'contains', value: 'mailchimp' })).toBe(true);
    expect(ev({ field: 'hasAttachment', op: 'is', value: true })).toBe(true);
    expect(ev({ field: 'attachment', op: 'endsWith', value: '.pdf' })).toBe(true);
    expect(ev({ field: 'list', op: 'is', value: 'billing.acme.co.uk' })).toBe(true);
    expect(ev({ field: 'list', op: 'exists' })).toBe(true);
    expect(ev({ field: 'account', op: 'is', value: row.account_id })).toBe(true);
  });

  it('defers model predicates until a decision exists, then applies them in the post phase', () => {
    const rule = { ...base, conditions: { match: 'all', items: [{ field: 'from', op: 'contains', value: 'acme' }, { field: 'kind', op: 'is', value: 'records' }, { field: 'confidence', op: 'under', value: 0.9 }] } };
    const row = msg({ from_email: 'billing@acme.example' });
    expect(rules.hasModelPredicates(rule)).toBe(true);
    expect(rules.ruleMatches(rule, { row })).toBeNull();
    expect(rules.applyRules([rule], { row }, { phase: 'pre' }).rule).toBeNull();
    const post = rules.applyRules([rule], { row, decision: { stream: 'records', confidence: 0.7 } }, { phase: 'post' });
    expect(post.rule.id).toBe('r1');
    expect(post.effect).toMatchObject({ bundle: 'finance' });
    expect(rules.ruleMatches(rule, { row, decision: { stream: 'records', confidence: 0.95 } })).toBe(false);
  });

  it('judges "matches <description>" from the Reflex output and lists the descriptions for the prompt', () => {
    const rule = { ...base, id: 'r9', conditions: { match: 'all', items: [{ field: 'matches', op: 'is', value: 'invoices from contractors' }] } };
    expect(rules.matchDescriptions([rule])).toEqual([{ id: 'r9', description: 'invoices from contractors' }]);
    expect(rules.ruleMatches(rule, { row: msg(), ruleMatches: ['r9'] })).toBe(true);
    expect(rules.ruleMatches(rule, { row: msg(), ruleMatches: [] })).toBe(false);
  });

  it('collects labels and notify from every matching rule, first stream/bundle rule wins', () => {
    const r1 = { id: 'a', enabled: true, name: 'label', conditions: { match: 'all', items: [{ field: 'subject', op: 'contains', value: 'invoice' }] }, actions: [{ type: 'label', value: 'money' }, { type: 'notify' }] };
    const r2 = { id: 'b', enabled: true, name: 'stream', conditions: { match: 'any', items: [{ field: 'from', op: 'contains', value: 'nobody' }, { field: 'subject', op: 'contains', value: 'invoice' }] }, actions: [{ type: 'stream', value: 'records' }] };
    const r3 = { id: 'c', enabled: true, name: 'later', conditions: { match: 'all', items: [{ field: 'subject', op: 'contains', value: 'invoice' }] }, actions: [{ type: 'stream', value: 'people' }] };
    const out = rules.applyRules([r1, r2, r3, { ...r3, id: 'd', enabled: false }], { row: msg({ subject: 'Invoice 7' }) });
    expect(out).toMatchObject({ labels: ['money'], notify: true, matched: ['a', 'b', 'c'] });
    expect(out.rule.id).toBe('b');
  });

  it('dry-runs a rule against history and returns the matched count and a sample', async () => {
    const history = [
      msg({ id: '00000000-0000-4000-8000-00000000000a', subject: 'Invoice 1', from_email: 'a@acme.example', s_stream: 'records', s_confidence: 0.9, s_rule_matches: [] }),
      msg({ id: '00000000-0000-4000-8000-00000000000b', subject: 'Lunch?', from_email: 'b@friends.example', s_stream: 'people', s_confidence: 0.9, s_rule_matches: [] }),
      msg({ id: '00000000-0000-4000-8000-00000000000c', subject: 'Invoice 2', from_email: 'a@acme.example', s_stream: 'records', s_confidence: 0.9, s_rule_matches: [] }),
    ];
    db.handler = (sql) => (/FROM messages m/.test(sql) && /LEFT JOIN hedwig_sort s/.test(sql) ? { rows: history } : null);
    const res = await rules.dryRun({ name: 'acme', conditions: { items: [{ field: 'sender', op: 'is', value: 'acme.example' }, { field: 'kind', op: 'is', value: 'records' }] }, actions: [{ type: 'bundle', value: 'finance' }] }, USER);
    expect(res).toMatchObject({ matched: 2, scanned: 3, approximate: false });
    expect(res.sample.map((s) => s.subject)).toEqual(['Invoice 1', 'Invoice 2']);
    const approx = await rules.dryRun({ name: 'm', conditions: { items: [{ field: 'matches', value: 'lunch plans' }] }, actions: [{ type: 'label', value: 'x' }] }, USER);
    expect(approx.approximate).toBe(true);
  });

  it('parses the common fields of a Gmail filter export', () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?><feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>
      <entry><category term='filter'></category><apps:property name='from' value='billing@acme.example'/><apps:property name='label' value='Finance'/><apps:property name='shouldArchive' value='true'/></entry>
      <entry><apps:property name='subject' value='[Team-AER]'/><apps:property name='to' value='me@example.com'/><apps:property name='label' value='GitHub &amp; CI'/></entry>
      <entry><apps:property name='hasTheWord' value='unsubscribe'/><apps:property name='shouldTrash' value='true'/></entry></feed>`;
    const { rules: parsed, skipped } = rules.parseGmailFilters(xml);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ conditions: { items: [{ field: 'from', op: 'contains', value: 'billing@acme.example' }] }, actions: [{ type: 'label', value: 'Finance' }], ignored: ['shouldArchive'] });
    expect(parsed[1].actions[0].value).toBe('GitHub & CI');
    expect(parsed[1].conditions.items.map((c) => c.field)).toEqual(['recipient', 'subject']);
    expect(skipped).toHaveLength(1);
    for (const r of parsed) expect(() => rules.validateRule(r)).not.toThrow();
  });

  it('turns "always" corrections into sender, list and kind rules', () => {
    const row = msg({ subject: 'Re: Weekly digest', from_email: 'digest@news.example' });
    const keys = { address: 'digest@news.example', domain: 'news.example', list: 'weekly.news.example' };
    expect(rules.ruleForCorrection({ always: 'sender', row, keys, after: { stream: 'reading' }, before: { stream: 'people' } }).conditions.items[0]).toEqual({ field: 'sender', op: 'is', value: 'digest@news.example' });
    expect(rules.ruleForCorrection({ always: 'list', row, keys, after: { stream: 'reading', bundle: 'updates' }, before: {} }).actions).toEqual([{ type: 'stream', value: 'reading' }, { type: 'bundle', value: 'updates' }]);
    expect(rules.ruleForCorrection({ always: 'kind', row, keys, after: { stream: 'records' }, before: { bundle: 'promotions' } }).conditions.items[0]).toEqual({ field: 'kind', op: 'is', value: 'promotions' });
    expect(rules.ruleForCorrection({ always: 'kind', row, keys, after: { stream: 'records' }, before: {} }).conditions.items[0].field).toBe('matches');
  });
});

// ── Reflex input and output ─────────────────────────────────────────────────

describe('Reflex input assembly', () => {
  it('caps new text at 2,500 and quoted context at 600 characters, and says who the user is', () => {
    const row = msg({ from_name: 'Priya Nair', from_email: 'priya@vantage.example', to_addresses: [{ address: 'me@example.com' }, { address: 'x@y.example' }], attachments: [{ filename: 'form.pdf' }] });
    const item = reflex.reflexItem(row, { newText: 'n'.repeat(4000), quoted: 'q'.repeat(2000), attachments: [{ filename: 'payslip.pdf' }] }, {
      index: 0, userAddresses: ME, sender: { received: 12, replied: 3, opened: 10, archived_unread: 1 }, wroteTo: true, signals: [{ label: 'Passed DMARC' }], cfg,
    });
    expect(item.id).toBe('m1');
    expect(item.newText.length).toBe(2501);
    expect(item.quoted.length).toBe(601);
    expect(item.role).toBe('in To with 1 other');
    expect(item.history).toBe('12 messages received, you replied to 3, opened 10, left 1 unread, you have written to them');
    expect(item.attachments).toEqual(['payslip.pdf', 'form.pdf']);
    const vars = reflex.buildReflexVars({
      user: { name: 'Prakhar', addresses: ME }, items: [item], now: 'Wednesday 23 September 2026',
      bundles: [{ key: 'finance', name: 'Finance', hint: 'Bank statements and bills' }],
      rules: [{ id: 'r9', description: 'invoices from contractors' }],
      corrections: [{ kind: 'sort', before: { stream: 'people', subject: 'Money Stuff', from: 'news@ms.example' }, after: { stream: 'reading', bundle: 'updates' }, note: 'newsletter' }],
    });
    const text = reflexPrompt.user(vars);
    expect(text).toContain('You sort mail for Prakhar (me@example.com)');
    expect(text).toContain('- finance: Finance — Bank statements and bills');
    expect(text).toContain('- r9: invoices from contractors');
    expect(text).toContain('"Money Stuff" from news@ms.example: Hedwig said people; the user chose reading/updates (newsletter)');
    expect(text).toContain('### m1');
    expect(text).toContain('Attachments: payslip.pdf, form.pdf');
  });

  it('describes the recipient role and a first-time sender', () => {
    expect(reflex.recipientRole(msg({ to_addresses: [{ address: 'team@x.example' }], cc_addresses: [{ address: 'me@example.com' }] }), ME)).toBe('in Cc only');
    expect(reflex.recipientRole(msg({ to_addresses: [{ address: 'list@x.example' }] }), ME)).toMatch(/not in To or Cc/);
    expect(reflex.historyLine(null)).toBe('first message from them');
  });
});

describe('Reflex output normalisation', () => {
  const bundleList = [{ key: 'finance', name: 'Finance' }, { key: 'updates', name: 'Updates' }];
  it('repairs synonyms, percentages, unknown bundles and long reasons, and reports missing ids', () => {
    const { results, missing } = reflex.normaliseReflex({
      items: [
        { id: 'm1', stream: 'Newsletter', bundle: 'Updates', needs_you: 'false', needs_you_reason: 'x', spam: 'clean', confidence: 85, reason: 'The user subscribed to this newsletter and reads it most weeks, often on the same day it arrives in the inbox', matches: ['r9', 'bogus'] },
        { id: 'm2', stream: 'people', bundle: 'finance', needs_you: true, needs_you_reason: '"Priya asks the user to send the payslips by 30 Sep"', spam: 'spam', confidence: 0.4, reason: 'A colleague asks you for documents' },
        { id: 'm3', stream: 'weird' },
        { id: 'zz', stream: 'people' },
      ],
    }, ['m1', 'm2', 'm3', 'm4'], bundleList, ['r9']);
    const m1 = results.get('m1');
    expect(m1).toMatchObject({ stream: 'reading', bundle: 'updates', needsYou: false, needsYouReason: null, confidence: 0.85, matches: ['r9'], spam: 'clean' });
    expect(m1.reason.length).toBeLessThanOrEqual(90);
    expect(m1.reason.startsWith('You subscribed')).toBe(true);
    expect(results.get('m2')).toMatchObject({ stream: 'people', bundle: null, needsYou: true, needsYouReason: 'Priya asks you to send the payslips by 30 Sep', spam: 'suspected', confidence: 0.4 });
    expect(missing).toEqual(['m3', 'm4']);
  });

  it('escalates low confidence and unsure phishing', () => {
    expect(reflex.needsEscalation({ confidence: 0.5, spam: 'clean' }, cfg)).toBe(true);
    expect(reflex.needsEscalation({ confidence: 0.7, spam: 'clean' }, cfg)).toBe(false);
    expect(reflex.needsEscalation({ confidence: 0.7, spam: 'phishing' }, cfg)).toBe(true);
    expect(reflex.needsEscalation({ confidence: 0.9, spam: 'phishing' }, cfg)).toBe(false);
  });
});

describe('Reflex through the prompt registry (mock gateway)', () => {
  beforeEach(() => {
    gw.reset().install();
    _resetPrompts();
    _resetLlmState();
  });

  it('runs sort.reflex on the Reflex tier, then escalates the unsure item to the reasoning tier', async () => {
    gw.on('sort.reflex', (req) => {
      if (req.model === QWEN) return { items: [{ id: 'm2', stream: 'records', bundle: 'finance', needs_you: false, needs_you_reason: '', spam: 'clean', confidence: 0.9, reason: 'Your bank statement', matches: [] }] };
      return {
        items: [
          { id: 'm1', stream: 'people', bundle: '', needs_you: true, needs_you_reason: 'Alex asks if you are free Thursday', spam: 'clean', confidence: 0.92, reason: 'Alex writes to you directly', matches: [] },
          { id: 'm2', stream: 'reading', bundle: '', needs_you: false, needs_you_reason: '', spam: 'clean', confidence: 0.4, reason: 'Not sure', matches: [] },
        ],
      };
    });
    const items = [
      reflex.reflexItem(msg(), { newText: 'Are you free Thursday?' }, { index: 0, userAddresses: ME, cfg }),
      reflex.reflexItem(msg({ id: 'b', from_email: 'statements@bank.example', subject: 'Your statement' }), { newText: 'Your September statement is ready.' }, { index: 1, userAddresses: ME, cfg }),
    ];
    const out = await reflex.runReflex(USER, { items, messageIds: ['A', 'B'], user: { name: 'Me', addresses: ME }, bundles: [{ key: 'finance', name: 'Finance', hint: 'bank' }], rules: [], corrections: [] }, cfg);
    const calls = gw.callsFor('sort.reflex');
    expect(calls).toHaveLength(2);
    expect(calls[0].model).toBe(GEMMA);
    expect(calls[0].responseFormat.type).toBe('json_schema');
    expect(calls[0].text).toContain('Are you free Thursday?');
    expect(calls[1].model).toBe(QWEN);
    expect(calls[1].text).toContain('### m2');
    expect(calls[1].text).not.toContain('### m1');
    expect(out.get('A')).toMatchObject({ stream: 'people', layer: 'reflex', needsYou: true });
    expect(out.get('A').provenance).toMatchObject({ promptId: 'sort.reflex', promptVersion: reflexPrompt.version, model: GEMMA });
    expect(out.get('B')).toMatchObject({ stream: 'records', bundle: 'finance', layer: 'reasoning', confidence: 0.9 });
  });

  it('takes the layer from the tier that answered, not from the escalate flag', async () => {
    let gemmaCalls = 0;
    gw.on('sort.reflex', (req) => {
      if (req.model === QWEN) return 'not json'; // the reasoning model fails twice …
      gemmaCalls++;
      if (gemmaCalls === 1) {
        return { items: [{ id: 'm1', stream: 'reading', bundle: '', needs_you: false, needs_you_reason: '', spam: 'clean', confidence: 0.4, reason: 'Not sure', matches: [] }] };
      }
      // … so runPrompt's last retry of the escalation runs on Gemma again.
      return { items: [{ id: 'm1', stream: 'records', bundle: '', needs_you: false, needs_you_reason: '', spam: 'clean', confidence: 0.8, reason: 'A statement', matches: [] }] };
    });
    const items = [reflex.reflexItem(msg(), { newText: 'Statement ready' }, { index: 0, userAddresses: ME, cfg })];
    const out = await reflex.runReflex(USER, { items, messageIds: ['A'], user: { name: 'Me', addresses: ME }, bundles: [], rules: [], corrections: [] }, cfg);
    expect(gw.callsFor('sort.reflex').map((c) => c.model)).toEqual([GEMMA, QWEN, QWEN, GEMMA]);
    expect(out.get('A')).toMatchObject({ stream: 'records', layer: 'reflex' });
    expect(out.get('A').provenance).toMatchObject({ tier: 'reflex', model: GEMMA });
  });
});

// ── Body wait (timed from when Hedwig first saw the message) ────────────────

describe('body wait', () => {
  beforeEach(() => {
    gw.reset().install();
    _resetPrompts();
    _resetLlmState();
  });

  it('bodyWaitLeft counts from hedwig_msg.seen_at, not the Date header', () => {
    const now = new Date();
    const row = msg({ date: daysAgo(3) });
    expect(engine.bodyWaitLeft(row, { cfg, now, seenAt: new Map([[row.id, new Date(now.getTime() - 30_000)]]) })).toBeCloseTo(90, 0);
    expect(engine.bodyWaitLeft(row, { cfg, now, seenAt: new Map([[row.id, new Date(now.getTime() - 600_000)]]) })).toBeLessThan(0);
    expect(engine.bodyWaitLeft(row, { cfg, now, seenAt: new Map() })).toBe(120); // being seen right now
  });

  async function sortOne(seenAgoMs) {
    const row = msg({ id: '00000000-0000-4000-8000-0000000000b1', from_email: 'new.person@elsewhere.example', date: new Date(Date.now() - 3 * 86400_000), body_text: null, body_html: null });
    db.handler = (sql) => {
      if (/FROM hedwig_msg WHERE user_id/.test(sql)) return { rows: [{ message_id: row.id, seen_at: new Date(Date.now() - seenAgoMs) }] };
      if (/COUNT\(\*\)::int AS n FROM hedwig_bundles/.test(sql)) return { rows: [{ n: 99 }] };
      if (/INSERT INTO hedwig_sort\b/.test(sql)) return { rows: [{ message_id: row.id }] };
      if (/INSERT INTO hedwig_jobs/.test(sql)) return { rows: [{ id: 1 }] };
      return null;
    };
    await engine.sortRows([row]);
    const upsert = db.calls.find((c) => /INSERT INTO hedwig_sort\b/.test(c.sql));
    const job = db.calls.find((c) => /INSERT INTO hedwig_jobs/.test(c.sql) && c.params[0] === 'sort.reflex');
    return { pending: upsert?.params[24], job };
  }

  it('waits for the body of three-day-old mail Hedwig has only just seen (delayed delivery, backfill)', async () => {
    const { pending, job } = await sortOne(10_000);
    expect(pending).toBe('body');
    expect(job).toBeUndefined();
  });

  it('goes to Reflex on the snippet once the wait since first seen has passed', async () => {
    const { pending, job } = await sortOne(10 * 60_000);
    expect(pending).toBe('reflex');
    expect(job).toBeTruthy();
  });
});

// ── Screener proposals and decisions ────────────────────────────────────────

function ctxFor(over = {}) {
  return {
    cfg, now: NOW, userAddresses: ME, bundles: bundles.DEFAULT_BUNDLES.map((b) => ({ ...b, enabled: true })), rules: [], heads: {},
    stats: new Map(), decisions: new Map(), triage: new Map(), threads: new Map(), knownDomains: [], existing: new Map(), ruleHits: [],
    ...over,
  };
}

describe('screener proposals', () => {
  it('holds recent mail from an undecided sender with a proposal and a reason', () => {
    const d = engine.decideCheap(msg({ from_email: 'news@letters.example', is_bulk: true, list_unsubscribe: '<mailto:u@letters.example>', body_text: 'This week: open models.' }), ctxFor());
    expect(d).toMatchObject({ stream: 'reading', proposed: 'reading', needsScreen: true, layer: 'classifier', final: false });
    expect(d.screenKey).toEqual({ key: 'news@letters.example', scope: 'address' });
    expect(d.reason).toBe('A newsletter or mailing list');
  });

  it('does not hold decided senders, replies to own threads, or old mail', () => {
    const decided = new Map([['address|alex@example.org', { key: 'alex@example.org', scope: 'address', decision: 'people', source: 'user', confidence: 1 }]]);
    const d1 = engine.decideCheap(msg(), ctxFor({ decisions: decided }));
    expect(d1).toMatchObject({ stream: 'people', layer: 'rule', confidence: 1, needsScreen: false, final: true, reason: 'You put this sender in People' });
    const d2 = engine.decideCheap(msg(), ctxFor({ threads: new Map([[msg().id, { replyToOwn: true }]]) }));
    expect(d2).toMatchObject({ stream: 'people', needsScreen: false, reason: 'A reply in a thread you wrote in' });
    const d3 = engine.decideCheap(msg({ date: daysAgo(40) }), ctxFor());
    expect(d3.needsScreen).toBe(false);
    const blocked = new Map([['domain|example.org', { key: 'example.org', scope: 'domain', decision: 'block', source: 'user' }]]);
    expect(engine.decideCheap(msg(), ctxFor({ decisions: blocked }))).toMatchObject({ stream: 'spam', reason: 'You blocked this sender' });
  });

  it('lets a user rule decide before anything else and counts the hit', () => {
    const rule = { id: 'r1', enabled: true, name: 'Acme bills', conditions: { match: 'all', items: [{ field: 'sender', op: 'is', value: 'example.org' }] }, actions: [{ type: 'bundle', value: 'finance' }, { type: 'label', value: 'bills' }] };
    const ctx = ctxFor({ rules: [rule] });
    const d = engine.decideCheap(msg(), ctx);
    expect(d).toMatchObject({ stream: 'records', bundle: 'finance', layer: 'rule', ruleId: 'r1', labels: ['bills'], needsScreen: false, reason: 'Your rule “Acme bills”' });
    expect(ctx.ruleHits).toEqual(['r1']);
  });

  it('refreshes proposals: auto-screens confident senders, asks sort.screener about the rest', async () => {
    gw.reset().install();
    _resetPrompts();
    _resetLlmState();
    gw.on('sort.screener', { senders: [{ key: 'bob@new.example', proposed: 'people', confidence: 0.6, reason: 'Bob writes to you personally' }] });
    const inserted = [];
    db.handler = (sql, params) => {
      if (/FROM hedwig_sort s\s+JOIN messages m/.test(sql) && /GROUP BY s.sender_key/.test(sql)) {
        return { rows: [
          { key: 'news@letters.example', scope: 'address', count: 3, address: 'news@letters.example', display: 'Letters', subjects: ['Issue 1'], in_spam: false, layer_proposal: 'reading', layer_confidence: 0.9, layer_reason: 'A newsletter' },
          { key: 'bob@new.example', scope: 'address', count: 1, address: 'bob@new.example', display: 'Bob', subjects: ['Hi'], in_spam: false, layer_proposal: 'people', layer_confidence: 0.55, layer_reason: 'A person' },
        ] };
      }
      if (/INSERT INTO hedwig_senders/.test(sql)) { inserted.push(params); return { rows: [{ id: 1, key: params[1], scope: params[2], decision: params[3], source: params[4], confidence: params[5] }] }; }
      if (/INSERT INTO hedwig_sort_log/.test(sql)) return { rows: [{ id: 7 }] };
      return null;
    };
    const res = await senders.refreshProposals(USER, { useModel: true, user: { name: 'Me', addresses: ['me@example.com'] } });
    expect(res).toEqual({ proposed: 1, screened: 1 });
    expect(inserted[0].slice(1, 5)).toEqual(['news@letters.example', 'address', 'reading', 'auto']);
    const proposal = db.calls.find((c) => /INSERT INTO hedwig_sender_proposals/.test(c.sql));
    expect(proposal.params.slice(1, 6)).toEqual(['bob@new.example', 'address', 'people', 0.6, 'Bob writes to you personally']);
    expect(gw.callsFor('sort.screener')[0].text).toContain('### bob@new.example');
  });

  it('logs the triggering message with an auto-screen so undo sends it back to the Screener', async () => {
    const TRIGGER = '00000000-0000-4000-8000-0000000000c1';
    const logs = [];
    db.handler = (sql, params) => {
      if (/INSERT INTO hedwig_senders/.test(sql)) return { rows: [{ id: 5, key: params[1], scope: params[2], decision: params[3], source: params[4], confidence: params[5], reason: params[6] }] };
      if (/INSERT INTO hedwig_sort_log/.test(sql)) { logs.push(params); return { rows: [{ id: 9 }] }; }
      return null; // applyDecisionToMessages: the triggering message has no hedwig_sort row yet, so nothing moves
    };
    const res = await senders.setSenderDecision(USER, { key: 'sam@lettings.example', scope: 'address', decision: 'people', source: 'auto', confidence: 0.9, messageId: TRIGGER });
    expect(res.moved).toEqual([]);
    const to = JSON.parse(logs[0][4]);
    expect(to.messageIds).toEqual([TRIGGER]);
    db.calls.length = 0;
    db.handler = null;
    await senders.revertSenderDecision(USER, { to, from: null });
    const reset = db.calls.find((c) => /UPDATE hedwig_sort SET proposed_stream/.test(c.sql));
    expect(reset.params).toEqual([USER, [TRIGGER]]);
  });

  it('never lets an automatic decision replace the user’s own', async () => {
    db.handler = (sql) => (/FROM hedwig_senders WHERE user_id = \$1 AND scope/.test(sql) ? { rows: [{ id: 3, decision: 'reading', source: 'user' }] } : null);
    const res = await senders.setSenderDecision(USER, { key: 'a@b.example', scope: 'address', decision: 'people', source: 'auto' });
    expect(res.skipped).toMatch(/user decision stands/);
    expect(db.calls.some((c) => /INSERT INTO hedwig_senders/.test(c.sql))).toBe(false);
  });
});

// ── Merge, bundles, classifier ──────────────────────────────────────────────

describe('merging model output', () => {
  it('takes the model decision, bundles Reading/Records mail and sends confident phishing to spam', () => {
    const d = engine.decideCheap(msg({ from_email: 'statements@bank.example', subject: 'Your statement' }), ctxFor());
    engine.mergeReflex(d, { stream: 'records', bundle: 'finance', needsYou: false, needsYouReason: null, spam: 'clean', confidence: 0.9, reason: 'Your bank statement', layer: 'reflex', matches: [], provenance: { promptId: 'sort.reflex', promptVersion: 'v', model: GEMMA } }, { bundles: ctxFor().bundles, cfg });
    expect(d).toMatchObject({ stream: 'records', bundle: 'finance', layer: 'reflex', confidence: 0.9, final: true, reason: 'Your bank statement' });
    const p = engine.decideCheap(msg({ from_email: 'x@unknown.example' }), ctxFor());
    engine.mergeReflex(p, { stream: 'people', bundle: null, needsYou: true, spam: 'phishing', confidence: 0.85, reason: 'Impersonates your bank', layer: 'reasoning', matches: [] }, { cfg });
    expect(p).toMatchObject({ stream: 'spam', spam: 'phishing', needsYou: false, layer: 'reasoning' });
  });

  it('writes needs-you reasons in plain second person', () => {
    const row = msg({ from_name: 'Dr Anand' });
    const s1 = { flags: { question: true }, analysis: { questionText: 'Which slot would you prefer?' }, reasons: [] };
    expect(engine.needsYouText(row, s1)).toBe('Dr Anand asks: Which slot would you prefer?');
    expect(engine.needsYouText(row, { flags: {}, analysis: {} }, { reason_label: 'Money · conflict' })).toMatch(/amount differs/);
  });
});

describe('bundle schedules', () => {
  it('finds the last daily and weekly slot in the user’s zone', () => {
    const now = new Date('2026-09-23T12:00:00Z'); // Wednesday, 13:00 in London
    expect(bundles.lastSlot({ mode: 'daily', at: '08:00' }, now, 'Europe/London').toISOString()).toBe('2026-09-23T07:00:00.000Z');
    expect(bundles.lastSlot({ mode: 'daily', at: '17:00' }, now, 'Europe/London').toISOString()).toBe('2026-09-22T16:00:00.000Z');
    expect(bundles.lastSlot({ mode: 'weekly', day: 6, at: '09:00' }, now, 'UTC').toISOString()).toBe('2026-09-19T09:00:00.000Z');
    expect(bundles.lastSlot({ mode: 'instant' }, now)).toBeNull();
    expect(bundles.isDue({ mode: 'daily', at: '08:00' }, '2026-09-22T09:00:00Z', now, 'UTC')).toBe(true);
    expect(bundles.isDue({ mode: 'daily', at: '08:00' }, '2026-09-23T08:30:00Z', now, 'UTC')).toBe(false);
    expect(() => bundles.normaliseSchedule({ mode: 'weekly', at: '25:00', day: 1 })).toThrow(/HH:MM/);
  });

  it('guesses a bundle from keywords within the stream', () => {
    const list = bundles.DEFAULT_BUNDLES;
    expect(bundles.guessBundle({ row: { subject: 'Your order has shipped', from_email: 'order-update@shop.example' }, stream: 'records' }, list)).toBe('deliveries');
    expect(bundles.guessBundle({ row: { subject: '20% off everything this weekend' }, stream: 'reading' }, list)).toBe('promotions');
    expect(bundles.guessBundle({ row: { subject: 'Hello' }, stream: 'records' }, list)).toBeNull();
  });
});

describe('classifier heads', () => {
  it('turns stored decisions into per-head samples, weighting your own corrections', () => {
    const samples = classifier.samplesFromDecisions([
      { features: { a: 1 }, stream: 'people', layer: 'user', spam: 'clean' },
      { features: { b: 1 }, stream: 'screener', proposed_stream: 'reading', layer: 'reflex', spam: 'clean' },
      { features: { c: 1 }, stream: 'spam', layer: 'rule', spam: 'suspected' },
      { features: null, stream: 'people', layer: 'user' },
    ]);
    expect(samples.people.map((s) => [s.label, s.weight])).toEqual([[1, 3], [0, 0.7]]);
    expect(samples.reading.map((s) => s.label)).toEqual([0, 1]);
    expect(samples.spam.map((s) => s.label)).toEqual([0, 0, 1]);
  });

  it('predicts a stream from trained heads', () => {
    const mk = (tag) => ({ [`s:${tag}`]: 1 });
    const data = [...Array(20)].flatMap(() => [{ f: mk('friend'), y: 'people' }, { f: mk('news'), y: 'reading' }, { f: mk('shop'), y: 'records' }]);
    const heads = {};
    for (const h of classifier.STREAM_HEADS) heads[h] = { model: train(data.map((d) => ({ features: d.f, label: d.y === h ? 1 : 0 }))), samples: data.length };
    expect(classifier.headsActive(heads, 40)).toBe(true);
    const p = classifier.predictHeads(heads, mk('news'));
    expect(p.stream).toBe('reading');
    expect(p.confidence).toBeGreaterThan(0.6);
    expect(classifier.priorStream({ s1: {}, sender: { received: 5, replied: 3 } })).toMatchObject({ stream: 'people', reason: 'You often reply to them' });
  });
});

describe('routes', () => {
  it('mounts every contract route and maps service errors to status codes', async () => {
    const { mountSortRoutes } = await import('./routes.js');
    const routes = [];
    const router = {};
    for (const m of ['get', 'post', 'patch', 'delete']) router[m] = (path, h) => routes.push({ method: m.toUpperCase(), path, h });
    mountSortRoutes(router);
    const names = routes.map((r) => `${r.method} ${r.path}`);
    expect(names).toEqual(expect.arrayContaining([
      'GET /sort/stream/:stream', 'GET /sort/screener', 'POST /sort/screener/decide', 'POST /sort/correct', 'GET /sort/today',
      'POST /sort/undo', 'GET /sort/bundles', 'POST /sort/bundles', 'GET /sort/rules', 'POST /sort/rules', 'POST /sort/rules/:id/dryrun',
      'GET /sort/message/:id/why',
    ]));
    const correct = routes.find((r) => r.path === '/sort/correct').h;
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await correct({ body: { messageId: 'nope' }, session: { userId: USER }, method: 'POST', originalUrl: '/api/hedwig/sort/correct' }, res);
    expect(res.code).toBe(400);
    expect(res.body.error).toMatch(/messageId/);
    const stream = routes.find((r) => r.path === '/sort/stream/:stream').h;
    await stream({ params: { stream: 'inbox' }, query: {}, session: { userId: USER } }, res);
    expect(res.code).toBe(400);
  });
});

describe('why', () => {
  it('returns the sender key and scope the message is grouped under, with the decision for it', async () => {
    const service = await import('./service.js');
    const MID = '00000000-0000-4000-8000-0000000000aa';
    db.handler = (sql) => {
      if (/FROM hedwig_sort s LEFT JOIN hedwig_rules/.test(sql)) {
        return { rows: [{ message_id: MID, layer: 'rule', reason: 'A newsletter', confidence: 1, signals: [], stream: 'reading', sender_key: 'weekly.example.org', sender_scope: 'list' }] };
      }
      if (/FROM hedwig_senders/.test(sql)) return { rows: [{ key: 'weekly.example.org', scope: 'list', decision: 'reading', source: 'user' }] };
      return null;
    };
    try {
      const out = await service.why(USER, MID);
      expect(out).toMatchObject({ senderKey: 'weekly.example.org', senderScope: 'list', senderDecision: { scope: 'list', decision: 'reading' } });
      db.handler = (sql) => (/FROM hedwig_sort s LEFT JOIN hedwig_rules/.test(sql) ? { rows: [{ message_id: MID, layer: 'reflex', signals: [], sender_key: null, sender_scope: null }] } : null);
      expect(await service.why(USER, MID)).toMatchObject({ senderKey: null, senderScope: null, senderDecision: null });
    } finally {
      db.handler = null;
    }
  });
});
