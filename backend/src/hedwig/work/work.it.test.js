// Integration test against the seeded dev database (backend/.env.hedwig-dev, node scripts/hedwig-seed.mjs).
//   set -a; . ./.env.hedwig-dev; set +a; HEDWIG_IT=1 npx vitest run src/hedwig/work
// Adds one small thread to the demo mailbox and works it end to end: People → Done → back on new mail
// (through the pipeline step), sweep, reminders as People rows, the cached cited story with quick
// replies, a draft in the owner's voice, a "remind me if no reply" watch with a nudge, the send
// guard, and the HTTP routes. Model calls go to the mock gateway. Everything it adds is removed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import express from 'express';
import { mockGateway } from '../testing/mockGateway.js';

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';
const DAY = 86400_000;

describe.skipIf(!process.env.HEDWIG_IT)('working the seeded demo mailbox', () => {
  const gw = mockGateway();
  const THREAD = `<work-it-${randomUUID()}@hedwig.test>`;
  const WAIT_THREAD = `<work-it-wait-${randomUUID()}@hedwig.test>`;
  const inserted = [];
  let query; let pool; let pipeline; let lists; let thread; let draft; let waiting; let guard; let sortService; let workModule;
  let userId; let account; let server; let base;

  async function addMessage(over) {
    const id = randomUUID();
    await query(
      `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_name, from_email, to_addresses, date, body_text, snippet, is_read, thread_id, in_reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, account, 900000 + Math.floor(Math.random() * 1e8), over.folder || 'INBOX', `<${id}@hedwig.test>`, over.subject, over.fromName, over.fromEmail,
        JSON.stringify(over.to.map((address) => ({ name: '', address }))), over.date, over.body, over.body.slice(0, 120), over.read ?? false, over.thread, over.inReplyTo || null],
    );
    inserted.push(id);
    if (over.stream) {
      await query(
        `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, needs_you, needs_you_reason, layer, reason, own)
         VALUES ($1, $2, $3, $4, $5, $6, 'rule', 'work IT', $7)`,
        [id, userId, account, over.stream, Boolean(over.needsYou), over.needsYou ? 'Jo asks you to confirm Thursday' : null, Boolean(over.own)],
      );
    }
    return id;
  }

  async function clean() {
    await query('DELETE FROM hedwig_work_items WHERE user_id = $1', [userId]);
    await query('DELETE FROM hedwig_work_stories WHERE user_id = $1', [userId]);
    await query('DELETE FROM hedwig_work_waiting WHERE user_id = $1', [userId]);
  }

  const people = async (opts = {}) => (await sortService.streamList(userId, 'people', { limit: 200, ...opts })).items;

  beforeAll(async () => {
    process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
    process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;
    process.env.HEDWIG_LLM_MODELS_FAST = GEMMA;
    process.env.HEDWIG_LLM_MODELS_LONG = QWEN;
    process.env.HEDWIG_LLM_FALLBACK_MODEL = '';
    gw.install();
    gw.on('work.story', (req) => {
      const n = [...req.messages[1].content.matchAll(/^\[(\d+)\] From/gm)].map((m) => Number(m[1]));
      return { sentences: [{ text: 'Jo wants you to confirm Thursday.', cites: [n[n.length - 1]] }], timeline: [{ n: n[n.length - 1], kind: 'ask', line: 'Jo asks about Thursday' }] };
    });
    gw.on('work.quickReplies', { fits: true, replies: ['Thursday works.', 'Can we do Friday instead?'] });
    gw.on('work.draft', { draft: 'Hi Jo,\n\nThursday works for me.\n\nCheers,\nPrakhar' });
    gw.on('work.nudge', { draft: 'Hi Jo, any news on the photos?' });

    ({ query, pool } = await import('../../services/db.js'));
    pipeline = await import('../pipeline.js');
    lists = await import('./lists.js');
    thread = await import('./thread.js');
    draft = await import('./draft.js');
    waiting = await import('./waiting.js');
    guard = await import('./sendguard.js');
    sortService = await import('../sort/service.js');
    workModule = (await import('./index.js')).default;
    const { invalidateConfigCache } = await import('../config.js');
    invalidateConfigCache();
    const { rows: u } = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u[0].id;
    account = (await query("SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = 'prakhar.demo@gmail.com'", [userId])).rows[0].id;
    await clean();

    const now = Date.now();
    // Voice: two of the owner's earlier replies to Jo, in another thread.
    await addMessage({ folder: 'Sent', subject: 'Re: Photos', fromName: 'Prakhar', fromEmail: 'prakhar.demo@gmail.com', to: ['jo@example.org'], date: new Date(now - 20 * DAY), body: 'Hi Jo,\n\nLovely, thanks for sending them over.\n\nCheers,\nPrakhar', read: true, thread: `<other-${randomUUID()}>` });
    await addMessage({ folder: 'Sent', subject: 'Re: Dinner', fromName: 'Prakhar', fromEmail: 'prakhar.demo@gmail.com', to: ['jo@example.org'], date: new Date(now - 30 * DAY), body: 'Hi Jo,\n\nSaturday is perfect.\n\nCheers,\nPrakhar', read: true, thread: `<other-${randomUUID()}>` });
    // The thread under test.
    await addMessage({ subject: 'Thursday?', fromName: 'Jo Park', fromEmail: 'jo@example.org', to: ['prakhar.demo@gmail.com'], date: new Date(now - 2 * DAY), body: 'Hi! Are we still on for Thursday at 7? Can you confirm?', thread: THREAD, stream: 'people', needsYou: true });
    // A thread the owner is waiting on: they asked five days ago, nobody answered.
    await addMessage({ folder: 'Sent', subject: 'Trip photos', fromName: 'Prakhar', fromEmail: 'prakhar.demo@gmail.com', to: ['jo@example.org'], date: new Date(now - 5 * DAY), body: 'Hi Jo, could you send me the trip photos when you have a moment?', read: true, thread: WAIT_THREAD, stream: 'people', own: true });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId }; next(); });
    const router = express.Router();
    workModule.routes(router);
    app.use('/api/hedwig', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/hedwig`;
  }, 60_000);

  afterAll(async () => {
    gw.restore();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!userId) return;
    await clean();
    if (inserted.length) await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [inserted]);
    await pool.end();
  }, 60_000);

  it('Done takes a thread out of People and new mail brings it back through the pipeline step', async () => {
    expect((await people()).some((i) => i.threadId === THREAD)).toBe(true);
    await lists.addItem(userId, 'reply_later', { threadId: THREAD, note: 'after work' });
    expect((await lists.listItems(userId, 'replyLater')).items).toEqual([
      expect.objectContaining({ threadId: THREAD, subject: 'Thursday?', needsYou: true, reason: 'Jo asks you to confirm Thursday', accountId: account, unread: true, note: 'after work' }),
    ]);

    await lists.addItem(userId, 'done', { threadId: THREAD });
    expect((await people()).some((i) => i.threadId === THREAD)).toBe(false);
    expect(await lists.listCounts(userId)).toMatchObject({ done: 1, reply_later: 0 });
    expect((await lists.listItems(userId, 'done')).items.map((i) => i.threadId)).toEqual([THREAD]);

    // Jo writes again. The People query shows it at once; the pipeline step closes the done item.
    const replyId = await addMessage({ subject: 'Re: Thursday?', fromName: 'Jo Park', fromEmail: 'jo@example.org', to: ['prakhar.demo@gmail.com'], date: new Date(Date.now() + 1000), body: 'Also, can you bring the charger?', thread: THREAD, stream: 'people', needsYou: true });
    expect((await people()).find((i) => i.threadId === THREAD)?.messageId).toBe(replyId);
    workModule.worker();
    const { rows } = await query(
      `SELECT ${pipeline.MESSAGE_COLUMNS} FROM messages m JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder WHERE m.id = $1`,
      [replyId],
    );
    await pipeline.runSteps(rows);
    const { rows: done } = await query("SELECT done_at, done_reason FROM hedwig_work_items WHERE user_id = $1 AND kind = 'done'", [userId]);
    expect(done).toEqual([{ done_at: expect.any(Date), done_reason: 'new_mail' }]);
    expect((await lists.listCounts(userId)).done).toBe(0);
  });

  it('sweeps a day into Done and shows due reminders as People rows', async () => {
    const before = (await people()).length;
    expect(before).toBeGreaterThan(1);
    const res = await lists.sweep(userId, { before: new Date(Date.now() - DAY).toISOString() });
    expect(res.marked).toBeGreaterThan(0);
    const after = await people();
    expect(after.length).toBe(before - res.marked);
    expect(after.some((i) => i.threadId === THREAD)).toBe(true); // Jo's thread has mail from today
    await query("DELETE FROM hedwig_work_items WHERE user_id = $1 AND kind = 'done'", [userId]);

    await lists.addItem(userId, 'reminder', { text: 'Call the dentist', at: new Date(Date.now() - 60_000).toISOString() });
    await lists.addItem(userId, 'reminder', { text: 'Not yet', at: new Date(Date.now() + DAY).toISOString() });
    const top = await people({ limit: 2 });
    expect(top[0]).toMatchObject({ synthetic: true, subject: 'Call the dentist', messageId: null, needsYou: true });
    expect(top).toHaveLength(3);
    expect((await sortService.streamList(userId, 'people', { limit: 2, cursor: (await sortService.streamList(userId, 'people', { limit: 2 })).next })).items.some((i) => i.synthetic)).toBe(false);
    expect((await lists.listItems(userId, 'reminder')).items.map((i) => i.subject)).toEqual(['Call the dentist', 'Not yet']);
    await query("DELETE FROM hedwig_work_items WHERE user_id = $1 AND kind = 'reminder'", [userId]);
  });

  it('snoozes through upstream and says "Back from snooze" when it returns', async () => {
    const calls = [];
    const until = new Date(Date.now() + DAY);
    const res = await lists.snooze(userId, { threadId: THREAD, until: until.toISOString() }, { snoozeMessage: async (uid, args) => { calls.push({ uid, ...args }); return { count: 1 }; } });
    expect(calls).toEqual([{ uid: userId, messageId: expect.any(String), until: until.toISOString() }]);
    expect(res).toMatchObject({ ok: true, threadId: THREAD });
    expect((await people()).some((i) => i.threadId === THREAD)).toBe(false);
    expect((await lists.listCounts(userId)).snoozed).toBe(1);
    // Upstream's watcher wakes it; Hedwig remembers why it is back.
    await query("UPDATE hedwig_work_items SET until = NOW() - INTERVAL '1 hour' WHERE user_id = $1 AND kind = 'snoozed'", [userId]);
    expect((await people()).find((i) => i.threadId === THREAD)).toMatchObject({ reason: 'Back from snooze', backFromSnooze: true });
    await expect(lists.snooze(userId, { threadId: THREAD, until: 'soon' }, { snoozeMessage: async () => ({}) })).rejects.toMatchObject({ status: 400 });
    await query("DELETE FROM hedwig_work_items WHERE user_id = $1 AND kind = 'snoozed'", [userId]);
  });

  it('tells the story with citations, caches it, and offers quick replies', async () => {
    const first = await thread.threadStory(userId, THREAD);
    const { rows: msgs } = await query('SELECT id FROM messages WHERE thread_key = $1 ORDER BY date', [THREAD]);
    expect(first.story).toEqual({ text: 'Jo wants you to confirm Thursday [1].', citations: [{ n: 1, messageId: msgs[msgs.length - 1].id }] });
    expect(first.quickReplies).toEqual(['Thursday works.', 'Can we do Friday instead?']);
    expect(first.timeline.map((e) => e.messageId)).toEqual(msgs.map((m) => m.id));
    expect(first.provenance.story).toMatchObject({ promptId: 'work.story', model: GEMMA, aiCallId: expect.anything() });
    const again = await thread.threadStory(userId, THREAD);
    expect(again.cached).toBe(true);
    expect(gw.callsFor('work.story')).toHaveLength(1);
    const { rows: [row] } = await query('SELECT up_to_message_id, message_count FROM hedwig_work_stories WHERE user_id = $1 AND thread_key = $2', [userId, THREAD]);
    expect(row).toEqual({ up_to_message_id: msgs[msgs.length - 1].id, message_count: msgs.length });
  });

  it('drafts a reply in the owner voice and rewrites text', async () => {
    const out = await draft.draft(userId, { threadId: THREAD, intent: 'yes to Thursday' });
    expect(out.draft).toContain('Thursday works for me.');
    expect(out.provenance).toMatchObject({ promptId: 'work.draft', model: QWEN });
    const text = gw.callsFor('work.draft')[0].text;
    expect(text).toContain('Lovely, thanks for sending them over.');
    expect(text).toContain('Greeting: Hi. Sign-off: Cheers.');
    expect(text).toContain('Also, can you bring the charger?');
    const rw = await draft.draft(userId, { tone: 'friendlier', text: 'Thursday.' });
    expect(rw).toMatchObject({ mode: 'rewrite', before: 'Thursday.', after: expect.any(String) });
  });

  it('keeps a "remind me if no reply" watch, drafts a nudge, and resolves it', async () => {
    const { watch } = await waiting.addWatch(userId, { threadId: WAIT_THREAD, days: 3 });
    expect(watch).toMatchObject({ threadId: WAIT_THREAD, days: 3 });
    const list = await waiting.listWaiting(userId);
    expect(list.find((w) => w.threadId === WAIT_THREAD)).toMatchObject({ who: 'jo@example.org', subject: 'Trip photos', days: 5, source: 'watch', nudgeDraftAvailable: true });
    const { rows: tri } = await query(
      `SELECT m.thread_key FROM hedwig_triage t JOIN messages m ON m.id = t.message_id
        WHERE t.user_id = $1 AND t.category = 'waiting_on' AND t.resolved_at IS NULL AND NOT t.overridden`,
      [userId],
    );
    for (const t of tri) expect(list.some((w) => w.threadId === t.thread_key && w.source === 'triage')).toBe(true);

    const n = await waiting.nudge(userId, WAIT_THREAD);
    expect(n).toMatchObject({ draft: 'Hi Jo, any news on the photos?', reply: { subject: 'Re: Trip photos', to: [{ email: 'jo@example.org' }] } });
    expect(gw.callsFor('work.nudge')[0].text).toContain('could you send me the trip photos');
    await waiting.resolveWaiting(userId, WAIT_THREAD);
    expect((await waiting.listWaiting(userId)).some((w) => w.threadId === WAIT_THREAD)).toBe(false);
  });

  it('guards a send: wrong recipient on a personal thread, missing attachment', async () => {
    const out = await guard.sendGuard(userId, { threadId: THREAD, to: ['jo@example.com'], subject: 'Re: Thursday?', body: 'Charger attached, see you then.' });
    expect(out.warnings.map((w) => w.kind)).toEqual(['missing_attachment', 'wrong_recipient']);
  });

  it('serves the routes the frontend calls', async () => {
    const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
    const post = async (p, body, method = 'POST') => {
      const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return { status: r.status, body: await r.json() };
    };
    expect((await post('/work/lists/setAside', { threadId: THREAD })).status).toBe(200);
    expect((await get('/work/lists')).body).toMatchObject({ set_aside: 1, setAside: 1 });
    expect((await get('/work/lists/set_aside')).body.items[0]).toMatchObject({ threadId: THREAD });
    expect((await post(`/work/lists/set_aside/${encodeURIComponent(THREAD)}`, null, 'DELETE')).body).toMatchObject({ ok: true });
    expect((await get('/work/lists/archive')).status).toBe(400);
    const story = await get(`/work/thread/${encodeURIComponent(THREAD)}`);
    expect(story.status).toBe(200);
    expect(story.body.story.citations).toHaveLength(1);
    expect((await get('/work/thread/nope')).status).toBe(404);
    expect((await post('/work/sendguard', { to: ['a@b.example'], subject: '', body: 'hi' })).body.warnings).toEqual([{ kind: 'empty_subject', text: 'The subject is empty.' }]);
    expect(Array.isArray((await get('/work/waiting')).body)).toBe(true);
    expect((await post('/work/draft', { tone: 'loud', text: 'x' })).status).toBe(400);
    expect((await post('/work/sweep', {})).status).toBe(400);
  });
});
