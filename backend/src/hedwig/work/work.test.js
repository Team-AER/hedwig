import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

// ── Fake database: just enough of hedwig_work_items, hedwig_work_stories and the thread reads ──
const USER = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const clock = { now: new Date('2026-09-23T12:00:00Z') };
const db = { calls: [], items: [], stories: new Map(), thread: [], sent: [], parts: null, attach: [], commitments: [], nextId: 1, aiId: 1, jobs: [], tldr: new Map(), failures: [], needs: [] };

function resetDb() {
  Object.assign(db, { calls: [], items: [], stories: new Map(), thread: [], sent: [], parts: null, attach: [], commitments: [], nextId: 1, aiId: 1, jobs: [], tldr: new Map(), failures: [], needs: [] });
}

const openItems = (userId) => db.items.filter((i) => i.user_id === userId && !i.done_at);

async function fakeQuery(sql, params = []) {
  db.calls.push({ sql, params });
  const now = clock.now;
  if (/INSERT INTO hedwig_ai_calls/.test(sql)) return { rows: [{ id: db.aiId++ }] };
  if (/FROM hedwig_ai_calls/.test(sql)) return { rows: [{ n: 0, tokens: 0 }] };
  if (/lower\(a\.email_address\)/.test(sql)) return { rows: [{ user_id: USER, email: 'me@prafiles.example' }] };
  if (/AS name/.test(sql) && /display_name/.test(sql)) return { rows: [{ name: 'Prakhar' }] };
  if (/to_regclass/.test(sql)) return { rows: [{ t: null }] };

  // Eager summaries, TL;DRs, derived needs, jobs
  if (/INSERT INTO hedwig_jobs/.test(sql)) {
    if (db.jobs.some((j) => j.dedupeKey && j.dedupeKey === params[3])) return { rows: [] };
    db.jobs.push({ kind: params[0], payload: JSON.parse(params[1]), userId: params[2], dedupeKey: params[3] });
    return { rows: [{ id: db.jobs.length }] };
  }
  if (/INSERT INTO hedwig_work_tldr/.test(sql)) {
    const [messageId, , text, promptId, promptVersion, model, aiCallId, tier, error] = params;
    const old = db.tldr.get(messageId);
    db.tldr.set(messageId, text ? { text, promptId, promptVersion, model, aiCallId, tier, error: null } : { ...(old || { text: null }), error });
    return { rows: [], rowCount: 1 };
  }
  if (/JOIN hedwig_work_tldr x/.test(sql)) {
    return { rows: params[1].filter((id) => db.tldr.get(id)?.text).map((id) => {
      const t = db.tldr.get(id);
      return { id, text: t.text, model: t.model, tier: t.tier, lighter: false, prompt_id: t.promptId, prompt_version: t.promptVersion, ai_call_id: t.aiCallId, updated_at: now };
    }) };
  }
  if (/FROM hedwig_work_needs/.test(sql)) return { rows: db.needs.filter((n) => params[1].includes(n.thread_key)) };
  if (/INSERT INTO hedwig_work_stories/.test(sql) && /"story":null/.test(sql)) {
    db.failures.push({ threadKey: params[1], count: params[3], error: params[5] });
    return { rows: [], rowCount: 1 };
  }

  // hedwig_work_items
  if (/UPDATE hedwig_work_items SET done_at = NOW\(\), done_reason = 'done'/.test(sql)) {
    const [userId, keys, kinds] = params;
    let n = 0;
    for (const i of openItems(userId)) if (keys.includes(i.thread_key) && kinds.includes(i.kind)) { i.done_at = now; i.done_reason = 'done'; n++; }
    return { rows: [], rowCount: n };
  }
  if (/INSERT INTO hedwig_work_items \(user_id, thread_key, kind, note, anchor_message_id\)/.test(sql)) {
    const [userId, keys, note] = params;
    for (const k of keys) {
      const cur = openItems(userId).find((i) => i.kind === 'done' && i.thread_key === k);
      if (cur) { cur.created_at = now; cur.note = note ?? cur.note; } else db.items.push({ id: db.nextId++, user_id: userId, thread_key: k, kind: 'done', note, created_at: now, done_at: null, position: 0 });
    }
    return { rows: [], rowCount: keys.length };
  }
  if (/INSERT INTO hedwig_work_items \(user_id, thread_key, kind, note, until, position, anchor_message_id\)/.test(sql)) {
    const [userId, key, kind, note, until, position] = params;
    let cur = openItems(userId).find((i) => i.kind === kind && i.thread_key === key);
    if (!cur) { cur = { id: db.nextId++, user_id: userId, thread_key: key, kind, note, until, position: position ?? 1, created_at: now, done_at: null }; db.items.push(cur); }
    return { rows: [cur], rowCount: 1 };
  }
  if (/done_reason = 'new_mail'/.test(sql)) {
    const [userId, keys, dates] = params;
    let n = 0;
    keys.forEach((k, idx) => {
      for (const i of openItems(userId)) if (i.kind === 'done' && i.thread_key === k && dates[idx] > i.created_at) { i.done_at = now; i.done_reason = 'new_mail'; n++; }
    });
    return { rows: [], rowCount: n };
  }
  if (/UPDATE hedwig_work_items w SET done_at = NOW\(\), done_reason = 'replied'/.test(sql)) {
    const [userId, keys, dates] = params;
    keys.forEach((k, idx) => {
      for (const i of openItems(userId)) if (i.kind === 'reply_later' && i.thread_key === k && dates[idx] > i.created_at) { i.done_at = now; i.done_reason = 'replied'; }
    });
    return { rows: [], rowCount: 0 };
  }
  if (/done_reason = 'user'/.test(sql) && /kind = \$2 AND thread_key = \$3/.test(sql)) {
    const [userId, kind, key] = params;
    const hit = openItems(userId).filter((i) => i.kind === kind && i.thread_key === key);
    for (const i of hit) { i.done_at = now; i.done_reason = 'user'; }
    return { rows: [], rowCount: hit.length };
  }
  if (/SELECT kind, COUNT\(\*\)/.test(sql)) {
    const counts = {};
    for (const i of openItems(params[0])) counts[i.kind] = (counts[i.kind] || 0) + 1;
    return { rows: Object.entries(counts).map(([kind, n]) => ({ kind, n })) };
  }
  if (/UPDATE hedwig_work_waiting/.test(sql)) return { rows: [], rowCount: 0 };
  if (/FROM hedwig_work_items/.test(sql) && /kind = 'reminder'/.test(sql)) {
    return { rows: openItems(params[0]).filter((i) => i.kind === 'reminder' && (!i.until || i.until <= params[1])) };
  }
  if (/FROM hedwig_work_items/.test(sql) && /kind = 'snoozed'/.test(sql)) {
    const [userId, keys, at, hours] = params;
    return { rows: openItems(userId).filter((i) => i.kind === 'snoozed' && keys.includes(i.thread_key) && i.until <= at && i.until > new Date(at.getTime() - hours * 3600_000)) };
  }

  // Threads
  if (/DISTINCT ON \(m\.thread_key\)/.test(sql)) {
    const keys = params[1];
    const latest = new Map();
    for (const m of db.thread) if (keys.includes(m.thread_key) && (!latest.get(m.thread_key) || m.date > latest.get(m.thread_key).date)) latest.set(m.thread_key, m);
    return { rows: [...latest.values()] };
  }
  if (/DISTINCT ON \(COALESCE\(m\.message_id, m\.id::text\)\)/.test(sql)) {
    return { rows: db.thread.filter((m) => m.thread_key === params[1]).map((m) => ({ ...m })) };
  }
  if (/FROM hedwig_commitments/.test(sql)) return { rows: db.commitments };
  if (/SELECT \* FROM hedwig_work_stories/.test(sql)) {
    const s = db.stories.get(`${params[0]}|${params[1]}`);
    return { rows: s ? [JSON.parse(JSON.stringify(s))] : [] };
  }
  if (/INSERT INTO hedwig_work_stories/.test(sql)) {
    const [userId, key, upTo, count, story, provenance, promptId, promptVersion, model, aiCallId, tier, lighter, source] = params;
    db.stories.set(`${userId}|${key}`, {
      user_id: userId, thread_key: key, up_to_message_id: upTo, message_count: count, story: JSON.parse(story), provenance: JSON.parse(provenance),
      prompt_id: promptId, prompt_version: promptVersion, model, ai_call_id: aiCallId, tier, lighter, source, error: null,
    });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE hedwig_work_stories/.test(sql)) {
    const s = db.stories.get(`${params[0]}|${params[1]}`);
    if (s) { s.story = JSON.parse(params[2]); s.provenance = JSON.parse(params[3]); }
    return { rows: [], rowCount: s ? 1 : 0 };
  }
  if (/jsonb_array_elements\(m\.to_addresses\)/.test(sql)) return { rows: db.sent };
  if (/SELECT m\.id, m\.body_text, m\.body_html, m\.snippet, m\.attachments/.test(sql)) return { rows: db.parts ? [db.parts] : [] };
  if (/FROM hedwig_attachment_text/.test(sql)) return { rows: db.attach };
  return { rows: [], rowCount: 0 };
}

