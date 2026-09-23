import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

// A pattern-routed fake db: each test sets db.routes; unmatched queries return no rows.
const db = vi.hoisted(() => ({ calls: [], routes: [], nextId: 1 }));
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ');
    db.calls.push({ sql: text, params });
    if (/INSERT INTO hedwig_ai_calls/.test(text)) return { rows: [{ id: db.nextId++ }] };
    if (/FROM hedwig_ai_calls/.test(text)) return { rows: [{ n: 0, tokens: 0 }] };
    for (const [re, fn] of db.routes) if (re.test(text)) return fn(params, text);
    return { rows: [], rowCount: 0 };
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../sort/bundles.js', () => ({ loadBundles: async () => [{ key: 'receipts', name: 'Receipts', hint: 'orders and payments' }] }));

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';
const USER = '11111111-1111-4111-8111-111111111111';
const gw = mockGateway();
const cfg = {
  enabled: true, 'llm.baseUrl': gw.baseUrl, 'llm.apiKey': '', 'llm.catalogUrl': gw.catalogUrl,
  'llm.models.fast': GEMMA, 'llm.models.long': QWEN, 'llm.models.agent': QWEN,
  'llm.reasoning.fast': 'off', 'llm.reasoning.long': 'low', 'llm.reasoning.agent': 'low', 'llm.offSpelling': 'none',
  'llm.timeoutMs': 5000, 'llm.concurrency': 4, 'llm.fallbackModel': '', 'llm.fallbackAfterMs': 45000, 'llm.fallbackCooldownSec': 60,
  'llm.lanes.interactive.concurrency': 2, 'llm.lanes.background.concurrency': 2, 'llm.lanes.interactive.fallbackAfterMs': 8000,
  'llm.lanes.leaseSec': 300, 'llm.defaultMaxOutputTokens': 8192, 'llm.keepTranscripts': false, 'llm.transcriptDays': 14,
  'llm.tokenBudget.labels': 1_000_000,
  'labels.questionsPerDay': 3, 'labels.judgeSample': 100, 'labels.judgeHour': 3, 'labels.judgeBatch': 5, 'labels.judgeMinConfidence': 0.7,
  'labels.windowDays': 30, 'labels.replyWithinHours': 24, 'labels.archiveUnreadMin': 3, 'labels.readEngagedSec': 30,
  'labels.bulkArchiveMin': 5, 'labels.askTriplesPerNight': 10, 'eval.gatePoints': 2,
};
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) }));

const behaviour = await import('./behaviour.js');
const { stratifiedSample, stratumOf } = await import('./sample.js');
const questions = await import('./questions.js');
const metrics = await import('./metrics.js');
const { reconcileItem, judgeForUser, independentTiers } = await import('./judge.js');
const { resolveTargetLabels } = await import('./store.js');
const { quoteInSources, mapSourceIds } = await import('./askTriples.js');
const runtime = await import('./runtime.js');
const { _resetLlmState } = await import('../llm.js');

const HOUR = 3600_000;
const t0 = Date.parse('2026-09-01T09:00:00Z');
const at = (h) => new Date(t0 + h * HOUR).toISOString();

beforeEach(() => {
  db.calls.length = 0;
  db.routes = [];
});
afterAll(() => gw.restore());

// ── Behaviour rules ─────────────────────────────────────────────────────────

