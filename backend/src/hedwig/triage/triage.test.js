import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })), pool: {} }));
vi.mock('../../utils/mailUtils.js', () => ({
  resolveSpamFolder: vi.fn(async () => 'Junk'),
  resolveAllSpamPaths: vi.fn(async () => new Set(['Junk'])),
  adjustFolderCounts: vi.fn(),
}));

const db = await import('../../services/db.js');

const { analyseText, parseAmounts, stage1, spamEvidence, threadFacts, senderKind, matchRule, deadlineLabel } = await import('./signals.js');
const { fnv1a, hashIndex, hashFeatures, buildFeatures, subjectTokens, describeFeature } = await import('./features.js');
const { train, predict, contributions, evaluate, trainWithHoldout, mulberry32 } = await import('./model.js');
const { deriveImplicitLabel, labelTarget, feedbackToSamples, waitingOnDecision } = await import('./labels.js');
const { decide, mergePluginResults } = await import('./classify.js');
const { parseVerdict, applyVerdict } = await import('./stage3.js');
const { toTriageInfo, isGone } = await import('./store.js');
const { behaviourDeltas } = await import('./senderStats.js');
const service = await import('./service.js');
const { makePushJunkHandler } = await import('./junk.js');

const NOW = new Date('2026-09-23T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400_000);
const ME = new Set(['me@example.com']);
const CFG = {
  'triage.needsYouThreshold': 0.5, 'triage.minSamples': 40, 'triage.llmLow': 0.35, 'triage.llmHigh': 0.65,
};

function msg(over = {}) {
  return {
    id: over.id || '00000000-0000-4000-8000-000000000001',
    account_id: 'a1',
    folder: 'INBOX',
    subject: 'Hello',
    from_name: 'Alex',
    from_email: 'alex@example.org',
    to_addresses: [{ address: 'me@example.com' }],
    cc_addresses: [],
    date: daysAgo(1),
    is_bulk: false,
    list_unsubscribe: null,
    category: null,
    has_attachments: false,
    thread_key: 't1',
    ...over,
  };
}

describe('stage 1 text analysis', () => {
  it('finds a dated deadline relative to the message date', () => {
    const t = analyseText('Please send the payslips to the solicitor by 30 September. Can you do that this week?', daysAgo(2));
    expect(t.deadline.at.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(t.question).toBe(true);
    expect(t.request).toBe(true);
    expect(deadlineLabel(t.deadline.at, NOW)).toBe('Deadline · 7 d');
  });
  it('resolves weekdays, "within N days" and rolls dates into next year', () => {
    const ref = new Date('2026-09-22T09:00:00Z'); // a Tuesday
    expect(analyseText('We will release them on Friday.', ref).deadline.at.toISOString().slice(0, 10)).toBe('2026-09-25');
    expect(analyseText('€1,840 due within 14 days.', ref).deadline.at.toISOString().slice(0, 10)).toBe('2026-10-06');
    expect(analyseText('Payment is due by 5 Jan.', new Date('2026-12-20T00:00:00Z')).deadline.at.toISOString().slice(0, 10)).toBe('2027-01-05');
    expect(analyseText('The engineer can come on Thursday between 8 and 12.', ref).deadline).toBeNull();
  });
  it('parses money amounts in symbols and codes', () => {
    expect(parseAmounts('Fee is £1,450 plus EUR 99.50 and $3')).toEqual([
      { currency: '£', value: 1450, raw: '£1,450' },
      { currency: '€', value: 99.5, raw: 'EUR 99.50' },
      { currency: '$', value: 3, raw: '$3' },
    ]);
  });
  it('classifies sender kinds', () => {
    expect(senderKind('notifications@github.com')).toBe('notification');
    expect(senderKind('messages-noreply@linkedin.com')).toBe('notification');
    expect(senderKind('order-update@amazon.com')).toBe('notification');
    expect(senderKind('newsletter@moneystuff.example')).toBe('newsletter');
    expect(senderKind('priya.nair@vantage.example')).toBe('person');
  });
});

describe('stage 1 decisions', () => {
  it('flags a direct question with a deadline as needs you, with a deadline chip', () => {
    const row = msg({ subject: 'Final documents', date: daysAgo(2) });
    const s = stage1({ row, userAddresses: ME, text: 'The signed form is due to the solicitor by 30 September. Can you send it this week?', now: NOW });
    expect(s.category).toBe('needs_you');
    expect(s.reasonLabel).toBe('Deadline · 7 d');
    expect(s.reasons.map((r) => r.label)).toEqual(expect.arrayContaining(['Asks you a question', 'Sent to you directly', 'Deadline: “by 30 September”']));
    expect(s.reasons.every((r) => ['for', 'against'].includes(r.direction))).toBe(true);
  });
  it('spots an invoice that contradicts the quote earlier in the thread', () => {
    const row = msg({ id: 'm3', subject: 'Invoice 2041', has_attachments: true });
    const thread = threadFacts(row, [
      { id: 'm1', from_email: 'alex@example.org', date: daysAgo(100), outgoing: false, text: 'The redesign will be €1,600 all-in.' },
      { id: 'm2', from_email: 'me@example.com', date: daysAgo(99), outgoing: true, text: 'Go ahead at €1,600.' },
    ]);
    const s = stage1({ row, userAddresses: ME, text: 'Please find invoice 2041 attached: €1,840 due within 14 days.', thread, now: NOW });
    expect(s.flags.moneyConflict).toBe(true);
    expect(s.category).toBe('needs_you');
    expect(s.reasonLabel).toBe('Money · conflict');
    expect(s.reasons.find((r) => r.flag === 'moneyConflict').label).toBe('€1,840 differs from €1,600 earlier in the thread');
  });
  it('notices a sender asking twice without a reply', () => {
    const row = msg({ id: 'd2', from_name: 'Dr Anand' });
    const thread = threadFacts(row, [{ id: 'd1', from_email: 'alex@example.org', date: daysAgo(7), outgoing: false, text: 'Which slot?' }]);
    const s = stage1({ row, userAddresses: ME, text: 'Just checking in — could you confirm which slot works?', thread, now: NOW });
    expect(s.flags.askedTwice).toBe(true);
    expect(s.reasonLabel).toBe('Asked twice');
  });
  it('files bulk mail as digest and notification senders as notifications', () => {
    const news = stage1({ row: msg({ from_email: 'newsletter@moneystuff.example', is_bulk: true, list_unsubscribe: '<mailto:u@x>' }), userAddresses: ME, text: 'Today: bonds. What do you think?', now: NOW });
    expect(news.category).toBe('digest');
    expect(news.reasonLabel).toBe('Newsletter');
    const gh = stage1({ row: msg({ from_email: 'notifications@github.com', is_bulk: true }), userAddresses: ME, text: 'CI failed on main', now: NOW });
    expect(gh.category).toBe('notifications');
    expect(gh.reasons.map((r) => r.flag)).toEqual(expect.arrayContaining(['bulk', 'notification']));
  });
  it('uses upstream spam verdicts and the user override', () => {
    const spam = stage1({ row: msg({ spam_verdict: 'spam', spam_details: { blendedScore: 0.93, rulesFired: [{ name: 'SUBJECT_MONEY_KEYWORDS' }] } }), userAddresses: ME, text: 'hi', now: NOW });
    expect(spam.category).toBe('spam');
    expect(spam.reasons[0].label).toBe('Spam filter verdict (subject money keywords)');
    const ham = spamEvidence(msg({ spam_verdict: 'spam', spam_user_override: 'ham' }), { text: '' });
    expect(ham.spam).toBe(false);
  });
  it('catches a first-contact crypto scam upstream did not analyse', () => {
    const row = msg({ from_email: 'billing@fast-crypto-win.example', subject: 'URGENT: verify your wallet to claim 2.4 BTC' });
    const s = stage1({ row, userAddresses: ME, text: 'Click here immediately to verify your wallet or lose your reward forever.', now: NOW });
    expect(s.category).toBe('spam');
    expect(s.reasonLabel).toBe('Likely scam');
    expect(s.reasons[0].label).toMatch(/^Scam phrasing: /);
    // The same words from someone the user corresponds with are not spam.
    const known = stage1({ row, userAddresses: ME, text: 'Click here immediately to verify your wallet', sender: { received: 20, replied: 5 }, now: NOW });
    expect(known.category).not.toBe('spam');
  });
  it('records authentication failures as reasons', () => {
    const s = stage1({ row: msg({ spam_verdict: 'ham', spam_details: { rulesFired: [{ name: 'AUTH_DKIM_FAIL' }] } }), userAddresses: ME, text: 'hello', now: NOW });
    expect(s.flags.authFail).toBe(true);
    expect(s.reasons.some((r) => r.label === 'Sender authentication failed' && r.direction === 'against')).toBe(true);
  });
  it('treats Cc-only mail without an ask as everything', () => {
    const s = stage1({ row: msg({ to_addresses: [{ address: 'team@example.org' }], cc_addresses: [{ address: 'me@example.com' }] }), userAddresses: ME, text: 'Notes from today attached.', now: NOW });
    expect(s.category).toBe('everything');
    expect(s.reasonLabel).toBe('Cc');
  });
  it('honours sender and domain rules, sender first', () => {
    const rules = [{ kind: 'domain', value: 'example.org', category: 'digest' }, { kind: 'sender', value: 'boss@example.org', category: 'needs_you' }];
    expect(matchRule(rules, 'boss@example.org').category).toBe('needs_you');
    expect(matchRule(rules, 'x@mail.example.org').category).toBe('digest');
    expect(matchRule(rules, 'x@example.com')).toBeNull();
    const s = stage1({ row: msg(), userAddresses: ME, text: 'Can you call me?', rules, now: NOW });
    expect(s.category).toBe('digest');
    expect(s.reasonLabel).toBe('Your rule');
  });
});

describe('features', () => {
  it('hashes with FNV-1a into the configured space', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    for (const n of ['s:a@b.c', 'w:invoice', 'f:question']) {
      const i = hashIndex(n, 10);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(1024);
    }
    const m = hashFeatures({ a: 1, b: 2, zero: 0 }, 18);
    expect([...m.values()].reduce((s, v) => s + v, 0)).toBe(3);
  });
  it('builds named features from the message, stage 1 and sender history', () => {
    const row = msg({ subject: 'Re: Invoice 2041 for the landing page', has_attachments: true, category: 'primary', date: new Date('2026-09-22T09:30:00Z') });
    const s1 = stage1({ row, userAddresses: ME, text: 'Can you pay?', now: NOW });
    const f = buildFeatures({ row, s1, sender: { received: 10, replied: 6, opened: 10, archived_unread: 0 }, thread: { userRepliedBefore: true, length: 3 }, extra: { vip: 2, 'bad name!': 1 } });
    expect(f).toMatchObject({ bias: 1, 's:alex@example.org': 1, 'd:example.org': 1, 'f:question': 1, 'f:to': 1, att: 1, 'w:invoice': 1, 'w:landing': 1, 'rr:high': 1, 'or:high': 1, 'au:0': 1, 'thr:replied': 1, 'h:morning': 1, 'p:vip': 2 });
    expect(f['p:bad name!']).toBeUndefined();
    expect(subjectTokens('RE: Fwd: The Visa sponsorship 2026')).toEqual(['visa', 'sponsorship']);
    expect(describeFeature('rr:high')).toBe('you often reply to this sender');
  });
});

describe('logistic regression', () => {
  function toySet(seed, n = 200) {
    const rand = mulberry32(seed);
    const out = [];
    for (let i = 0; i < n; i++) {
      const y = rand() < 0.3 ? 1 : 0;
      const f = { [y ? 's:boss@work' : `s:news${Math.floor(rand() * 5)}@list`]: 1, [`w:noise${Math.floor(rand() * 20)}`]: 1 };
      if (y) f['f:question'] = 1;
      out.push({ features: f, label: y, t: i });
    }
    return out;
  }
  it('learns a separable toy set', () => {
    const data = toySet(7);
    const model = train(data, { bits: 14, seed: 3 });
    expect(predict(model, { 's:boss@work': 1, 'f:question': 1 })).toBeGreaterThan(0.9);
    expect(predict(model, { 's:news2@list': 1 })).toBeLessThan(0.1);
    const m = evaluate(model, data);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(contributions(model, { 's:boss@work': 1, 'w:noise1': 1 })[0].name).toBe('s:boss@work');
  });
  it('is deterministic for a seed', () => {
    const data = toySet(11, 80);
    expect(JSON.stringify(train(data, { bits: 12, seed: 5 }))).toBe(JSON.stringify(train(data, { bits: 12, seed: 5 })));
  });
  it('class weighting keeps a rare positive class detectable', () => {
    const data = [];
    for (let i = 0; i < 95; i++) data.push({ features: { [`s:n${i % 7}@x`]: 1, 'k:notification': 1 }, label: 0 });
    for (let i = 0; i < 5; i++) data.push({ features: { 's:vip@x': 1, 'k:person': 1 }, label: 1 });
    const model = train(data, { bits: 12 });
    expect(predict(model, { 's:vip@x': 1, 'k:person': 1 })).toBeGreaterThan(0.5);
  });
  it('reports metrics on a time-ordered holdout', () => {
    const { model, metrics } = trainWithHoldout(toySet(5, 100), { bits: 12 });
    expect(metrics.holdout.n).toBe(20);
    expect(metrics.holdout.accuracy).toBeGreaterThan(0.9);
    expect(model.samples).toBe(100);
  });
});

describe('labels', () => {
  it('derives implicit labels from behaviour', () => {
    expect(deriveImplicitLabel({ replied: true })).toBe('needs_you');
    expect(deriveImplicitLabel({ opened: true, starred: true })).toBe('needs_you');
    expect(deriveImplicitLabel({ opened: true, archived: true })).toBe('dismissed');
    expect(deriveImplicitLabel({ opened: true, deleted: true })).toBe('dismissed');
    expect(deriveImplicitLabel({ opened: false })).toBe('ignored');
    expect(deriveImplicitLabel({ opened: true })).toBeNull();
    expect(labelTarget('needs_you')).toBe(1);
    expect(labelTarget('digest')).toBe(0);
    expect(labelTarget('waiting_on')).toBeNull();
  });
  it('prefers explicit labels and weights them higher', () => {
    const s = feedbackToSamples([
      { message_id: 'x', label: 'ignored', source: 'implicit', features: { a: 1 }, created_at: '2026-09-02' },
      { message_id: 'x', label: 'needs_you', source: 'explicit', features: { a: 1 }, created_at: '2026-09-01' },
      { message_id: 'y', label: 'dismissed', source: 'implicit', features: {}, created_at: '2026-09-01' },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ label: 1, weight: 3, source: 'explicit' });
  });
  it('detects waiting-on for unanswered questions only', () => {
    const row = msg({ from_email: 'me@example.com', to_addresses: [{ address: 'ops@vantage.example', name: 'Ops' }], date: daysAgo(6) });
    const d = waitingOnDecision({ row, text: 'Hi Ops, can we get a replacement before the offsite?', userAddresses: ME, now: NOW, waitingDays: 3 });
    expect(d.reasonLabel).toBe('Waiting 6 d');
    expect(d.reasons[0].label).toBe('You asked Ops a question');
    expect(waitingOnDecision({ row: { ...row, date: daysAgo(1) }, text: 'Can we?', userAddresses: ME, now: NOW, waitingDays: 3 })).toBeNull();
    expect(waitingOnDecision({ row, text: 'Thanks, all done.', userAddresses: ME, now: NOW, waitingDays: 3 })).toBeNull();
    expect(waitingOnDecision({ row: { ...row, to_addresses: [{ address: 'noreply@x.com' }] }, text: 'Can you?', userAddresses: ME, now: NOW, waitingDays: 3 })).toBeNull();
  });
});

describe('decide (stages combined)', () => {
  const base = { userAddresses: ME, thread: [], rules: [], sender: null, cfg: CFG, now: NOW };
  it('stays at stage 1 until the model has enough samples', () => {
    const model = { version: 1, samples: 10, model: train([{ features: { 's:alex@example.org': 1 }, label: 1 }, { features: { 's:x@y': 1 }, label: 0 }], { bits: 10 }) };
    const d = decide({ ...base, row: msg(), text: 'Can you call me?', model });
    expect(d.stage).toBe(1);
  });
  it('lets a trained model promote a sender the user always acts on', () => {
    const samples = [];
    for (let i = 0; i < 30; i++) samples.push({ features: { 's:alerts@bank.example': 1, 'k:notification': 1 }, label: 1 });
    for (let i = 0; i < 30; i++) samples.push({ features: { [`s:n${i}@list.example`]: 1, 'k:notification': 1 }, label: 0 });
    const model = { version: 4, samples: 60, model: train(samples) };
    const d = decide({ ...base, row: msg({ from_email: 'alerts@bank.example' }), text: 'Your statement is ready.', model });
    expect(d.stage).toBe(2);
    expect(d.modelVersion).toBe(4);
    expect(d.category).toBe('needs_you');
    expect(d.reasonLabel).toBe('You act on these');
    expect(d.reasons[0].label).toBe('Learned: mail from alerts@bank.example');
  });
  it('asks the language model only inside the uncertain band', () => {
    const unsure = decide({ ...base, row: msg(), text: 'Is someone going to be in?' });
    expect(unsure.priority).toBeGreaterThanOrEqual(0.35);
    expect(unsure.priority).toBeLessThanOrEqual(0.65);
    expect(unsure.askModel).toBe(true);
    const sure = decide({ ...base, row: msg(), text: 'Can you send the signed form by Friday? It is urgent.' });
    expect(sure.askModel).toBe(false);
    const spam = decide({ ...base, row: msg({ spam_verdict: 'spam' }), text: 'Is someone going to be in?' });
    expect(spam.askModel).toBe(false);
  });
  it('applies a plugin verdict and names the plugin, but not over a user rule', () => {
    const plugin = mergePluginResults([undefined, { features: { vip: 1 } }, { pluginId: 'vip-list', verdict: { category: 'needs_you', reason: 'VIP sender' } }, { verdict: { category: 'bogus' } }]);
    expect(plugin.features).toEqual({ vip: 1 });
    const d = decide({ ...base, row: msg({ is_bulk: true }), text: 'Weekly notes', plugin });
    expect(d.category).toBe('needs_you');
    expect(d.reasons[0].label).toBe('Plugin vip-list: VIP sender');
    expect(d.features['p:vip']).toBe(1);
    const ruled = decide({ ...base, row: msg(), text: 'hi', plugin, rules: [{ kind: 'sender', value: 'alex@example.org', category: 'digest' }] });
    expect(ruled.category).toBe('digest');
  });
  it('resolves decisions for mail already archived', () => {
    expect(decide({ ...base, row: msg({ folder: 'Archive' }), text: 'Can you call?' }).resolved).toBe(true);
    expect(isGone({ folder: 'INBOX', special_use: '\\Trash' })).toBe(true);
    expect(isGone({ folder: 'INBOX' })).toBe(false);
  });
});

describe('stage 3', () => {
  it('validates model output', () => {
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict({ foo: 1 })).toBeNull();
    const v = parseVerdict({ needs_reply: true, action_required: 'false', urgency: 'extreme', deadline: '2026-09-30', reason: 'one two three four five six seven eight nine ten' }, NOW);
    expect(v).toMatchObject({ needsReply: true, actionRequired: false, urgency: 'normal', reason: 'one two three four five six seven eight' });
    expect(v.deadline.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(parseVerdict({ needs_reply: false, deadline: '1999-01-01' }, NOW).deadline).toBeNull();
  });
  it('folds the verdict into the stored decision', () => {
    const t = { category: 'everything', priority: 0.45, reasons: [{ label: 'Asks you a question', weight: 2, direction: 'for' }], reason_label: 'FYI' };
    const yes = applyVerdict(t, { needsReply: true, actionRequired: false, urgency: 'high', deadline: null, reason: 'Landlord needs access Thursday' }, { now: NOW });
    expect(yes).toMatchObject({ category: 'needs_you', needsYou: true, reasonLabel: 'Urgent' });
    expect(yes.reasons[0]).toMatchObject({ label: 'Model: Landlord needs access Thursday', direction: 'for' });
    const no = applyVerdict(t, { needsReply: false, actionRequired: false, urgency: 'low', deadline: null, reason: '' }, { now: NOW });
    expect(no).toMatchObject({ category: 'everything', needsYou: false, reasonLabel: 'FYI' });
    expect(no.reasons[0].label).toBe('Model: no action needed');
  });
});

describe('store and sender behaviour', () => {
  it('maps rows to TriageInfo with the override and a live deadline chip', () => {
    const info = toTriageInfo({
      category: 'needs_you', override_category: 'digest', overridden: true, priority: '0.8', needs_you: true, confidence: 0.6, stage: 2,
      reason_label: 'Deadline · 9 d', deadline_at: '2026-09-30T23:59:00Z', decided_at: 'x',
      reasons: [{ label: 'a', weight: 1, direction: 'for', flag: 'question' }],
    }, NOW);
    expect(info).toEqual({ category: 'digest', priority: 0.8, needs_you: false, confidence: 0.6, stage: 2, reason_label: 'Deadline · 7 d', reasons: [{ label: 'a', weight: 1, direction: 'for' }], overridden: true, decided_at: 'x' });
  });
  it('aggregates opened, starred and archived-unread per sender', () => {
    const d = behaviourDeltas([
      { stat_email: 'A@x.com', is_read: true, is_starred: true },
      { from_email: 'a@x.com', is_read: false, folder: 'Archive' },
      { from_email: 'a@x.com', is_read: false, is_deleted: true },
      { from_email: 'b@x.com', is_read: false, folder: 'INBOX' },
    ]);
    expect(d.get('a@x.com')).toEqual({ opened: 1, starred: 1, archived_unread: 1, deleted_unread: 1 });
    expect(d.get('b@x.com')).toEqual({ opened: 0, starred: 0, archived_unread: 0, deleted_unread: 0 });
  });
});

describe('service validation', () => {
  it('rejects bad input before touching the database', async () => {
    await expect(service.listTriage('u', { view: 'inbox' })).rejects.toMatchObject({ status: 400 });
    await expect(service.listTriage('u', { accountId: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(service.overrideTriage('u', 'not-a-uuid', { category: 'spam' })).rejects.toMatchObject({ status: 400 });
    await expect(service.overrideTriage('u', '00000000-0000-4000-8000-000000000001', { category: 'later' })).rejects.toMatchObject({ status: 400 });
    await expect(service.senderRule('u', { category: 'digest' })).rejects.toMatchObject({ status: 400 });
    await expect(service.senderRule('u', { sender: 'not an email', category: 'digest' })).rejects.toMatchObject({ status: 400 });
    await expect(service.senderRule('u', { domain: 'example.org', category: 'waiting_on' })).rejects.toMatchObject({ status: 400 });
  });
  it('returns 404 for a message the user does not own', async () => {
    await expect(service.overrideTriage('u', '00000000-0000-4000-8000-000000000001', { category: 'spam' })).rejects.toMatchObject({ status: 404 });
    await expect(service.resolveTriage('u', '00000000-0000-4000-8000-000000000001')).rejects.toMatchObject({ status: 404 });
    expect(await service.getTriage('u', '00000000-0000-4000-8000-000000000001')).toBeNull();
  });
  it('returns zeroed counts for an empty mailbox', async () => {
    const out = await service.listTriage('u', {});
    expect(out).toEqual({ items: [], counts: { needs_you: 0, waiting_on: 0, digest: 0, notifications: 0, everything: 0, spam: 0 } });
  });
});

describe('provider junk push', () => {
  const MID = '00000000-0000-4000-8000-0000000000aa';
  function fakeImap() {
    const calls = [];
    return {
      calls,
      moveMessage: vi.fn(async (...a) => { calls.push(['move', ...a]); return 77; }),
      _guardMoveUid: vi.fn((...a) => calls.push(['guard', ...a])),
      _unguardMoveUid: vi.fn((...a) => calls.push(['unguard', ...a])),
      broadcast: vi.fn(),
    };
  }
  function dbWith(category) {
    const writes = [];
    db.query.mockImplementation(async (sql, params) => {
      if (/triage_category/.test(sql)) return { rows: [{ id: MID, account_id: 'acc', uid: 12, folder: 'INBOX', is_read: false, is_deleted: false, folder_mappings: {}, triage_category: category }] };
      if (/SELECT \* FROM email_accounts/.test(sql)) return { rows: [{ id: 'acc', user_id: 'u1', email_address: 'me@example.com' }] };
      if (/^\s*(UPDATE|DELETE)/.test(sql)) writes.push([sql.replace(/\s+/g, ' ').trim(), params]);
      return { rows: [], rowCount: 0 };
    });
    return writes;
  }

  it('moves an overridden spam message to the junk folder, guarded, and never deletes mail', async () => {
    process.env.HEDWIG_TRIAGE_PUSH_JUNK_TO_PROVIDER = 'true';
    try {
      const writes = dbWith('spam');
      const imap = fakeImap();
      const out = await makePushJunkHandler(imap)({ messageId: MID }, { user_id: 'u1' });
      expect(out).toEqual({ moved: true, folder: 'Junk' });
      expect(imap.calls.map((c) => c[0])).toEqual(['guard', 'move', 'unguard']);
      expect(imap.moveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc' }), 12, 'INBOX', 'Junk');
      const moved = writes.find(([sql]) => sql.startsWith('UPDATE messages SET folder'));
      expect(moved[1]).toEqual(['Junk', 77, MID]);
      // The only DELETE is upstream's stale-row cleanup at the destination UID, never this message.
      const del = writes.filter(([sql]) => sql.startsWith('DELETE'));
      expect(del).toHaveLength(1);
      expect(del[0][0]).toContain('id != $4');
      expect(del[0][1]).toEqual(['acc', 77, 'Junk', MID]);
    } finally {
      delete process.env.HEDWIG_TRIAGE_PUSH_JUNK_TO_PROVIDER;
      db.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    }
  });

  it('does nothing when the setting is off or the user changed their mind', async () => {
    dbWith('spam');
    const imap = fakeImap();
    expect(await makePushJunkHandler(imap)({ messageId: MID }, { user_id: 'u1' })).toEqual({ skipped: 'disabled' });
    process.env.HEDWIG_TRIAGE_PUSH_JUNK_TO_PROVIDER = 'true';
    try {
      dbWith('needs_you');
      expect(await makePushJunkHandler(imap)({ messageId: MID }, { user_id: 'u1' })).toEqual({ skipped: 'no longer spam' });
      expect(imap.moveMessage).not.toHaveBeenCalled();
    } finally {
      delete process.env.HEDWIG_TRIAGE_PUSH_JUNK_TO_PROVIDER;
      db.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    }
  });
});