vi.mock('../../services/db.js', () => ({ pool: {}, query: vi.fn((sql, params) => fakeQuery(sql, params)) }));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
const hookResults = { beforeSend: [] };
vi.mock('../hooks.js', () => ({
  HEDWIG_HOOKS: { beforeSend: 'hedwig.beforeSend', onMessageIndexed: 'hedwig.onMessageIndexed', afterSort: 'hedwig.afterSort' },
  runHedwigHook: vi.fn(async () => []),
  collectHedwigHook: vi.fn(async (name) => (name === 'hedwig.beforeSend' ? hookResults.beforeSend : [])),
}));

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
    ...DEFAULTS, 'llm.baseUrl': gw.baseUrl, 'llm.catalogUrl': gw.catalogUrl, 'llm.probe.enabled': false, 'llm.models.fast': GEMMA, 'llm.models.long': QWEN,
    'llm.fallbackModel': '', 'llm.timeoutMs': 5000, 'insights.timezone': 'Europe/London', ...over,
  };
}
resetConfig();

const lists = await import('./lists.js');
const thread = await import('./thread.js');
const summaries = await import('./summaries.js');
const needsMod = await import('./needs.js');
const draftMod = await import('./draft.js');
const guard = await import('./sendguard.js');
const voice = await import('./voice.js');
const { _resetPrompts } = await import('../prompts/index.js');
const { _resetLlmState } = await import('../llm.js');

const at = (iso) => new Date(iso);
function message(over = {}) {
  return {
    id: over.id, account_id: ACC, folder: 'INBOX', message_id: `<${over.id}@x>`, subject: 'Q3 report', from_name: 'Anna Berg',
    from_email: 'anna@northwind.example', to_addresses: [{ name: '', address: 'me@prafiles.example' }], cc_addresses: [],
    date: at('2026-09-20T10:00:00Z'), snippet: '', body_text: '', body_html: null, is_read: true, has_attachments: false, attachments: [],
    in_reply_to: null, thread_key: 't-anna', list_unsubscribe: null, is_bulk: false, special_use: null, ...over,
  };
}
const ANNA = [
  message({ id: 'a1', body_text: 'Here is the first draft of the Q3 report. Numbers are provisional.', date: at('2026-09-16T10:00:00Z'), attachments: [{ filename: 'q3-draft.pdf' }], has_attachments: true }),
  message({ id: 'a2', mine: true, from_name: 'Prakhar', from_email: 'me@prafiles.example', to_addresses: [{ address: 'anna@northwind.example' }], body_text: 'Hi Anna,\n\nTwo revenue lines look off on page 4.\n\nThanks,\nPrakhar', date: at('2026-09-16T15:00:00Z') }),
  message({ id: 'a3', body_text: 'Corrected both lines, new version attached.', date: at('2026-09-21T09:00:00Z'), is_read: false }),
  message({ id: 'a4', body_text: 'Could you send the final Q3 numbers by Thursday evening? The board pack prints Friday.', date: at('2026-09-23T09:40:00Z'), is_read: false }),
];