describe('behaviour labels', () => {
  it('a direct reply within a day is silver needs-you and people; same-thread is weak; later is nothing', () => {
    const out = behaviour.replyLabels([
      { id: 'a', mid: '<a>', date: at(0), replied_at: at(3), direct: true },
      { id: 'b', mid: '<b>', date: at(0), replied_at: at(20), direct: false },
      { id: 'c', mid: '<c>', date: at(0), replied_at: at(30), direct: true },
    ], { withinHours: 24 });
    const by = (id, suite) => out.find((l) => l.targetId === id && l.suite === suite);
    expect(by('a', 'needs_you')).toMatchObject({ label: { needs_you: true }, grade: 'silver', source: 'behaviour' });
    expect(by('a', 'sort')).toMatchObject({ label: { stream: 'people' }, grade: 'silver' });
    expect(by('a', 'needs_you').evidence).toMatchObject({ rule: 'reply', hours: 3, direct: true, mid: '<a>' });
    expect(by('b', 'needs_you').grade).toBe('weak');
    expect(by('c', 'needs_you')).toBeUndefined();
  });

  it('archived unread three times from one sender is not needs-you; fewer is nothing', () => {
    const rows = [
      { id: '1', sender: 'news@x.com', date: at(0), is_read: false },
      { id: '2', sender: 'news@x.com', date: at(24), is_read: false },
      { id: '3', sender: 'news@x.com', date: at(48), is_read: false },
      { id: '4', sender: 'friend@y.com', date: at(0), is_read: false },
      { id: '5', sender: 'friend@y.com', date: at(1), is_read: false },
    ];
    const out = behaviour.archiveUnreadLabels(rows, { min: 3, bulkMin: 5 });
    expect(out.map((l) => l.targetId).sort()).toEqual(['1', '2', '3']);
    expect(out[0]).toMatchObject({ suite: 'needs_you', label: { needs_you: false }, grade: 'weak' });
    expect(out[0].evidence).toMatchObject({ rule: 'archive_unread', count: 3, first: '2026-09-01', last: '2026-09-03' });
  });

  it('read archived mail does not count, but a bulk archive (>= 5 in one second) counts as skipped even when read', () => {
    const read = [1, 2, 3].map((i) => ({ id: `r${i}`, sender: 's@x.com', date: at(i), is_read: true, moved_later: true, same_second: 1 }));
    expect(behaviour.archiveUnreadLabels(read, { min: 3, bulkMin: 5 })).toHaveLength(0);
    const bulk = [1, 2, 3].map((i) => ({ id: `b${i}`, sender: 's@x.com', date: at(i), is_read: true, moved_later: true, same_second: 7 }));
    const out = behaviour.archiveUnreadLabels(bulk, { min: 3, bulkMin: 5 });
    expect(out).toHaveLength(3);
    expect(out.every((l) => l.evidence.skipped)).toBe(true);
    // Rows present since the folder's first sync are state, not a bulk action.
    const initial = [1, 2, 3].map((i) => ({ id: `i${i}`, sender: 's@x.com', date: at(i), is_read: true, moved_later: false, same_second: 40 }));
    expect(behaviour.archiveUnreadLabels(initial, { min: 3, bulkMin: 5 })).toHaveLength(0);
  });

  it('a replied message never counts as archived unread, and copies of one message count once', () => {
    const rows = [
      { id: '1', mid: '<m1>', sender: 's@x.com', date: at(0), is_read: false },
      { id: '1b', mid: '<m1>', sender: 's@x.com', date: at(0), is_read: false },
      { id: '2', mid: '<m2>', sender: 's@x.com', date: at(1), is_read: false },
      { id: '3', mid: '<m3>', sender: 's@x.com', date: at(2), is_read: false, replied: true },
    ];
    expect(behaviour.archiveUnreadLabels(rows, { min: 3 })).toHaveLength(0);
  });

  it('engaged: the gap to the next read between 30 s and 15 min; bulk reads, outgoing and skipped never', () => {
    const s = (sec) => new Date(t0 + sec * 1000).toISOString();
    const reads = [
      { id: 'quick', read_at: s(0) },            // next read 10 s later: skimmed
      { id: 'long', read_at: s(10) },            // next read 70 s later: engaged
      { id: 'bulk1', read_at: s(80) },           // mark-all-read: same second
      { id: 'bulk2', read_at: s(80) },
      { id: 'mine', read_at: s(200), outgoing: true },
      { id: 'skip', read_at: s(300), skipped: true },
      { id: 'away', read_at: s(400) },           // next read an hour later: unknown
      { id: 'last', read_at: s(4000) },
    ];
    const out = behaviour.engagedLabels(reads, { minSec: 30 });
    expect(out.map((l) => l.targetId)).toEqual(['long']);
    expect(out[0]).toMatchObject({ suite: 'sort', label: { engaged: true }, grade: 'weak' });
    expect(out[0].evidence).toMatchObject({ rule: 'engaged', seconds: 70, proxy: 'read_gap' });
  });

  it('spam marks are strong labels; the latest mark wins; "not spam" out of a spam folder is a rescue', () => {
    const out = behaviour.spamLabels([
      { id: 'a', mid: '<a>', label: 'spam', at: at(0), folder: 'INBOX', in_spam_folder: false },
      { id: 'a', mid: '<a>', label: 'ham', at: at(5), folder: 'Junk', in_spam_folder: true },
      { id: 'b', mid: '<b>', label: 'spam', at: at(1), folder: 'INBOX', in_spam_folder: false },
    ]);
    expect(out.find((l) => l.targetId === 'a' && l.suite === 'spam')).toMatchObject({ label: { spam: false }, grade: 'silver' });
    expect(out.find((l) => l.targetId === 'a' && l.suite === 'rescue')).toMatchObject({ label: { rescue: true }, grade: 'silver' });
    expect(out.find((l) => l.targetId === 'b' && l.suite === 'spam').label).toEqual({ spam: true });
    expect(out.find((l) => l.targetId === 'b' && l.suite === 'rescue')).toBeUndefined();
  });

  it('sent-to makes people (silver from two sends); unsubscribe makes not-people', () => {
    const sent = behaviour.sentToLabels([
      { id: 'x', sender: 'a@b.c', sent_count: 1, last_sent: at(0) },
      { id: 'y', sender: 'd@e.f', sent_count: 4, last_sent: at(0) },
    ]);
    expect(sent.map((l) => [l.targetId, l.grade, l.label.stream])).toEqual([['x', 'weak', 'people'], ['y', 'silver', 'people']]);
    const unsub = behaviour.unsubscribeLabels([{ id: 'z', sender: 'n@l.com', unsubscribed_at: at(2) }]);
    expect(unsub[0]).toMatchObject({ suite: 'sort', label: { notStream: 'people' }, grade: 'silver', evidence: { rule: 'unsubscribe' } });
  });

  it('behaviourForUser writes every rule it derives in one upsert', async () => {
    const inserts = [];
    db.routes = [
      [/JOIN LATERAL/, () => ({ rows: [{ id: 'm1', mid: '<m1>', sender: 'p@x.com', date: at(0), replied_at: at(2), direct: true }] })],
      [/WITH arch AS/, () => ({ rows: [] })],
      [/m\.read_changed_at AS read_at/, () => ({ rows: [] })],
      [/FROM spam_training_log/, () => ({ rows: [{ id: 'm2', mid: '<m2>', label: 'spam', at: at(1), folder: 'INBOX', in_spam_folder: false, rule: 'spam_move' }] })],
      [/spam_user_override AS label/, () => ({ rows: [] })],
      [/WITH sent AS/, () => ({ rows: [] })],
      [/WITH unsub AS/, () => ({ rows: [] })],
      [/INSERT INTO hedwig_labels/, (p) => { inserts.push(p); return { rows: [], rowCount: p[1].length }; }],
    ];
    const n = await behaviour.behaviourForUser(USER, new Set(['me@x.com']), cfg);
    expect(n).toBe(3);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1].sort()).toEqual(['needs_you', 'sort', 'spam']);
    expect(inserts[0][4]).toEqual(['silver', 'silver', 'silver']);
  });
});

