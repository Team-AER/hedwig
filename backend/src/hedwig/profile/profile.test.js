import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

// ── Fake database: hedwig_profile, the evidence queries, and what runPrompt/enqueue touch ──────────
const USER = '11111111-1111-4111-8111-111111111111';
const db = {};
function resetDb() {
  Object.assign(db, {
    calls: [], profiles: [], aiId: 1, aiCalls: [], jobs: [], state: new Map(),
    replies: [], domains: [], ignored: [], archived: [], bundles: [], sent: [], rules: [], blocked: 0, corrections: [],
  });
}
resetDb();

async function fakeQuery(sql, params = []) {
  db.calls.push({ sql, params });
  if (/INSERT INTO hedwig_ai_calls/.test(sql)) { db.aiCalls.push(params); return { rows: [{ id: db.aiId++ }] }; }
  if (/FROM hedwig_ai_calls/.test(sql)) return { rows: [{ n: 0, tokens: 0 }] };
  if (/INSERT INTO hedwig_profile/.test(sql)) {
    const [userId, text, pinned, dismissed, lines, evidence, diff, source, provenance] = params;
    const mine = db.profiles.filter((p) => p.user_id === userId);
    const row = {
      user_id: userId, version: Math.max(0, ...mine.map((p) => p.version)) + 1, text, pinned: JSON.parse(pinned), dismissed: JSON.parse(dismissed),
      lines: JSON.parse(lines), evidence: JSON.parse(evidence), diff, source, provenance: provenance ? JSON.parse(provenance) : null, created_at: new Date(),
    };
    db.profiles.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (/FROM hedwig_profile WHERE user_id = \$1 ORDER BY version DESC LIMIT \$2/.test(sql)) {
    return { rows: db.profiles.filter((p) => p.user_id === params[0]).sort((a, b) => b.version - a.version).map((p) => ({ ...p, pinned: p.pinned.length, lines: p.text ? p.text.split('\n').length : null, model: p.provenance?.model, prompt_version: p.provenance?.promptVersion })) };
  }
  if (/FROM hedwig_profile WHERE user_id = \$1 ORDER BY version DESC LIMIT 1/.test(sql)) {
    const rows = db.profiles.filter((p) => p.user_id === params[0]).sort((a, b) => b.version - a.version).slice(0, 1);
    return { rows };
  }
  if (/SELECT 1 FROM hedwig_profile/.test(sql)) return { rows: db.profiles.filter((p) => p.user_id === params[0]).slice(0, 1) };
  // evidence
  if (/FROM email_accounts a WHERE a\.user_id = ANY/.test(sql)) return { rows: [{ user_id: USER, email: 'me@prafiles.example' }] };
  if (/evidence->>'rule' = 'reply'/.test(sql)) return { rows: db.replies };
  if (/FROM hedwig_sender_stats/.test(sql) && /GROUP BY domain/.test(sql)) return { rows: db.domains };
  if (/FROM hedwig_sender_stats/.test(sql) && /replied = 0/.test(sql)) return { rows: db.ignored };
  if (/'archive_unread'/.test(sql)) return { rows: db.archived };
  if (/FROM hedwig_sort s/.test(sql) && /s\.bundle/.test(sql)) return { rows: db.bundles };
  if (/SELECT m\.body_text, m\.body_html, m\.snippet/.test(sql)) return { rows: db.sent };
  if (/FROM hedwig_rules/.test(sql)) return { rows: db.rules };
  if (/decision = 'block'/.test(sql)) return { rows: [{ n: db.blocked }] };
  if (/FROM hedwig_corrections/.test(sql)) return { rows: db.corrections.filter((c) => c.kind === params[1]) };
  // jobs and state
  if (/INSERT INTO hedwig_jobs/.test(sql)) { db.jobs.push({ kind: params[0], payload: JSON.parse(params[1]), dedupe: params[3] }); return { rows: [{ id: db.jobs.length }] }; }
  if (/SELECT DISTINCT user_id FROM email_accounts/.test(sql)) return { rows: [{ user_id: USER }] };
  if (/FROM hedwig_state/.test(sql)) return { rows: db.state.has(params[0]) ? [{ value: db.state.get(params[0]) }] : [] };
  if (/INSERT INTO hedwig_state/.test(sql)) { db.state.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
  return { rows: [], rowCount: 0 };
}

vi.mock('../../services/db.js', () => ({ pool: {}, query: vi.fn((sql, params) => fakeQuery(sql, params)) }));
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

const service = await import('./service.js');
const lines = await import('./lines.js');
const { unifiedDiff } = await import('./diff.js');
const evidence = await import('./evidence.js');
const reflex = await import('../sort/reflex.js');
const reflexPrompt = (await import('../prompts/sort.reflex.js')).default;
const voice = await import('../work/voice.js');
const { _resetPrompts } = await import('../prompts/index.js');
const { _resetLlmState } = await import('../llm.js');

beforeEach(() => {
  resetDb();
  resetConfig();
  gw.reset().install();
  _resetLlmState();
  _resetPrompts({ keepFiles: true });
});
afterAll(() => gw.restore());

const PINNED = 'Never auto-archive anything from my accountant.';
const DISMISSED = 'You read every newsletter.';

function seedEvidence() {
  db.replies = [{ email: 'priya@acme.example', name: 'Priya Shah', replies: 12, median_hours: 2.6 }];
  db.ignored = [{ sender_email: 'deals@shop.example', received: 40, ignored: 38, replied: 0, opened: 1 }];
  db.sent = [
    { body_text: 'Hi Jo,\n\nSure, Thursday works.\n\nCheers,\nPrakhar' },
    { body_text: 'Hi Sam,\n\nSent it over this morning.\n\nCheers,\nPrakhar' },
    { body_text: 'Hi Priya,\n\nYes, I can sign it today.\n\nCheers,\nPrakhar' },
  ];
  db.corrections = [{ id: 7, kind: 'sort', target_id: 'm7', before: { stream: 'people' }, after: { stream: 'records', subject: 'Your Stripe receipt' }, note: 'Receipts are records, never people', created_at: new Date('2026-09-20T10:00:00Z') }];
}

function seedPrevious() {
  db.profiles.push({
    user_id: USER, version: 1, source: 'user', created_at: new Date('2026-09-01T10:00:00Z'), diff: '', provenance: null, evidence: [],
    text: `${PINNED}\nYou skim newsletters on weekends.`,
    lines: [{ text: PINNED, kind: 'preference', pinned: true, evidence: [] }, { text: 'You skim newsletters on weekends.', kind: 'reading', pinned: false, evidence: [] }],
    pinned: [PINNED], dismissed: [DISMISSED],
  });
}

const modelLines = (req) => {
  // Facts are numbered in order: f1 Priya replies, f2 deals@ ignored, then writing facts.
  const text = req.messages[1].content;
  const greeting = /- (f\d+) \[writing\]: You open with "Hi"/.exec(text)?.[1];
  const signoff = /- (f\d+) \[writing\]: You sign off with "Cheers"/.exec(text)?.[1];
  return {
    lines: [
      { kind: 'people', text: 'You reply to Priya Shah quickly, usually within 3 hours.', evidence: ['f1'] },
      { kind: 'people', text: 'You replied to Priya 15 times.', evidence: ['f1'] },
      { kind: 'ignore', text: 'You leave deals@shop.example unread: 38 of 40 messages.', evidence: ['f2'] },
      { kind: 'writing', text: 'You write short notes that open with "Hi" and close with "Cheers".', evidence: [greeting, signoff] },
      { kind: 'writing', text: 'Your replies average 120 words.', evidence: [] },
      { kind: 'preference', text: PINNED, evidence: [] },
      { kind: 'reading', text: DISMISSED, evidence: [] },
      { kind: 'people', text: 'Mail from acme.example matters: 5 of 9 answered.', evidence: ['f99'] },
    ],
  };
};

describe('profile lines (pure)', () => {
  it('keeps grounded lines and drops invented numbers, unknown citations, pinned repeats and dismissed lines', () => {
    const facts = [{ id: 'f1', kind: 'people', statement: 'You replied to Priya 12 times in the last 90 days, usually within 3 hours.', numbers: { replies: 12, typicalHours: 3, days: 90 } }];
    const { kept, dropped } = lines.validateLines([
      { kind: 'people', text: 'You answer Priya within 3 hours.', evidence: ['f1'] },
      { kind: 'people', text: 'You answered Priya 14 times.', evidence: ['f1'] },
      { kind: 'people', text: 'You answered Priya 12 times.', evidence: [] },
      { kind: 'people', text: 'You like the user\'s friends.', evidence: [] },
      { kind: 'mood', text: 'You are busy.', evidence: [] },
      { kind: 'preference', text: 'keep it SHORT', evidence: [] },
    ], facts, { pinned: ['Keep it short.'], dismissed: [] });
    expect(kept.map((l) => l.text)).toEqual(['You answer Priya within 3 hours.', 'You like your friends.']);
    expect(dropped.map((d) => d.reason)).toEqual([
      'numbers not in the cited evidence: 14', 'numbers not in the cited evidence: 12', 'unknown kind', 'repeats a pinned or dismissed line',
    ]);
  });

  it('a user edit pins new and changed lines, keeps untouched generated lines unpinned and dismisses deleted ones', () => {
    const prev = {
      text: 'You reply to Priya quickly.\nYou skip deals@shop.example.\nYou sign off with Cheers.',
      lines: [
        { text: 'You reply to Priya quickly.', kind: 'people', pinned: false, evidence: ['f1'] },
        { text: 'You skip deals@shop.example.', kind: 'ignore', pinned: false, evidence: ['f2'] },
        { text: 'You sign off with Cheers.', kind: 'writing', pinned: false, evidence: ['f3'] },
      ],
      pinned: [],
      dismissed: [],
    };
    const edit = lines.applyUserEdit(prev, '- You reply to Priya quickly.\nYou sign off with "Best".\nMy accountant always matters.\n');
    expect(edit.lines).toEqual([
      { text: 'You reply to Priya quickly.', kind: 'people', pinned: false, evidence: ['f1'] },
      { text: 'You sign off with "Best".', kind: 'preference', pinned: true, evidence: [] },
      { text: 'My accountant always matters.', kind: 'preference', pinned: true, evidence: [] },
    ]);
    expect(edit.pinned).toEqual(['You sign off with "Best".', 'My accountant always matters.']);
    expect(edit.dismissed).toEqual(['You skip deals@shop.example.', 'You sign off with Cheers.']);
    expect(() => lines.applyUserEdit(prev, Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n'), { max: 5 })).toThrow(/at most 5 lines/);
  });

  it('composes pinned lines first, verbatim, then generated lines by kind within the limit', () => {
    const out = lines.composeLines({
      pinned: ['Mine, exactly as I wrote it '],
      generated: [
        { text: 'You write short.', kind: 'writing', evidence: ['f3'] },
        { text: 'You reply to Priya.', kind: 'people', evidence: ['f1'] },
        { text: 'mine, exactly as I wrote it', kind: 'preference', evidence: [] },
        { text: 'You skip deals.', kind: 'ignore', evidence: ['f2'] },
      ],
      max: 3,
    });
    expect(out.map((l) => [l.text, l.pinned])).toEqual([['Mine, exactly as I wrote it', true], ['You reply to Priya.', false], ['You skip deals.', false]]);
  });

  it('writes a unified diff', () => {
    expect(unifiedDiff('a\nb\nc', 'a\nB\nc\nd', { from: 'v1', to: 'v2' })).toBe('--- v1\n+++ v2\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n');
    expect(unifiedDiff('', 'x', { from: 'v0', to: 'v1' })).toBe('--- v0\n+++ v1\n@@ -0,0 +1,1 @@\n+x\n');
    expect(unifiedDiff('same', 'same')).toBe('');
  });

  it('builds facts with the counts SQL returned, never more', () => {
    const w = evidence.writingFacts([
      { text: 'Hi Jo,\n\nThursday works.\n\nCheers,\nP' }, { text: 'Hi Sam,\n\nDone.\n\nCheers,\nP' }, { text: 'Thanks, that works.' },
    ], { days: 90, minCount: 2 });
    expect(w.facts.map((f) => f.statement)).toEqual([
      'Your last 3 sent messages in 90 days: a median of 5 words; 3 of 3 were 50 words or fewer.',
      'You open with "Hi" in 2 of 3 messages.',
      'You sign off with "Cheers" in 2 of 3 messages.',
    ]);
    expect(evidence.bundleFacts([{ bundle: 'deals', name: 'Deals', total: 20, unread: 18 }, { bundle: 'news', name: 'News', total: 10, unread: 1 }, { bundle: 'mid', total: 10, unread: 5 }], { days: 90 }))
      .toEqual([
        { kind: 'ignore', statement: 'Deals: 18 of 20 messages in the last 90 days left unread.', numbers: { unread: 18, total: 20, days: 90 }, subject: 'bundle:deals' },
        { kind: 'reading', statement: 'News: you opened 9 of 10 messages in the last 90 days.', numbers: { opened: 9, total: 10, days: 90 }, subject: 'bundle:news' },
      ]);
    expect(evidence.numberFacts([[{ a: 1 }], [{ b: 2 }]]).map((f) => f.id)).toEqual(['f1', 'f2']);
  });
});

describe('profile rebuild', () => {
  it('keeps pinned lines verbatim, drops lines with invented numbers, stores the diff and provenance', async () => {
    seedEvidence();
    seedPrevious();
    gw.on('profile.rebuild', modelLines);
    const out = await service.rebuildProfile(USER);
    expect(out).toMatchObject({ status: 'done', version: 2 });

    const call = gw.callsFor('profile.rebuild')[0];
    expect(call.model).toBe(QWEN); // reasoning tier
    expect(call.text).toContain('f1 [people]: You replied to Priya Shah <priya@acme.example> 12 times in the last 90 days, usually within 3 hours.');
    expect(call.text).toContain(`- ${PINNED}`);
    expect(call.text).toContain(`- ${DISMISSED}`);
    expect(call.text).toContain('You wrote about "Your Stripe receipt": "Receipts are records, never people"');

    const v2 = db.profiles.find((p) => p.version === 2);
    expect(v2.source).toBe('rebuild');
    expect(v2.text.split('\n')).toEqual([
      PINNED,
      'You reply to Priya Shah quickly, usually within 3 hours.',
      'You leave deals@shop.example unread: 38 of 40 messages.',
      'You write short notes that open with "Hi" and close with "Cheers".',
    ]);
    expect(v2.pinned).toEqual([PINNED]);
    expect(v2.dismissed).toEqual([DISMISSED]);
    expect(v2.lines[0]).toEqual({ text: PINNED, kind: 'preference', pinned: true, evidence: [] });
    expect(v2.lines[1]).toMatchObject({ kind: 'people', pinned: false, evidence: ['f1'] });
    expect(v2.evidence.map((f) => f.id)).toEqual(expect.arrayContaining(['f1', 'f2']));
    expect(v2.diff).toContain('--- v1\n+++ v2 (rebuild)\n');
    expect(v2.diff).toContain(` ${PINNED}\n`);
    expect(v2.diff).toContain('-You skim newsletters on weekends.\n');
    expect(v2.diff).toContain('+You reply to Priya Shah quickly, usually within 3 hours.\n');
    expect(v2.provenance).toMatchObject({ promptId: 'profile.rebuild', model: QWEN, tier: 'reasoning', aiCallId: 1 });
    expect(v2.provenance.droppedLines.map((d) => d.text)).toEqual([
      'You replied to Priya 15 times.', 'Your replies average 120 words.', PINNED, DISMISSED, 'Mail from acme.example matters: 5 of 9 answered.',
    ]);
    // Charged to the profile budget.
    expect(db.aiCalls[0][1]).toBe('profile');

    // Same evidence, same answer: no new version.
    const again = await service.rebuildProfile(USER);
    expect(again).toMatchObject({ status: 'done', version: 2, note: 'unchanged' });
    expect(db.profiles).toHaveLength(2);
  });

  it('a user edit pins their lines and the next rebuild keeps them and never brings back a deleted line', async () => {
    seedEvidence();
    gw.on('profile.rebuild', modelLines);
    await service.rebuildProfile(USER);
    const v1 = await service.getProfile(USER);
    expect(v1.version).toBe(1);
    const edited = v1.text.replace('You leave deals@shop.example unread: 38 of 40 messages.\n', '') + '\nKeep replies under five lines.';
    const v2 = await service.saveProfileEdit(USER, { text: edited });
    expect(v2).toMatchObject({ version: 2, source: 'user', pinned: ['Keep replies under five lines.'] });
    expect(v2.dismissed).toEqual(['You leave deals@shop.example unread: 38 of 40 messages.']);
    expect(v2.diff).toContain('-You leave deals@shop.example unread: 38 of 40 messages.\n');
    expect(v2.diff).toContain('+Keep replies under five lines.\n');
    expect((await service.saveProfileEdit(USER, { text: edited })).unchanged).toBe(true);

    await service.rebuildProfile(USER);
    const v3 = await service.getProfile(USER);
    expect(v3.version).toBe(3);
    expect(v3.text.split('\n')[0]).toBe('Keep replies under five lines.');
    expect(v3.text).not.toContain('deals@shop.example');
    expect(v3.provenance.droppedLines.some((d) => d.text.startsWith('You leave deals@') && d.reason === 'repeats a pinned or dismissed line')).toBe(true);
    const hist = await service.profileHistory(USER);
    expect(hist.versions.map((v) => [v.version, v.source])).toEqual([[3, 'rebuild'], [2, 'user'], [1, 'rebuild']]);

    // What drafting and Reflex read.
    expect(await voice.profileLines(USER)).toEqual(v3.text.split('\n'));
    cfg['profile.inPrompts'] = false;
    expect(await voice.profileLines(USER)).toEqual([]);
  });

  it('honours routing.profile.tier and the profile token budget', async () => {
    seedEvidence();
    gw.on('profile.rebuild', modelLines);
    resetConfig({ 'routing.profile.tier': 'reflex' });
    await service.rebuildProfile(USER);
    expect(gw.callsFor('profile.rebuild')[0].model).toBe(GEMMA);
    expect(db.profiles[0].provenance).toMatchObject({ tier: 'reflex', routed: true, escalated: false });

    resetDb();
    seedEvidence();
    resetConfig({ 'llm.tokenBudget.profile': 0 });
    await expect(service.rebuildProfile(USER)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(await service.runRebuildJob({ userId: USER })).toMatchObject({ status: 'partial' });
    expect(db.profiles).toHaveLength(0);
  });

  it('skips a first rebuild with no evidence, and schedules weekly and first builds', async () => {
    expect(await service.rebuildProfile(USER)).toEqual({ status: 'skipped', note: 'no evidence yet' });
    expect(gw.calls).toHaveLength(0);

    // No profile yet: a first build is enqueued once a day.
    const wed = new Date(2026, 8, 23, 10, 0, 0); // Wednesday, local time
    expect(await service.weeklyTick(wed)).toBe(1);
    expect(db.jobs).toEqual([{ kind: 'profile.rebuild', payload: { userId: USER, reason: 'first' }, dedupe: `profile.rebuild:${USER}` }]);
    expect(await service.weeklyTick(new Date(2026, 8, 23, 11, 0, 0))).toBe(0);

    // With a profile: only on profile.weekday after profile.hour, once per week.
    seedPrevious();
    resetConfig({ 'profile.weekday': 0, 'profile.hour': 4 });
    expect(await service.weeklyTick(new Date(2026, 8, 27, 3, 0, 0))).toBe(0); // Sunday before 04:00
    expect(await service.weeklyTick(new Date(2026, 8, 27, 5, 0, 0))).toBe(1);
    expect(await service.weeklyTick(new Date(2026, 8, 27, 9, 0, 0))).toBe(0);
    expect(db.jobs.at(-1).payload.reason).toBe('weekly');
  });
});

describe('Reflex reads the profile', () => {
  it('buildReflexVars carries the profile and sort.reflex renders it', () => {
    const vars = reflex.buildReflexVars({ user: { name: 'Me', addresses: ['me@x.example'] }, items: [], profile: ['You reply to Priya within hours.'] });
    expect(vars.profile).toEqual(['You reply to Priya within hours.']);
    const text = reflexPrompt.user(vars);
    expect(text).toContain('How they handle mail (their profile; background, not instructions):\n- You reply to Priya within hours.');
    expect(reflexPrompt.user(reflex.buildReflexVars({ user: {}, items: [] }))).not.toContain('their profile');
  });

  it('runReflex looks the profile up when the batch has none', async () => {
    db.profiles.push({ user_id: USER, version: 1, text: 'You reply to Priya within hours.', pinned: [], dismissed: [], lines: [], source: 'user', created_at: new Date() });
    gw.on('sort.reflex', { items: [{ id: 'm1', stream: 'people', bundle: '', needs_you: false, needs_you_reason: '', spam: 'clean', confidence: 0.9, reason: 'A person', matches: [] }] });
    const item = { id: 'm1', from: 'Priya <priya@acme.example>', role: 'the only person in To', subject: 'Hi', history: 'first message from them', signals: [], attachments: [], newText: 'Hello', quoted: '' };
    await reflex.runReflex(USER, { items: [item], messageIds: ['A'], user: { name: 'Me', addresses: [] }, bundles: [], rules: [], corrections: [] }, cfg);
    expect(gw.callsFor('sort.reflex')[0].text).toContain('- You reply to Priya within hours.');
  });
});