beforeEach(() => {
  resetDb();
  resetConfig();
  hookResults.beforeSend = [];
  gw.reset().install();
  _resetLlmState();
  _resetPrompts({ keepFiles: true });
  thread._resetThreadState();
  clock.now = new Date('2026-09-23T12:00:00Z');
});
afterAll(() => gw.restore());

// ── Lists ───────────────────────────────────────────────────────────────────

describe('lists state machine', () => {
  it('normalises list names, including the frontend camelCase ones', () => {
    expect(lists.normalizeKind('replyLater')).toBe('reply_later');
    expect(lists.normalizeKind('set-aside')).toBe('set_aside');
    expect(lists.normalizeKind('done')).toBe('done');
    expect(() => lists.normalizeKind('archive')).toThrow(/list must be one of/);
  });

  it('done closes Reply Later, hides nothing new, and comes back when someone writes after it', async () => {
    db.thread = [...ANNA];
    await lists.addItem(USER, 'reply_later', { threadId: 't-anna', note: 'numbers' });
    await lists.addItem(USER, 'pin', { threadId: 't-anna' });
    expect(await lists.listCounts(USER)).toMatchObject({ reply_later: 1, pin: 1, done: 0, replyLater: 1 });

    clock.now = new Date('2026-09-23T13:00:00Z');
    await lists.addItem(USER, 'done', { threadId: 't-anna' });
    let counts = await lists.listCounts(USER);
    expect(counts).toMatchObject({ reply_later: 0, pin: 1, done: 1 });
    expect(db.items.find((i) => i.kind === 'reply_later').done_reason).toBe('done');

    // A message dated before the thread was marked done (late sync) does not re-open it.
    clock.now = new Date('2026-09-23T14:00:00Z');
    await lists.applyMail([{ user_id: USER, thread_key: 't-anna', date: at('2026-09-23T12:30:00Z'), is_outgoing: false }]);
    expect((await lists.listCounts(USER)).done).toBe(1);
    // The owner's own message never re-opens it either.
    await lists.applyMail([{ user_id: USER, thread_key: 't-anna', date: at('2026-09-23T13:30:00Z'), is_outgoing: true }]);
    expect((await lists.listCounts(USER)).done).toBe(1);
    // New mail from Anna does.
    const res = await lists.applyMail([{ user_id: USER, thread_key: 't-anna', date: at('2026-09-23T13:45:00Z'), is_outgoing: false }]);
    expect(res.reopened).toBe(1);
    counts = await lists.listCounts(USER);
    expect(counts.done).toBe(0);
    expect(db.items.find((i) => i.kind === 'done').done_reason).toBe('new_mail');
  });

  it('the owner replying closes Reply Later; undoing done brings the thread back', async () => {
    db.thread = [...ANNA];
    clock.now = new Date('2026-09-23T13:00:00Z');
    await lists.addItem(USER, 'reply_later', { threadId: 't-anna' });
    await lists.applyMail([{ user_id: USER, thread_key: 't-anna', date: at('2026-09-23T12:59:00Z'), is_outgoing: true }]);
    expect((await lists.listCounts(USER)).reply_later).toBe(1); // written before it was added
    await lists.applyMail([{ user_id: USER, thread_key: 't-anna', date: at('2026-09-23T13:10:00Z'), is_outgoing: true }]);
    expect((await lists.listCounts(USER)).reply_later).toBe(0);

    await lists.addItem(USER, 'done', { threadId: 't-anna' });
    await lists.removeItem(USER, 'done', 't-anna');
    expect((await lists.listCounts(USER)).done).toBe(0);
    await expect(lists.removeItem(USER, 'done', 't-anna')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses unknown threads and threadless items other than reminders', async () => {
    await expect(lists.addItem(USER, 'reply_later', { threadId: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(lists.addItem(USER, 'reply_later', {})).rejects.toMatchObject({ status: 400 });
    await expect(lists.addItem(USER, 'reminder', { text: 'Call the dentist' })).rejects.toMatchObject({ status: 400 });
    await expect(lists.addItem(USER, 'snoozed', { threadId: 't-anna' })).rejects.toMatchObject({ status: 400 });
  });

  it('People SQL hides done threads only up to when they were marked, and snoozed ones', () => {
    const sql = lists.peopleFilterSql('m', 's');
    expect(sql).toMatch(/w\.kind = 'done' AND \(m\.date IS NULL OR m\.date <= w\.created_at\)/);
    expect(sql).toMatch(/w\.kind = 'snoozed' AND w\.until > NOW\(\)/);
    expect(sql).toMatch(/<> 'Snoozed'/);
    expect(sql).toMatch(/w\.user_id = s\.user_id/);
  });

  it('adds due reminders as synthetic People rows and marks threads back from snooze', async () => {
    db.thread = [...ANNA, message({ id: 'b1', thread_key: 't-boiler', subject: 'Boiler', from_email: 'sam@lettings.example', date: at('2026-09-22T09:00:00Z') })];
    db.items.push(
      { id: 90, user_id: USER, thread_key: null, kind: 'reminder', note: 'Call the dentist', until: at('2026-09-23T07:00:00Z'), created_at: at('2026-09-22T07:00:00Z'), done_at: null },
      { id: 91, user_id: USER, thread_key: null, kind: 'reminder', note: 'Later', until: at('2026-09-24T07:00:00Z'), created_at: at('2026-09-22T07:00:00Z'), done_at: null },
      { id: 92, user_id: USER, thread_key: 't-anna', kind: 'reminder', note: 'numbers', until: at('2026-09-23T08:00:00Z'), created_at: at('2026-09-22T07:00:00Z'), done_at: null },
      { id: 93, user_id: USER, thread_key: 't-boiler', kind: 'snoozed', until: at('2026-09-23T08:00:00Z'), created_at: at('2026-09-22T07:00:00Z'), done_at: null },
    );
    const page = [
      { threadId: 't-boiler', messageId: 'b1', reason: 'Sam asks', needsYou: false },
      { threadId: 't-anna', messageId: 'a4', reason: 'Anna asks', needsYou: true },
    ];
    const out = await lists.withWorkRows(USER, page, { first: true, now: clock.now });
    expect(out.map((i) => i.threadId)).toEqual(['reminder:90', 't-anna', 't-boiler']);
    expect(out[0]).toMatchObject({ synthetic: true, subject: 'Call the dentist', messageId: null, needsYou: true });
    expect(out[1]).toMatchObject({ reason: 'Reminder: numbers', reminderId: 92, messageId: 'a4' });
    expect(out[2]).toMatchObject({ reason: 'Back from snooze', needsYou: true });
    // Later pages carry no synthetic rows.
    const later = await lists.withWorkRows(USER, page.slice(1), { first: false, now: clock.now });
    expect(later).toHaveLength(1);
  });

  it('snooze defaults to tomorrow at the configured hour in the user zone', () => {
    const until = lists.defaultSnoozeUntil({ ...cfg, 'work.snoozeDefaultDays': 1, 'work.snoozeDefaultHour': 8 }, new Date('2026-09-23T22:30:00Z'));
    expect(until.toISOString()).toBe('2026-09-24T07:00:00.000Z'); // 23:30 BST on the 23rd → 08:00 BST on the 24th
  });
});

// ── Story ───────────────────────────────────────────────────────────────────

// work.summarise replies with one entry per item; a thread opened alone is item t1.
const story = ({ sentences, timeline, tldr = 'Anna waits on your numbers' }) => ({ items: [{ id: 't1', tldr, sentences, timeline }] });

describe('thread story', () => {
  const ids = ['a1', 'a2', 'a3', 'a4'];

  it('maps sentence citations to message ids, renumbering in order of use and dropping uncited sentences', () => {
    const story = thread.assembleStory({
      sentences: [
        { text: 'Anna corrected both revenue lines on Monday.', cites: [3] },
        { text: 'She needs your final numbers by Thursday evening [9].', cites: [4, 3, 7] },
        { text: 'This sentence cites nothing real.', cites: [0, 12] },
      ],
    }, ids);
    expect(story).toEqual({
      text: 'Anna corrected both revenue lines on Monday [1]. She needs your final numbers by Thursday evening [2][1].',
      citations: [{ n: 1, messageId: 'a3' }, { n: 2, messageId: 'a4' }],
    });
    expect(thread.assembleStory({ sentences: [{ text: 'Nothing cited.', cites: [] }] }, ids)).toBeNull();
  });

  it('knows what is new since the owner last looked, within the story window', () => {
    expect(thread.sinceIndex(ANNA)).toBe(2); // a2 is theirs, a3 and a4 unread
    expect(thread.sinceIndex(ANNA.map((m) => ({ ...m, is_read: true })))).toBe(-1);
    const { vars, window } = thread.buildStoryVars({ messages: ANNA, owner: { name: 'Prakhar', addresses: [] }, subject: 'Q3', today: 'today', max: 3 });
    expect(window.map((m) => m.id)).toEqual(['a2', 'a3', 'a4']);
    expect(vars.sinceN).toBe(2);
    expect(vars.messages[0]).toMatchObject({ n: 1, mine: true });
  });

  it('fills timeline gaps with heuristics: asks, attachments, decisions', () => {
    const tl = thread.assembleTimeline([{ n: 2, kind: 'decision', line: 'You flagged two lines' }, { n: 9, kind: 'ask', line: 'x' }], ANNA);
    expect(tl.map((e) => e.kind)).toEqual(['attachment', 'decision', 'message', 'ask']);
    expect(tl[1]).toMatchObject({ messageId: 'a2', who: 'You', line: 'You flagged two lines' });
    expect(tl[3].who).toBe('Anna Berg');
  });

  it('caches the story until the thread grows, and cites real message ids', async () => {
    db.thread = [...ANNA];
    const grew = (req) => req.messages[1].content.includes('[5] From');
    gw.on('work.summarise', (req) => story({
      sentences: [{ text: grew(req) ? 'A fifth message arrived.' : 'Anna needs the final numbers by Thursday.', cites: [grew(req) ? 5 : 4] }],
      timeline: [{ n: 4, kind: 'ask', line: 'Final numbers by Thursday evening' }],
    }));
    gw.on('work.quickReplies', { fits: true, replies: ['Yes, by Thursday evening.', 'Sending them now.', 'Can it wait until Friday 9am?'] });

    const first = await thread.threadStory(USER, 't-anna');
    expect(first.story).toEqual({ text: 'Anna needs the final numbers by Thursday [1].', citations: [{ n: 1, messageId: 'a4' }] });
    expect(first.quickReplies).toHaveLength(3);
    expect(first.cached).toBe(false);
    expect(first.provenance.story).toMatchObject({ promptId: 'work.summarise', model: GEMMA, tier: 'reflex' });
    expect(first.storyMeta).toMatchObject({ source: 'open', tier: 'reflex', model: GEMMA, lighter: false });
    expect(first.tldr).toBe('Anna waits on your numbers');
    expect(first.provenance.quickReplies).toMatchObject({ promptId: 'work.quickReplies', model: GEMMA });
    expect(gw.callsFor('work.summarise')[0].text).toContain('emails [3] to [4] are new to them');

    const again = await thread.threadStory(USER, 't-anna');
    expect(again.cached).toBe(true);
    expect(again.story).toEqual(first.story);
    expect(gw.callsFor('work.summarise')).toHaveLength(1);

    // Reading a message is not growth; a new message is.
    db.thread = db.thread.map((m) => ({ ...m, is_read: true }));
    expect((await thread.threadStory(USER, 't-anna')).cached).toBe(true);
    db.thread.push(message({ id: 'a5', body_text: 'Thanks, received.', date: at('2026-09-23T11:00:00Z') }));
    const grown = await thread.threadStory(USER, 't-anna');
    expect(grown.cached).toBe(false);
    expect(grown.story.citations).toEqual([{ n: 1, messageId: 'a5' }]);
    expect(gw.callsFor('work.summarise')).toHaveLength(2);
    expect(thread.cacheValid({ up_to_message_id: 'a5' }, db.thread)).toBe(true);
    expect(thread.cacheValid({ up_to_message_id: 'a4' }, db.thread)).toBe(false);
  });

  it('opens the thread without a story when the model fails, and caches nothing', async () => {
    db.thread = [...ANNA];
    gw.on('work.summarise', gw.error(500, 'boom'));
    const out = await thread.threadStory(USER, 't-anna');
    expect(out.story).toBeNull();
    expect(out.storyError).toBeTruthy();
    expect(out.timeline).toHaveLength(4);
    expect(db.stories.size).toBe(0);
  });

  it('reports the nearest open deadline from commitments', async () => {
    db.thread = [...ANNA];
    db.commitments = [{ id: 'c1', what: 'Final Q3 numbers', due_at: at('2026-09-24T17:00:00Z'), direction: 'i_owe', counterparty: 'Anna', source_message_id: 'a4' }];
    gw.on('work.summarise', story({ sentences: [{ text: 'Anna asks.', cites: [4] }], timeline: [] }));
    gw.on('work.quickReplies', { fits: false, replies: [] });
    const out = await thread.threadStory(USER, 't-anna');
    expect(out.deadline).toMatchObject({ figure: 'Thu 24 Sept', messageId: 'a4', caption: 'Final Q3 numbers · You owe this' });
  });
});

// ── Eager summaries (work.summarise) ────────────────────────────────────────

describe('eager summaries', () => {
  const threadOf = (key, n, over = {}) => Array.from({ length: n }, (_, i) => message({
    id: `${key}-${i + 1}`, thread_key: key, body_text: `Message ${i + 1} of ${key}. Can you confirm?`, date: at(`2026-09-2${Math.min(2, Math.floor(i / 10))}T${String(8 + (i % 10)).padStart(2, '0')}:00:00Z`), is_read: false, ...over,
  }));
  // Answer every item of a work.summarise call: a thread gets one sentence citing its last email.
  const answer = (req) => {
    const text = req.messages[1].content;
    const items = [...text.matchAll(/=== Item (\w+) · kind: (\w+)/g)].map((m) => ({ id: m[1], kind: m[2] }));
    const counts = text.split('=== Item ').slice(1).map((part) => [...part.matchAll(/^\[(\d+)\] From/gm)].length);
    return { items: items.map((it, i) => (it.kind === 'thread'
      ? { id: it.id, tldr: `Thread ${it.id} waits on you`, sentences: [{ text: `Someone asked you in ${it.id}.`, cites: [counts[i]] }], timeline: [] }
      : { id: it.id, tldr: `  "TL;DR of ${it.id}"  `, sentences: [], timeline: [] })) };
  };

  it('knows a real person from lists, notifications and the owner', () => {
    expect(summaries.isPersonRow({ from_email: 'anna@northwind.example' })).toBe(true);
    expect(summaries.isPersonRow({ from_email: 'noreply@github.com' })).toBe(false);
    expect(summaries.isPersonRow({ from_email: 'info@the-ken.com', list_unsubscribe: '<mailto:u@x>' })).toBe(false);
    expect(summaries.isPersonRow({ from_email: 'anna@northwind.example', is_outgoing: true })).toBe(false);
    expect(summaries.cleanTldr('  "Anna needs\nthe numbers"  ')).toBe('Anna needs the numbers');
    expect(summaries.cleanTldr('x'.repeat(200))).toHaveLength(140);
    expect(summaries.cleanTldr('   ')).toBeNull();
  });

  it('batches four threads per Tier 1 call, cites each thread\'s own messages, and stores provenance', async () => {
    gw.on('work.summarise', answer);
    const threads = ['t1', 't2', 't3', 't4', 't5'].map((k) => ({ threadKey: k, messages: threadOf(k, 3) }));
    const out = await summaries.summariseThreads(USER, threads, { save: true, owner: { name: 'Prakhar', addresses: ['me@prafiles.example'] } });
    expect(gw.callsFor('work.summarise')).toHaveLength(2);
    expect(gw.callsFor('work.summarise').every((c) => c.model === GEMMA)).toBe(true);
    expect(out.every((r) => r.ok && !r.lighter)).toBe(true);
    const t5 = db.stories.get(`${USER}|t5`);
    expect(t5.story.story).toEqual({ text: 'Someone asked you in t1 [1].', citations: [{ n: 1, messageId: 't5-3' }] });
    expect(t5.story.tldr).toBe('Thread t1 waits on you');
    expect(t5).toMatchObject({ up_to_message_id: 't5-3', message_count: 3, prompt_id: 'work.summarise', model: GEMMA, tier: 'reflex', lighter: false, source: 'eager', ai_call_id: expect.any(Number) });
    expect(db.stories.get(`${USER}|t2`).story.story.citations).toEqual([{ n: 1, messageId: 't2-3' }]);
  });

  it('sends long threads to Tier 2, and to Tier 1 marked lighter while Tier 2 is degraded', async () => {
    resetConfig({ 'llm.fallbackModel': GEMMA, 'llm.fallbackCooldownSec': 600 });
    let qwenUp = true;
    gw.on('work.summarise', (req) => (req.model === QWEN && !qwenUp ? gw.error(503, 'overloaded') : answer(req)));
    const long = { threadKey: 'long', messages: threadOf('long', 10) };
    const [ok] = await summaries.summariseThreads(USER, [long], {});
    expect(ok).toMatchObject({ ok: true, lighter: false, provenance: { tier: 'reasoning', model: QWEN } });

    qwenUp = false; // Qwen fails: the call falls back to Gemma and Qwen is marked degraded
    const [fell] = await summaries.summariseThreads(USER, [long], {});
    expect(fell).toMatchObject({ ok: true, lighter: true });
    expect(fell.entry.storyMeta).toMatchObject({ lighter: true, model: GEMMA });
    const before = gw.callsFor('work.summarise').length;
    const [light] = await summaries.summariseThreads(USER, [long], {});
    expect(light).toMatchObject({ ok: true, lighter: true, provenance: { tier: 'reflex', model: GEMMA } });
    expect(gw.callsFor('work.summarise').slice(before).map((c) => c.model)).toEqual([GEMMA]); // degraded: Qwen not even tried
    // Short threads never escalate.
    const [short] = await summaries.summariseThreads(USER, [{ threadKey: 's', messages: threadOf('s', 3) }], {});
    expect(short).toMatchObject({ lighter: false, provenance: { tier: 'reflex' } });
    expect(await summaries.tierPlan(USER, { 'work.storyEscalateAbove': 8, 'routing.work.tier': 'reflex' }, 12)).toMatchObject({ escalate: false, lighter: true });
  });

  it('remembers a failed batch so the sweep waits before trying again', async () => {
    gw.on('work.summarise', { items: 'not a list' });
    const out = await summaries.summariseThreads(USER, [{ threadKey: 'bad', messages: threadOf('bad', 2) }], { save: true });
    expect(out).toEqual([expect.objectContaining({ threadKey: 'bad', ok: false })]);
    expect(db.failures).toEqual([expect.objectContaining({ threadKey: 'bad', count: 2 })]);
    expect(db.stories.size).toBe(0);
  });

  it('writes one-line TL;DRs six messages per call and serves them on People rows', async () => {
    gw.on('work.summarise', answer);
    const uid = (i) => `00000000-0000-4000-8000-00000000000${i}`;
    const rows = Array.from({ length: 7 }, (_, i) => message({ id: uid(i + 1), body_text: `Please review item ${i + 1}.` }));
    const res = await summaries.summariseMessages(USER, rows, { owner: { name: 'Prakhar', addresses: [] } });
    expect(res).toEqual({ written: 7, failed: 0 });
    expect(gw.callsFor('work.summarise')).toHaveLength(2);
    expect(gw.callsFor('work.summarise')[0].text).toContain('kind: message');
    expect(db.tldr.get(uid(7))).toMatchObject({ text: 'TL;DR of m1', model: GEMMA, promptId: 'work.summarise', tier: 'reflex' });
    const page = [{ threadId: 'x', messageId: uid(1), needsYou: false, reason: 'A person writing to you directly' }, { threadId: 'y', messageId: 'zz', needsYou: false }];
    db.needs = [{ thread_key: 'y', kind: 'reply_overdue', reason: 'Waiting 3 days for your reply', due_at: null }];
    const rowsOut = await lists.withWorkRows(USER, page, { first: false, now: clock.now });
    expect(rowsOut[0]).toMatchObject({ tldr: { text: 'TL;DR of m1', model: GEMMA, lighter: false }, workNeeds: null, needsYou: false });
    expect(rowsOut[1]).toMatchObject({ tldr: null, workNeeds: { kind: 'reply_overdue', reason: 'Waiting 3 days for your reply' }, needsYou: false });
    const flipped = await lists.withWorkRows(USER, page, { first: false, now: clock.now, derivedNeedsYou: true });
    expect(flipped[1]).toMatchObject({ needsYou: true, reason: 'Waiting 3 days for your reply' });
  });

  it('queues the summarise job once per user when mail from a person arrives, not for lists or your own mail', async () => {
    await lists.applyMail([
      { user_id: USER, thread_key: 'k1', date: clock.now, is_outgoing: false, from_email: 'info@the-ken.com', list_unsubscribe: '<mailto:x>' },
      { user_id: USER, thread_key: 'k2', date: clock.now, is_outgoing: true, from_email: 'me@prafiles.example' },
    ]);
    expect(db.jobs).toHaveLength(0);
    await lists.applyMail([
      { user_id: USER, thread_key: 'k3', date: clock.now, is_outgoing: false, from_email: 'anna@northwind.example' },
      { user_id: USER, thread_key: 'k4', date: clock.now, is_outgoing: false, from_email: 'jo@example.org' },
    ]);
    expect(db.jobs).toEqual([{ kind: 'work.summarise', payload: { userId: USER }, userId: USER, dedupeKey: `work.summarise:${USER}` }]);
    resetConfig({ 'work.summariesEager': false });
    db.jobs = [];
    await lists.applyMail([{ user_id: USER, thread_key: 'k5', date: clock.now, is_outgoing: false, from_email: 'anna@northwind.example' }]);
    expect(db.jobs).toHaveLength(0);
  });

  it('opens a thread with an eagerly written story without a story call, and adds quick replies once', async () => {
    db.thread = [...ANNA];
    gw.on('work.summarise', answer);
    const [r] = await summaries.summariseThreads(USER, [{ threadKey: 't-anna', messages: ANNA }], { save: true });
    expect(r.ok).toBe(true);
    gw.on('work.quickReplies', { fits: true, replies: ['Yes, by Thursday evening.', 'Sending them now.'] });
    const opened = await thread.threadStory(USER, 't-anna');
    expect(opened).toMatchObject({ cached: true, quickReplies: ['Yes, by Thursday evening.', 'Sending them now.'], storyMeta: { source: 'eager', lighter: false } });
    expect(opened.story.citations).toEqual([{ n: 1, messageId: 'a4' }]);
    expect(gw.callsFor('work.summarise')).toHaveLength(1);
    await thread.threadStory(USER, 't-anna');
    expect(gw.callsFor('work.quickReplies')).toHaveLength(1); // cached with the story from now on
  });
});

// ── Needs You reasons ───────────────────────────────────────────────────────

describe('derived needs you', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const row = { from_email: 'anna@northwind.example', to_addresses: [{ address: 'me@prafiles.example' }], date: new Date('2026-09-20T09:00:00Z'), stream: 'people' };
  it('flags a direct message from a person that has waited too long, and nothing else', () => {
    expect(needsMod.overdue(row, { ownerAddresses: ['me@prafiles.example'], now, days: 2 })).toEqual({ days: 3 });
    expect(needsMod.overdueReason(3)).toBe('Waiting 3 days for your reply');
    expect(needsMod.overdue(row, { ownerAddresses: ['me@prafiles.example'], now, days: 4 })).toBeNull();
    expect(needsMod.overdue({ ...row, to_addresses: [{ address: 'team@list.example' }] }, { ownerAddresses: ['me@prafiles.example'], now })).toBeNull();
    expect(needsMod.overdue({ ...row, stream: 'reading' }, { ownerAddresses: ['me@prafiles.example'], now })).toBeNull();
    expect(needsMod.overdue({ ...row, from_email: 'orders@shop.example' }, { ownerAddresses: ['me@prafiles.example'], now })).toBeNull();
    expect(needsMod.overdue({ ...row, mine: true }, { ownerAddresses: ['me@prafiles.example'], now })).toBeNull();
    expect(needsMod.deadlineReason('Send the signed form', '2026-09-25T17:00:00Z', 'Europe/London')).toBe('Due Fri 25 Sept: Send the signed form');
    expect(needsMod.workNeedsYouSql('m', 's')).toContain('hedwig_work_needs');
  });
});

// ── Quick replies ───────────────────────────────────────────────────────────

describe('quick replies', () => {
  const latest = ANNA[3];
  const text = 'Could you send the final Q3 numbers by Thursday evening?';

  it('are offered only for a short question from a person, with the feature on', () => {
    expect(thread.quickReplyGate({ cfg, latest, text })).toEqual({ ok: true, why: null });
    expect(thread.quickReplyGate({ cfg: { ...cfg, 'work.quickReplies': false }, latest, text }).why).toBe('off');
    expect(thread.quickReplyGate({ cfg: { ...cfg, 'ui.helpMeWrite': false }, latest, text }).why).toBe('help_me_write_off');
    expect(thread.quickReplyGate({ cfg, latest: { ...latest, mine: true }, text }).why).toBe('last_word_is_yours');
    expect(thread.quickReplyGate({ cfg, latest: { ...latest, from_email: 'noreply@github.com' }, text }).why).toBe('not_a_person');
    expect(thread.quickReplyGate({ cfg, latest: { ...latest, list_unsubscribe: '<mailto:x>' }, text }).why).toBe('not_a_person');
    expect(thread.quickReplyGate({ cfg, latest, text: 'Here are the minutes from today.' }).why).toBe('nothing_asked');
    expect(thread.quickReplyGate({ cfg: { ...cfg, 'work.quickReplyMaxChars': 100 }, latest, text: `${text} ${'x'.repeat(200)}` }).why).toBe('too_long');
  });

  it('keep 2–3 distinct one-liners, or none when a short reply does not fit', () => {
    expect(thread.cleanReplies({ fits: false, replies: ['Yes', 'No'] })).toEqual([]);
    expect(thread.cleanReplies({ fits: true, replies: ['Yes.'] })).toEqual([]);
    expect(thread.cleanReplies({ fits: true, replies: ['Yes.', 'yes.', 'No.', 'Maybe.', 'Later.'] })).toEqual(['Yes.', 'No.', 'Maybe.']);
    expect(thread.cleanReplies({ fits: true, replies: ['Yes.', 'x'.repeat(200), 'two\nlines', 'No.'] })).toEqual(['Yes.', 'No.']);
  });

  it('never call the model when the gate is closed', async () => {
    db.thread = [...ANNA.slice(0, 3)]; // last word: "Corrected both lines, new version attached." (asks nothing)
    gw.on('work.summarise', story({ sentences: [{ text: 'Anna corrected the lines.', cites: [3] }], timeline: [] }));
    const out = await thread.threadStory(USER, 't-anna');
    expect(out.quickReplies).toEqual([]);
    expect(gw.callsFor('work.quickReplies')).toHaveLength(0);
  });
});

// ── Drafts ──────────────────────────────────────────────────────────────────

describe('drafts in your voice', () => {
  beforeEach(() => {
    db.thread = [...ANNA];
    db.sent = [
      { body_text: 'Hi Anna,\n\nLooks good to me, send it over.\n\nThanks,\nPrakhar' },
      { body_text: 'Hi Anna,\n\nTwo revenue lines look off on page 4.\n\nThanks,\nPrakhar' },
      { body_text: 'Hi Anna, sure, Friday works.\n\nCheers,\nPrakhar' },
    ];
    db.parts = { id: 'a4', body_text: 'Could you send the final Q3 numbers by Thursday evening? The board pack prints Friday.\n\nOn Mon, Anna wrote:\n> old quoted text', body_html: null, snippet: '', attachments: [] };
    db.attach = [{ attachment_index: 0, filename: 'board-pack.pdf', mime: 'application/pdf', text: 'Agenda', error: null }];
  });

  it('assembles the thread, the answered message parts, the owner voice and the intent', async () => {
    gw.on('work.draft', { draft: 'Subject: Re: Q3\n\nHi Anna,\n\nYes, you will have them by Thursday evening.\n\nThanks,\nPrakhar' });
    const out = await draftMod.draft(USER, { threadId: 't-anna', intent: 'say yes, Thursday evening' });
    expect(out.draft).toBe('Hi Anna,\n\nYes, you will have them by Thursday evening.\n\nThanks,\nPrakhar');
    expect(out.provenance).toMatchObject({ promptId: 'work.draft', model: QWEN, tier: 'reasoning' });
    expect(out.reply).toMatchObject({ inReplyToMessageId: 'a4', subject: 'Re: Q3 report', to: [{ email: 'anna@northwind.example' }] });
    const call = gw.callsFor('work.draft')[0];
    expect(call.model).toBe(QWEN);
    expect(call.text).toContain('Greeting: Hi. Sign-off: Thanks.');
    expect(call.text).toContain('Looks good to me, send it over.');
    expect(call.text).toContain('Could you send the final Q3 numbers by Thursday evening?');
    expect(call.text).not.toContain('old quoted text');
    expect(call.text).toContain('board-pack.pdf');
    expect(call.text).toContain('q3-draft.pdf');
    expect(call.text).toContain('What the owner wants to say: say yes, Thursday evening');
    expect(call.text).toContain('Write the owner\'s reply to Anna Berg <anna@northwind.example>');
  });

  it('rewrites text as { before, after } with the tone instruction', async () => {
    gw.on('work.draft', { draft: 'Yes, Thursday evening.' });
    const out = await draftMod.draft(USER, { threadId: 't-anna', tone: 'shorter', text: 'Hi Anna, yes, I think I should be able to get them to you by Thursday evening, hopefully.' });
    expect(out).toMatchObject({ mode: 'rewrite', before: expect.stringContaining('hopefully'), after: 'Yes, Thursday evening.', draft: 'Yes, Thursday evening.' });
    expect(gw.callsFor('work.draft')[0].text).toContain('Make it shorter');
    gw.on('work.draft', { draft: 'Ja, Donnerstagabend.' });
    await draftMod.draft(USER, { tone: 'translate:German', text: 'Yes, Thursday evening.' });
    expect(gw.callsFor('work.draft')[1].text).toContain('Translate it into German');
  });

  it('validates tone and needs a thread to reply to', async () => {
    await expect(draftMod.draft(USER, { threadId: 't-anna', tone: 'sarcastic', text: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(draftMod.draft(USER, { intent: 'hi' })).rejects.toMatchObject({ status: 400 });
    resetConfig({ 'ui.helpMeWrite': false });
    await expect(draftMod.draft(USER, { threadId: 't-anna' })).rejects.toMatchObject({ status: 403 });
  });

  it('reads the owner voice from their own replies', () => {
    const v = voice.summarizeVoice([
      { text: 'Hi Anna,\n\nSure.\n\nThanks,\nPrakhar', signature: '' },
      { text: 'Hello Anna,\nFine by me.\nCheers', signature: '' },
      { text: 'Hi Anna,\nOK.\nThanks', signature: '' },
    ]);
    expect(v).toMatchObject({ greeting: 'Hi', signOff: 'Thanks', medianWords: 5 });
    expect(draftMod.counterpartOf(ANNA, ['me@prafiles.example'])).toMatchObject({ email: 'anna@northwind.example', messageId: 'a4' });
    expect(draftMod.counterpartOf([ANNA[1]], ['me@prafiles.example'])).toMatchObject({ email: 'anna@northwind.example' });
  });
});

// ── Send guard ──────────────────────────────────────────────────────────────

describe('send guard', () => {
  const personal = { personal: true, domains: ['northwind.example'], addresses: ['anna@northwind.example'] };
  const kinds = (w) => w.map((x) => x.kind);

  it('catches a mentioned attachment that is missing, but not a negated or quoted one', () => {
    expect(kinds(guard.checkMessage({ to: ['a@b.example'], subject: 'Report', body: 'The report is attached.' }))).toEqual(['missing_attachment']);
    expect(kinds(guard.checkMessage({ to: ['a@b.example'], subject: 'Report', body: 'The report is attached.', attachments: [{ filename: 'r.pdf' }] }))).toEqual([]);
    expect(kinds(guard.checkMessage({ to: ['a@b.example'], subject: 'Report', body: 'Sent without an attachment on purpose.' }))).toEqual([]);
    expect(kinds(guard.checkMessage({ to: ['a@b.example'], subject: 'Re: Report', body: 'Thanks!\n\nOn Mon, Anna wrote:\n> see attached' }))).toEqual([]);
  });

  it('warns when a personal thread goes to someone at another domain', () => {
    const w = guard.checkMessage({ to: ['Anna Berg <anna@northwind.example>', 'anna@southwind.example'], subject: 'Re: Q3', body: 'Numbers below.' }, { thread: personal, ownDomains: ['prafiles.example'] });
    expect(w).toEqual([{ kind: 'wrong_recipient', text: 'anna@southwind.example is not on this conversation, which is with @northwind.example.' }]);
    expect(guard.checkMessage({ to: ['bob@northwind.example', 'me2@prafiles.example'], subject: 'Re: Q3', body: 'x' }, { thread: personal, ownDomains: ['prafiles.example'] })).toEqual([]);
    expect(guard.checkMessage({ to: ['x@other.example'], subject: 'Re: news', body: 'x' }, { thread: { ...personal, personal: false } })).toEqual([]);
  });

  it('warns on reply-all to a crowd and on an empty subject', () => {
    const to = Array.from({ length: 9 }, (_, i) => `p${i}@northwind.example`);
    expect(kinds(guard.checkMessage({ to, subject: 'Re: all hands', body: 'ok' }, { replyAllWarnAbove: 8, thread: personal }))).toEqual(['reply_all_large']);
    expect(kinds(guard.checkMessage({ to, subject: 'Hello', body: 'ok' }, { replyAllWarnAbove: 8 }))).toEqual([]);
    expect(kinds(guard.checkMessage({ to: ['a@b.example'], subject: '  ', body: 'ok' }))).toEqual(['empty_subject']);
  });

  it('derives the thread context: domains of the people on it, personal unless bulk', () => {
    const ctx = guard.threadContext(ANNA.map((m) => ({ ...m, mine: m.from_email === 'me@prafiles.example' })), ['me@prafiles.example']);
    expect(ctx).toEqual({ personal: true, domains: ['northwind.example'], addresses: ['anna@northwind.example'] });
    expect(guard.threadContext([{ ...ANNA[0], mine: false, list_unsubscribe: '<x>' }], []).personal).toBe(false);
  });

  it('adds beforeSend plugin findings as custom warnings without doubling the attachment one', async () => {
    db.thread = [...ANNA];
    hookResults.beforeSend = [{ block: false, warn: 'x', findings: [
      { rule: 'attachment', level: 'warn', message: 'The message mentions "attached" but nothing is attached.' },
      { rule: 'confidential', level: 'block', message: 'The message says "confidential" and goes outside.' },
    ] }];
    const out = await guard.sendGuard(USER, { threadId: 't-anna', to: ['anna@northwind.example'], subject: 'Re: Q3', body: 'Confidential numbers attached.' });
    expect(out.warnings).toEqual([
      { kind: 'missing_attachment', text: 'You mention “attached” but nothing is attached.' },
      { kind: 'custom', text: 'The message says "confidential" and goes outside.', block: true },
    ]);
    expect(gw.calls).toHaveLength(0); // no model call
  });
});