// ── Sampling ────────────────────────────────────────────────────────────────

describe('stratified sampling', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  const day = 86400_000;
  const rows = [];
  // 300 recent inbox mails from one frequent sender, a handful elsewhere.
  for (let i = 0; i < 300; i++) rows.push({ id: `in${i}`, folder: 'INBOX', sender_volume: 300, date: new Date(now - day).toISOString() });
  for (let i = 0; i < 3; i++) rows.push({ id: `sp${i}`, folder: 'Junk', sender_volume: 1, date: new Date(now - 2 * day).toISOString() });
  for (let i = 0; i < 4; i++) rows.push({ id: `ar${i}`, folder: 'Archive', sender_volume: 5, date: new Date(now - 90 * day).toISOString() });
  for (let i = 0; i < 20; i++) rows.push({ id: `old${i}`, folder: 'INBOX', sender_volume: 2, date: new Date(now - 60 * day).toISOString() });

  it('covers every stratum before taking more from a big one', () => {
    const sample = stratifiedSample(rows, 12, { seed: 'u:2026-09-23', now });
    const strata = new Set(sample.map((s) => s.stratum));
    expect(strata).toEqual(new Set(['inbox|frequent|week', 'spam|rare|week', 'archive|regular|older', 'inbox|rare|older']));
    expect(sample.filter((s) => s.stratum === 'spam|rare|week')).toHaveLength(3);
    expect(sample.filter((s) => s.stratum === 'inbox|frequent|week')).toHaveLength(3);
    expect(sample).toHaveLength(12);
  });

  it('is deterministic per seed, never repeats a row and stops at the pool size', () => {
    const a = stratifiedSample(rows, 20, { seed: 's1', now }).map((r) => r.id);
    const b = stratifiedSample(rows, 20, { seed: 's1', now }).map((r) => r.id);
    const c = stratifiedSample(rows, 20, { seed: 's2', now }).map((r) => r.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(new Set(a).size).toBe(20);
    expect(stratifiedSample(rows.slice(300, 305), 50, { now })).toHaveLength(5);
    expect(stratifiedSample(rows, 0, { now })).toEqual([]);
  });

  it('buckets folder, sender volume and age', () => {
    expect(stratumOf({ folder: 'INBOX.Spam', sender_volume: 11, date: new Date(now - 10 * day) }, now)).toBe('spam|frequent|month');
    expect(stratumOf({ folder: 'Work', special_use: '\\Archive', sender_volume: 3, date: new Date(now) }, now)).toBe('archive|regular|week');
  });
});

// ── Judge reconciliation ────────────────────────────────────────────────────

describe('judge reconciliation', () => {
  const judge = { stream: 'people', needs_you: true, spam: 'clean', confidence: 0.9, rationale: 'Priya asks you to sign' };

  it('both tiers agreeing with enough confidence and no contrary behaviour → silver', () => {
    const { labels, candidates } = reconcileItem({ targetId: 't', judge, reflex: { stream: 'people', needs_you: true, spam: 'clean' } });
    expect(labels.map((l) => [l.suite, l.label])).toEqual([['sort', { stream: 'people' }], ['needs_you', { needs_you: true }], ['spam', { spam: false }]]);
    expect(labels.every((l) => l.grade === 'silver' && l.source === 'judge')).toBe(true);
    expect(candidates).toEqual([]);
  });

  it('behaviour that contradicts the models becomes a question, not a label', () => {
    const { labels, candidates } = reconcileItem({
      targetId: 't', judge, reflex: { stream: 'people', needs_you: true, spam: 'clean' },
      behaviour: { needs_you: { value: false, grade: 'weak', rule: 'archive_unread' } },
    });
    expect(labels.find((l) => l.suite === 'needs_you')).toBeUndefined();
    expect(candidates).toEqual([expect.objectContaining({ kind: 'needs_you', why: 'behaviour_conflict' })]);
  });

  it('tiers disagreeing, or low confidence, become questions; spam disagreement ranks above stream', () => {
    const { candidates } = reconcileItem({ targetId: 't', judge: { ...judge, confidence: 0.5 }, reflex: { stream: 'reading', needs_you: true, spam: 'suspected' } });
    const kinds = Object.fromEntries(candidates.map((c) => [c.kind, c.why]));
    expect(kinds).toEqual({ stream: 'models_disagree', needs_you: 'low_confidence', spam: 'spam_disagree' });
    const byPriority = [...candidates].sort((a, b) => b.priority - a.priority).map((c) => c.kind);
    expect(byPriority[0]).toBe('spam');
  });

  it('without a Reflex opinion only behaviour agreement makes silver; unsubscribe contradicts people', () => {
    const { labels } = reconcileItem({ targetId: 't', judge, reflex: null, behaviour: { stream: { value: 'people', grade: 'silver' } } });
    expect(labels.map((l) => l.suite)).toEqual(['sort']);
    const res = reconcileItem({ targetId: 't', judge, reflex: { stream: 'people' }, behaviour: { notStream: { value: 'people', grade: 'silver' } } });
    expect(res.candidates.find((c) => c.kind === 'stream').why).toBe('behaviour_conflict');
  });

  it('a spam verdict on mail in the spam folder also labels rescue', () => {
    const { labels } = reconcileItem({ targetId: 't', inSpam: true, judge, reflex: { stream: 'people', needs_you: true, spam: 'clean' } });
    expect(labels.find((l) => l.suite === 'rescue').label).toEqual({ rescue: true });
  });

  it('agreement counts only between the reasoning tier and the Reflex tier on two different models', () => {
    const q = { tier: 'reasoning', model: QWEN };
    const g = { tier: 'reflex', model: GEMMA };
    expect(independentTiers(q, g)).toBe(true);
    expect(independentTiers(q, { tier: 'reasoning', model: QWEN })).toBe(false); // Reflex's last retry ran on Qwen
    expect(independentTiers({ tier: 'reflex', model: GEMMA }, g)).toBe(false); // the judge's last retry ran on Gemma
    expect(independentTiers(q, { tier: 'reflex', model: QWEN })).toBe(false); // fallback swapped Reflex onto Qwen
    expect(independentTiers(q, null)).toBe(false);
  });

  it('same-model agreement makes no label and goes to the question queue; behaviour can still back the judge', () => {
    const { labels, candidates } = reconcileItem({ targetId: 't', judge, reflex: { stream: 'people', needs_you: true, spam: 'clean' }, independent: false });
    expect(labels).toEqual([]);
    expect(candidates.map((c) => c.why)).toEqual(['same_model', 'same_model', 'same_model']);
    const backed = reconcileItem({ targetId: 't', judge, reflex: { stream: 'people' }, independent: false, behaviour: { stream: { value: 'people', grade: 'silver' } } });
    expect(backed.labels.map((l) => l.suite)).toEqual(['sort']);
  });
});

describe('label resolution', () => {
  it('gold beats silver beats weak, and conflicts at the top grade are flagged', () => {
    const rows = [
      { target_id: 'a', label: { needs_you: false }, grade: 'weak', source: 'behaviour', created_at: at(5) },
      { target_id: 'a', label: { needs_you: true }, grade: 'silver', source: 'judge', created_at: at(1) },
      { target_id: 'b', label: { needs_you: true }, grade: 'silver', source: 'behaviour', created_at: at(1) },
      { target_id: 'b', label: { needs_you: false }, grade: 'silver', source: 'judge', created_at: at(2) },
      { target_id: 'b', label: { needs_you: false }, grade: 'gold', source: 'question', created_at: at(0) },
      { target_id: 'c', label: { engaged: true }, grade: 'weak', source: 'behaviour', created_at: at(0) },
    ];
    const r = resolveTargetLabels(rows, 'needs_you');
    expect(r.get('a')).toMatchObject({ value: true, grade: 'silver', conflict: false });
    expect(r.get('b')).toMatchObject({ value: false, grade: 'gold', source: 'question' });
    expect(r.has('c')).toBe(false);
    const conflicted = resolveTargetLabels(rows.slice(2, 4), 'needs_you');
    expect(conflicted.get('b').conflict).toBe(true);
  });
});

// ── Questions ───────────────────────────────────────────────────────────────

describe('questions', () => {
  it('dedupe keeps the best candidate per target and never re-asks a target', () => {
    const out = questions.dedupeCandidates([
      { targetId: 'a', kind: 'stream', priority: 1 },
      { targetId: 'a', kind: 'spam', priority: 3 },
      { targetId: 'b', kind: 'needs_you', priority: 2 },
      { targetId: 'c', kind: 'stream', priority: 9 },
    ], new Set(['c']));
    expect(out.map((c) => [c.targetId, c.kind])).toEqual([['a', 'spam'], ['b', 'needs_you']]);
  });

  it('drops a question when other evidence settles it, with a reason', () => {
    const q = { kind: 'needs_you', created_at: at(0) };
    expect(questions.settleDecision(q, { messageExists: false })).toEqual({ drop: true, reason: 'the message is gone' });
    expect(questions.settleDecision(q, { messageExists: true, correctedAfter: true }).drop).toBe(true);
    expect(questions.settleDecision(q, { messageExists: true, labels: [{ suite: 'needs_you', label: { needs_you: true }, grade: 'gold', source: 'correction', created_at: at(-5) }] }))
      .toEqual({ drop: true, reason: 'answered elsewhere (correction)' });
    expect(questions.settleDecision(q, { messageExists: true, labels: [{ suite: 'needs_you', label: { needs_you: true }, grade: 'silver', source: 'behaviour', rule: 'reply', created_at: at(2) }] }))
      .toEqual({ drop: true, reason: 'settled by what you did (reply)' });
    // Behaviour that predates the question was already weighed when it was asked.
    expect(questions.settleDecision(q, { messageExists: true, labels: [{ suite: 'needs_you', label: { needs_you: true }, grade: 'silver', source: 'behaviour', created_at: at(-2) }] }).drop).toBe(false);
    // Evidence about another suite does not settle this one.
    expect(questions.settleDecision(q, { messageExists: true, labels: [{ suite: 'sort', label: { stream: 'people' }, grade: 'gold', source: 'question', created_at: at(1) }] }).drop).toBe(false);
  });

  it('writes templates in second person from the evidence, and rejects model text with invented numbers', () => {
    const ev = { from: 'Acme Store', subject: 'Your order', senderCount: 14, senderFirst: '2026-06-02', senderReplied: 0, inSpam: true };
    expect(questions.templateQuestion('needs_you', ev)).toBe('Acme Store has sent you 14 messages since June 2026 and you replied to 0. Did “Your order” need you?');
    expect(questions.templateQuestion('spam', ev)).toBe('“Your order” from Acme Store landed in your spam folder. Is it junk, or real mail?');
    expect(questions.questionIsGrounded('You have had 14 emails from Acme since June. Junk?', ev)).toBe(true);
    expect(questions.questionIsGrounded('You have had 15 emails from Acme. Junk?', ev)).toBe(false);
  });

  it('maps an answer to gold labels and to the sort correction body', () => {
    expect(questions.answerEffects('spam', 'clean', { inSpam: true })).toEqual({
      labels: [{ suite: 'spam', label: { spam: false } }, { suite: 'rescue', label: { rescue: true } }],
      correction: { kind: 'spam', after: { spam: 'rescued' } },
      sort: { spam: 'clean' },
    });
    expect(questions.answerEffects('needs_you', 'no').sort).toEqual({ needsYou: false });
    expect(questions.answerEffects('stream', 'reading').labels).toEqual([{ suite: 'sort', label: { stream: 'reading' } }]);
  });

  it('answer: gold label, then sorting applies it; without sorting a correction is recorded and "always" is queued', async () => {
    const q = { id: '22222222-2222-4222-8222-222222222222', user_id: USER, kind: 'stream', target_id: '33333333-3333-4333-8333-333333333333', options: questions.optionsFor('stream'), evidence: { mid: '<x>', models: { judge: 'people', reflex: 'reading' } } };
    const writes = { labels: [], corrections: [], jobs: [], updates: [] };
    db.routes = [
      [/SELECT \* FROM hedwig_questions WHERE id = \$1/, () => ({ rows: [{ ...q }] })],
      [/INSERT INTO hedwig_labels/, (p) => { writes.labels.push(p); return { rows: [], rowCount: 1 }; }],
      [/INSERT INTO hedwig_corrections/, (p) => { writes.corrections.push(p); return { rows: [{ id: 1 }] }; }],
      [/INSERT INTO hedwig_jobs/, (p) => { writes.jobs.push(p); return { rows: [{ id: 9 }] }; }],
      [/UPDATE hedwig_questions SET answered_at/, (p) => { writes.updates.push(p); return { rows: [], rowCount: 1 }; }],
    ];
    runtime._setLoader('../sort/correct.js', () => null);
    runtime._setLoader('../sort/corrections.js', () => null);
    runtime._setLoader('../sort/service.js', () => null);
    runtime._setLoader('../sort/index.js', () => null);
    const plain = await questions.answerQuestionById(USER, q.id, { optionId: 'reading' });
    expect(plain).toEqual({ ok: true, applied: null });
    expect(writes.labels[0][4]).toEqual(['gold']);
    expect(writes.labels[0][5]).toEqual(['question']);
    expect(JSON.parse(writes.labels[0][3][0])).toEqual({ stream: 'reading' });
    expect(writes.corrections).toHaveLength(1);
    expect(writes.corrections[0][1]).toBe('sort');

    const always = await questions.answerQuestionById(USER, q.id, { optionId: 'reading', always: true });
    expect(always).toEqual({ ok: true, applied: 'job' });
    expect(writes.jobs[0][0]).toBe('sort.applyCorrection');
    expect(JSON.parse(writes.jobs[0][1])).toMatchObject({ messageId: q.target_id, stream: 'reading', always: 'sender' });
    expect(writes.corrections).toHaveLength(1); // sorting records its own correction for "always"

    // With sorting installed, its correct() applies every answer and records the correction itself.
    const calls = [];
    runtime._setLoader('../sort/service.js', async () => ({ correct: async (u, body) => { calls.push(body); return { ok: true }; } }));
    expect((await questions.answerQuestionById(USER, q.id, { optionId: 'people', always: 'list' })).applied).toBe('sort');
    expect((await questions.answerQuestionById(USER, q.id, { optionId: 'records' })).applied).toBe('sort');
    expect(calls).toEqual([
      { messageId: q.target_id, stream: 'people', always: 'list', note: 'Answered a Hedwig question' },
      { messageId: q.target_id, stream: 'records', always: null, note: 'Answered a Hedwig question' },
    ]);
    expect(writes.corrections).toHaveLength(1);
    // Sorting failing (message gone) still leaves the gold label and a correction.
    runtime._setLoader('../sort/service.js', async () => ({ correct: async () => { throw Object.assign(new Error('Message not found'), { status: 404 }); } }));
    expect((await questions.answerQuestionById(USER, q.id, { optionId: 'reading' })).applied).toBeNull();
    expect(writes.corrections).toHaveLength(2);
    runtime._resetRuntime();

    await expect(questions.answerQuestionById(USER, q.id, { optionId: 'nope' })).rejects.toMatchObject({ status: 400 });
  });

  it('serves at most questionsPerDay a day, counting those already asked today', async () => {
    const updates = [];
    db.routes = [
      [/SELECT to_regclass/, () => ({ rows: [{ t: null }] })],
      [/FROM hedwig_questions q WHERE q.user_id = \$1 AND q.answered_at IS NULL/, () => ({ rows: [] })],
      [/COUNT\(\*\)::int AS asked/, () => ({ rows: [{ asked: 2 }] })],
      [/UPDATE hedwig_questions SET asked_at = NOW\(\)/, (p) => { updates.push(p); return { rows: [], rowCount: p[1] }; }],
      [/SELECT \* FROM hedwig_questions WHERE user_id = \$1 AND asked_at >=/, (p) => ({ rows: [{ id: 'q1', kind: 'spam', question: 'Junk?', evidence: {}, options: [], asked_at: at(0) }].slice(0, p[1]) })],
    ];
    const list = await questions.listOpenQuestions(USER);
    expect(updates).toEqual([[USER, 1]]);
    expect(list).toEqual([{ id: 'q1', kind: 'spam', question: 'Junk?', evidence: {}, options: [], askedAt: at(0) }]);
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

describe('eval metrics', () => {
  it('recall@k and reciprocal rank', () => {
    expect(metrics.recallAtK(['a', 'b', 'c', 'd'], ['c', 'x'], 3)).toBe(0.5);
    expect(metrics.recallAtK(['a', 'b', 'c', 'd'], ['d'], 3)).toBe(0);
    expect(metrics.recallAtK(['a'], [], 3)).toBeNull();
    expect(metrics.reciprocalRank(['a', 'b', 'c'], ['c', 'b'])).toBe(0.5);
    expect(metrics.reciprocalRank(['a'], ['z'])).toBe(0);
    expect(metrics.mean([1, 0.5, null, 0])).toBe(0.5);
    expect(metrics.uniqueInOrder(['m1', 'm1', 'm2', null, 'm1', 'm3'])).toEqual(['m1', 'm2', 'm3']);
  });

  it('precision, recall, F1, false-positive rate; missing predictions are coverage, not errors', () => {
    const pairs = [
      { truth: true, pred: true }, { truth: true, pred: true }, { truth: true, pred: false },
      { truth: false, pred: true }, { truth: false, pred: false }, { truth: false, pred: false }, { truth: false, pred: false },
      { truth: true, pred: null },
    ];
    const m = metrics.binaryMetrics(pairs);
    expect(m).toMatchObject({ n: 7, tp: 2, fp: 1, fn: 1, tn: 3, missing: 1 });
    expect(m.precision).toBeCloseTo(2 / 3, 4);
    expect(m.recall).toBeCloseTo(2 / 3, 4);
    expect(m.f1).toBeCloseTo(2 / 3, 4);
    expect(m.fpr).toBe(0.25);
    expect(m.accuracy).toBeCloseTo(5 / 7, 4);
    expect(m.coverage).toBeCloseTo(7 / 8, 4);
    expect(metrics.binaryMetrics([]).precision).toBeNull();
  });

  it('multiclass accuracy and macro F1, with not-X truths scored as right or wrong', () => {
    const m = metrics.multiclassMetrics([
      { truth: 'people', pred: 'people' }, { truth: 'people', pred: 'reading' },
      { truth: 'reading', pred: 'reading' }, { truth: 'records', pred: 'records' },
      { truth: { not: 'people' }, pred: 'reading' }, { truth: { not: 'people' }, pred: 'people' },
      { truth: 'people', pred: null },
    ], ['people', 'reading', 'records']);
    expect(m.n).toBe(6);
    expect(m.missing).toBe(1);
    expect(m.accuracy).toBeCloseTo(4 / 6, 4);
    expect(m.perClass.people).toMatchObject({ precision: 1, recall: 0.5, support: 2 });
    expect(m.perClass.reading.precision).toBe(0.5);
    expect(m.macroF1).toBeCloseTo((2 / 3 + 2 / 3 + 1) / 3, 3);
  });

  it('gates: gold drop beyond the allowance fails; spam false positives may never rise; first run is the baseline', () => {
    const prev = { silver: { precision: 0.9, fpr: 0.02 }, gold: { precision: 0.9, recall: 0.8, fpr: 0.05, n: 40 } };
    expect(metrics.checkGates('needs_you', { gold: { precision: 0.885, recall: 0.8 } }, prev, { gatePoints: 2 }).pass).toBe(true);
    const drop = metrics.checkGates('needs_you', { gold: { precision: 0.87, recall: 0.8 } }, prev, { gatePoints: 2 });
    expect(drop.pass).toBe(false);
    expect(drop.failures[0]).toMatch(/gold precision down 3 points/);
    const spam = metrics.checkGates('spam', { silver: { precision: 0.95, fpr: 0.021 }, gold: { precision: 0.95, recall: 0.8, fpr: 0.05 } }, prev, { gatePoints: 2 });
    expect(spam.pass).toBe(false);
    expect(spam.failures.join(' ')).toMatch(/silver false-positive rate up/);
    // Only the spam suites carry the never-up rule; a count changing is never a gate.
    expect(metrics.checkGates('needs_you', { silver: { fpr: 0.5 }, gold: { precision: 0.9, recall: 0.8, n: 10 } }, prev).pass).toBe(true);
    expect(metrics.checkGates('spam', { gold: {} }, null)).toEqual({ pass: true, failures: [], baseline: true });
  });

  it('diff reports points for ratios and raw change for counts', () => {
    expect(metrics.diffMetrics({ precision: 0.8, n: 12, perClass: { people: { f1: 0.5 } } }, { precision: 0.75, n: 10, perClass: { people: { f1: 0.6 } } }))
      .toEqual({ precision: 5, n: 2, 'perClass.people.f1': -10 });
  });
});

describe('ask triples helpers', () => {
  it('a verifier quote must really occur in a source', () => {
    expect(quoteInSources('flight  leaves at 07:40', ['Your FLIGHT leaves at 07:40 from gate B'])).toBe(true);
    expect(quoteInSources('leaves at 08:40', ['Your flight leaves at 07:40'])).toBe(false);
    expect(quoteInSources('', ['anything'])).toBe(false);
  });
  it('maps short source ids and drops invented ones', () => {
    expect(mapSourceIds(['s2', 's9', 's2'], new Map([['s1', 'u1'], ['s2', 'u2']]))).toEqual(['u2']);
  });
});

// ── Runtime ─────────────────────────────────────────────────────────────────

describe('runtime', () => {
  it('normalises Reflex output by id or position', () => {
    const items = [{ id: 'm1' }, { id: 'm2' }];
    expect(runtime.normaliseReflex({ items: [{ id: 'm2', stream: 'reading', needs_you: false, spam: 'clean', confidence: 0.8 }] }, items))
      .toEqual([null, { id: 'm2', stream: 'reading', needs_you: false, spam: 'clean', confidence: 0.8, reason: null }]);
  });

  it('the local prompt path validates, retries once with the errors, and routes by X-Workflow', async () => {
    gw.install();
    gw.reset();
    _resetLlmState();
    const spec = (await import('../prompts/labels.question.js')).default;
    gw.on('labels.question', [{ nope: true }, { question: 'Did Acme need you?' }]);
    const { data, provenance } = await runtime.localRunPrompt(spec, { kind: 'needs_you', evidence: {}, options: [] }, { userId: USER });
    expect(data).toEqual({ question: 'Did Acme need you?' });
    expect(provenance).toMatchObject({ promptId: 'labels.question', model: QWEN, tier: 'reasoning' });
    expect(gw.callsFor('labels.question')).toHaveLength(2);
    expect(gw.callsFor('labels.question')[1].text).toMatch(/invalid/);
    gw.restore();
  });
});

// ── Judge end to end (B's registry + mock gateway) ───────────────────────────

describe('judgeForUser', () => {
  it('samples, asks both tiers, writes silver where they agree and queues a question where they do not', async () => {
    gw.install();
    gw.reset();
    _resetLlmState();
    runtime._resetRuntime();
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
    const labelInserts = [];
    const questionInserts = [];
    db.routes = [
      [/FROM account_aliases/, () => ({ rows: [{ user_id: USER, email: 'me@x.com' }] })],
      [/WITH mine AS .* vol AS/, () => ({ rows: [
        { id: ids[0], mid: '<1>', folder: 'INBOX', special_use: null, sender: 'priya@corp.com', date: at(0), sender_volume: 4 },
        { id: ids[1], mid: '<2>', folder: 'Junk', special_use: '\\Junk', sender: 'deals@shop.com', date: at(0), sender_volume: 1 },
      ] })],
      [/m\.attachments FROM messages m JOIN email_accounts/, () => ({ rows: [
        { id: ids[0], from_name: 'Priya', from_email: 'priya@corp.com', subject: 'Sign the visa form', to_addresses: [{ address: 'me@x.com' }], body_text: 'Please sign the form by Friday.' },
        { id: ids[1], from_name: 'Deals', from_email: 'deals@shop.com', subject: '50% off', to_addresses: [], body_text: 'Huge sale', list_unsubscribe: '<mailto:x>' },
      ] })],
      [/FROM users WHERE id/, () => ({ rows: [{ display_name: 'Sam' }] })],
      [/INSERT INTO hedwig_labels/, (p) => { labelInserts.push(p); return { rows: [], rowCount: p[1].length }; }],
      [/SELECT target_id, \(answered_at IS NULL/, () => ({ rows: [] })],
      [/WITH msg AS/, (p) => ({ rows: [{ id: p[1], mid: '<2>', subject: '50% off', from_name: 'Deals', sender: 'deals@shop.com', date: at(0), folder: 'Junk', in_spam: true, sender_count: 1, sender_first: at(0), sender_opened: 0, sender_replied: 0 }] })],
      [/INSERT INTO hedwig_questions/, (p) => { questionInserts.push(p); return { rows: [], rowCount: 1 }; }],
    ];
    gw.on('labels.judge', (req) => {
      expect(req.text).toContain('Sign the visa form');
      expect(req.text).toContain('the server put this in spam');
      return { items: [
        { id: 'm1', stream: 'people', needs_you: true, spam: 'clean', confidence: 0.92, rationale: 'Priya asks you to sign by Friday' },
        { id: 'm2', stream: 'reading', needs_you: false, spam: 'clean', confidence: 0.8, rationale: 'A sale newsletter you signed up for' },
      ] };
    });
    gw.on('sort.reflex', { items: [
      { id: 'm1', stream: 'people', bundle: '', needs_you: true, needs_you_reason: 'Sign the form', spam: 'clean', confidence: 0.9, reason: 'Priya writes to you', matches: [] },
      { id: 'm2', stream: 'reading', bundle: '', needs_you: false, needs_you_reason: '', spam: 'suspected', confidence: 0.7, reason: 'Bulk promotion', matches: [] },
    ] });
    gw.on('labels.question', { question: 'Deals sent you 50% off and it landed in spam. Junk, or real mail?' });

    const stats = await judgeForUser(USER, { day: '2026-09-23' });
    expect(stats).toMatchObject({ sampled: 2, judged: 2, candidates: 1, proposed: 1, partial: false, reflexPrompt: 'sort.reflex' });
    const suites = labelInserts[0][1];
    const targets = labelInserts[0][2];
    // m1: all three fields agree; m2: stream and needs-you agree, spam does not.
    expect(targets.filter((t) => t === ids[0])).toHaveLength(3);
    expect(suites.filter((s, i) => targets[i] === ids[1]).sort()).toEqual(['needs_you', 'sort']);
    expect(labelInserts[0][4].every((g) => g === 'silver')).toBe(true);
    expect(questionInserts[0][1]).toBe('spam');
    expect(questionInserts[0][2]).toBe(ids[1]);
    // "50" is in the evidence (the subject), so the model's wording is kept.
    expect(questionInserts[0][3]).toBe('Deals sent you 50% off and it landed in spam. Junk, or real mail?');
    expect(JSON.parse(questionInserts[0][4])).toMatchObject({ why: 'spam_disagree', inSpam: true, senderCount: 1, writtenBy: 'model' });
    expect(gw.callsFor('labels.judge')[0].model).toBe(QWEN);
    expect(gw.callsFor('sort.reflex')[0].model).toBe(GEMMA);
    gw.restore();
  });

  it('when Reflex only answers on its reasoning-tier retry (Qwen judging Qwen), nothing becomes silver', async () => {
    gw.install();
    gw.reset();
    _resetLlmState();
    runtime._resetRuntime();
    const id = 'aaaaaaaa-0000-4000-8000-000000000003';
    const labelInserts = [];
    db.routes = [
      [/FROM account_aliases/, () => ({ rows: [{ user_id: USER, email: 'me@x.com' }] })],
      [/WITH mine AS .* vol AS/, () => ({ rows: [{ id, mid: '<3>', folder: 'INBOX', special_use: null, sender: 'priya@corp.com', date: at(0), sender_volume: 4 }] })],
      [/m\.attachments FROM messages m JOIN email_accounts/, () => ({ rows: [
        { id, from_name: 'Priya', from_email: 'priya@corp.com', subject: 'Sign the visa form', to_addresses: [{ address: 'me@x.com' }], body_text: 'Please sign the form by Friday.' },
      ] })],
      [/FROM users WHERE id/, () => ({ rows: [{ display_name: 'Sam' }] })],
      [/INSERT INTO hedwig_labels/, (p) => { labelInserts.push(p); return { rows: [], rowCount: p[1].length }; }],
    ];
    gw.on('labels.judge', { items: [{ id: 'm1', stream: 'people', needs_you: true, spam: 'clean', confidence: 0.92, rationale: 'Priya asks you to sign' }] });
    // Gemma never gives valid JSON, so runPrompt's third attempt runs sort.reflex on Qwen.
    gw.on('sort.reflex', (req) => (req.model === GEMMA ? 'not json at all' : { items: [
      { id: 'm1', stream: 'people', bundle: '', needs_you: true, needs_you_reason: 'Sign it', spam: 'clean', confidence: 0.9, reason: 'Priya writes to you', matches: [] },
    ] }));
    gw.on('labels.question', { question: 'Does Priya need you?' });
    const stats = await judgeForUser(USER, { day: '2026-09-23', useModelForQuestions: false });
    expect(gw.callsFor('sort.reflex').map((c) => c.model)).toEqual([GEMMA, GEMMA, QWEN]);
    expect(stats).toMatchObject({ judged: 1, silver: 0, candidates: 3 });
    expect(labelInserts.flatMap((p) => p[1] || [])).toEqual([]);
    gw.restore();
  });
});
