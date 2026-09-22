// Integration test against the seeded dev database (backend/.env.hedwig-dev, node scripts/hedwig-seed.mjs).
//   set -a; . ./.env.hedwig-dev; set +a; HEDWIG_IT=1 npx vitest run src/hedwig/triage
// It resets the demo user's triage tables, runs the pipeline steps over the demo mailbox and leaves
// a freshly triaged mailbox behind. It never calls the model gateway.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

describe.skipIf(!process.env.HEDWIG_IT)('triage on the seeded demo mailbox', () => {
  let query; let pool; let pipeline; let service; let resolution; let learning; let userId; let addrs; let rows;
  const bySubject = new Map();
  let spamModelExisted = false;

  const TABLES = ['hedwig_triage', 'hedwig_triage_feedback', 'hedwig_triage_models', 'hedwig_sender_stats', 'hedwig_triage_sender_log', 'hedwig_triage_rules'];

  async function reset() {
    for (const t of TABLES) await query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind LIKE 'triage.%'", [userId]);
  }

  async function loadRows(where = 'TRUE', params = []) {
    const { rows: r } = await query(
      `SELECT ${pipeline.MESSAGE_COLUMNS}
         FROM messages m JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND NOT m.is_deleted AND ${where}
        ORDER BY m.date ASC`,
      [userId, ...params],
    );
    return r;
  }

  async function triageOf(subject) {
    const id = bySubject.get(subject);
    expect(id, `seeded message "${subject}"`).toBeTruthy();
    return (await service.getTriage(userId, id))?.triage;
  }

  beforeAll(async () => {
    process.env.HEDWIG_LLM_BASE_URL = ''; // no stage-3 jobs from this test
    ({ query, pool } = await import('../../services/db.js'));
    pipeline = await import('../pipeline.js');
    service = await import('./service.js');
    resolution = await import('./resolution.js');
    learning = await import('./learning.js');
    const triage = (await import('./index.js')).default;
    pipeline._resetSteps();
    triage.worker();
    const { rows: u } = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u[0].id;
    spamModelExisted = (await query('SELECT 1 FROM spam_models WHERE user_id = $1', [userId])).rows.length > 0;
    await reset();
    rows = await loadRows();
    for (const r of rows) if (!bySubject.has(r.subject)) bySubject.set(r.subject, r.id);
    addrs = (await pipeline.userAddresses([userId])).get(userId);
    await pipeline.runSteps(rows);
  }, 60_000);

  afterAll(async () => {
    if (!userId) return;
    await query("DELETE FROM spam_training_log WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'", [userId]);
    if (!spamModelExisted) await query('DELETE FROM spam_models WHERE user_id = $1', [userId]);
    // Leave a clean, freshly triaged demo mailbox for UI work.
    await reset();
    await pipeline.runSteps(await loadRows());
    await resolution.scanWaitingOn(userId, addrs, { waitingDays: 3 });
    await pool.end();
  }, 60_000);

  it('triages the demo mailbox the way a person would', async () => {
    const visa = await triageOf('Re: Visa sponsorship — final documents by 30 Sep');
    expect(visa.category).toBe('needs_you');
    expect(visa.reason_label).toMatch(/^Deadline · (\d+ d|today|overdue)$/);
    expect((await triageOf('Invoice 2041'))).toMatchObject({ category: 'needs_you', reason_label: 'Money · conflict' });
    expect((await triageOf('Re: Follow-up appointment options'))).toMatchObject({ category: 'needs_you', reason_label: 'Asked twice' });
    expect((await triageOf('Boiler inspection Thursday?')).category).toBe('needs_you');
    expect((await triageOf('Money Stuff: The bond market is weird again')).category).toBe('digest');
    expect((await triageOf('The Batch: new open-weight models')).category).toBe('digest');
    expect((await triageOf('[Team-AER/pensieve] CI failed on main')).category).toBe('notifications');
    expect((await triageOf('Your order has shipped: USB-C dock')).category).toBe('notifications');
    const spam = await triageOf('URGENT: verify your wallet to claim 2.4 BTC');
    expect(spam.category).toBe('spam');
    expect(spam.reasons[0].label).toMatch(/^Scam phrasing/);
    expect((await triageOf('Team update 3')).category).toBe('everything');
  });

  it('triages every incoming message and no outgoing one', async () => {
    const { rows: counts } = await query(
      `SELECT COUNT(*) FILTER (WHERE f.special_use = '\\Sent')::int AS sent_triaged, COUNT(*)::int AS total
         FROM hedwig_triage t JOIN messages m ON m.id = t.message_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE t.user_id = $1 AND t.category <> 'waiting_on'`,
      [userId],
    );
    const incoming = rows.filter((r) => r.special_use !== '\\Sent').length;
    expect(counts[0]).toEqual({ sent_triaged: 0, total: incoming });
  });

  it('keeps sender stats idempotent and credits replies', async () => {
    const get = async (email) => (await query('SELECT received, replied FROM hedwig_sender_stats WHERE user_id = $1 AND sender_email = $2', [userId, email])).rows[0];
    const before = await get('priya.nair@vantage.example');
    expect(before.received).toBe(15);
    expect(before.replied).toBe(1);
    expect((await get('marta@kowalski-design.example')).replied).toBe(1);
    await pipeline.runSteps(await loadRows());
    expect(await get('priya.nair@vantage.example')).toEqual(before);
  });

  it('finds what the user is waiting on', async () => {
    const n = await resolution.scanWaitingOn(userId, addrs, { waitingDays: 3 });
    expect(n).toBe(1);
    const { items, counts } = await service.listTriage(userId, { view: 'waiting_on' });
    expect(counts.waiting_on).toBe(1);
    expect(items[0].message.subject).toBe('Laptop replacement request');
    expect(items[0].triage.reason_label).toMatch(/^Waiting \d+ d$/);
  });

  it('clears waiting-on when a reply arrives', async () => {
    const laptopId = bySubject.get('Laptop replacement request');
    const { rows: [laptop] } = await query('SELECT account_id, thread_id FROM messages WHERE id = $1', [laptopId]);
    const replyId = randomUUID();
    await query(
      `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_name, from_email, to_addresses, cc_addresses, date, snippet, body_text, thread_id, in_reply_to)
       VALUES ($1, $2, 999998, 'INBOX', $3, 'Re: Laptop replacement request', 'Ops', 'ops@vantage.example', '[{"address":"prakhar@vantage.example"}]', '[]', NOW(), 'Approved', 'Approved, collect it Monday.', $4, '<laptop-1@hedwig.test>')`,
      [replyId, laptop.account_id, `<${replyId}@hedwig.test>`, laptop.thread_id],
    );
    try {
      await pipeline.runSteps(await loadRows('m.id = $2', [replyId]));
      expect((await service.listTriage(userId, { view: 'waiting_on' })).counts.waiting_on).toBe(0);
      expect((await service.getTriage(userId, replyId)).triage.category).toBe('everything');
    } finally {
      await query('DELETE FROM messages WHERE id = $1', [replyId]);
      await query("DELETE FROM hedwig_sender_stats WHERE user_id = $1 AND sender_email = 'ops@vantage.example'", [userId]);
      await query('UPDATE hedwig_triage SET resolved_at = NULL WHERE message_id = $1', [laptopId]);
    }
  });

  it('lists needs-you items with account, thread and counts', async () => {
    const { items, counts } = await service.listTriage(userId, { view: 'needs_you' });
    expect(counts.needs_you).toBe(items.length);
    expect(counts.spam).toBe(1);
    const invoice = items.find((i) => i.message.subject === 'Invoice 2041');
    expect(invoice.message.account).toMatchObject({ name: 'prafiles.in', color: '#1F6B66' });
    expect(invoice.thread.count).toBe(3);
    expect(invoice.thread.participants.map((p) => p.email)).toEqual(expect.arrayContaining(['marta@kowalski-design.example', 'me@prafiles.example']));
    for (let i = 1; i < items.length; i++) expect(items[i - 1].triage.priority).toBeGreaterThanOrEqual(items[i].triage.priority);
  });

  it('resolves a needs-you item when the user replies in the thread', async () => {
    const docId = bySubject.get('Re: Follow-up appointment options');
    const { rows: [doc] } = await query('SELECT account_id, thread_id FROM messages WHERE id = $1', [docId]);
    const replyId = randomUUID();
    await query(
      `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_email, to_addresses, cc_addresses, date, snippet, thread_id, in_reply_to)
       VALUES ($1, $2, 999999, 'Sent', $3, 'Re: Follow-up appointment options', 'prakhar.demo@gmail.com', '[]', '[]', NOW(), 'Tuesday works', $4, '<doc-2@hedwig.test>')`,
      [replyId, doc.account_id, `<${replyId}@hedwig.test>`, doc.thread_id],
    );
    try {
      const out = await resolution.sweepResolution(userId, addrs);
      expect(out.replied).toBeGreaterThanOrEqual(1);
      const { items } = await service.listTriage(userId, { view: 'needs_you' });
      expect(items.some((i) => i.message.id === docId)).toBe(false);
    } finally {
      await query('DELETE FROM messages WHERE id = $1', [replyId]);
      await query('UPDATE hedwig_triage SET resolved_at = NULL WHERE message_id = $1', [docId]);
    }
  });

  it('records overrides as explicit feedback and keeps upstream spam training in sync', async () => {
    const hetzner = bySubject.get('Server auction: your watched config is available');
    const info = await service.overrideTriage(userId, hetzner, { category: 'needs_you', reason: 'I am buying one' });
    expect(info).toMatchObject({ category: 'needs_you', needs_you: true, overridden: true, reason_label: 'You set this' });
    expect(info.reasons[0].label).toBe('You moved this to Needs you: I am buying one');
    const { rows: fb } = await query("SELECT label, features FROM hedwig_triage_feedback WHERE message_id = $1 AND source = 'explicit'", [hetzner]);
    expect(fb[0].label).toBe('needs_you');
    expect(Object.keys(fb[0].features).length).toBeGreaterThan(5);

    const spamId = bySubject.get('URGENT: verify your wallet to claim 2.4 BTC');
    const before = (await query("SELECT COUNT(*)::int AS n FROM spam_training_log WHERE user_id = $1 AND label = 'ham'", [userId])).rows[0].n;
    await service.overrideTriage(userId, spamId, { category: 'everything' });
    const after = (await query("SELECT COUNT(*)::int AS n FROM spam_training_log WHERE user_id = $1 AND label = 'ham'", [userId])).rows[0].n;
    expect(after).toBe(before + 1);
    // Re-running the pipeline never clobbers an override.
    await pipeline.runSteps(await loadRows('m.id = $2', [spamId]));
    expect((await service.getTriage(userId, spamId)).triage.category).toBe('everything');
  });

  it('never exposes or changes another user\'s triage', async () => {
    const stranger = randomUUID();
    const id = bySubject.get('Invoice 2041');
    expect(await service.getTriage(stranger, id)).toBeNull();
    await expect(service.overrideTriage(stranger, id, { category: 'spam' })).rejects.toMatchObject({ status: 404 });
    await expect(service.resolveTriage(stranger, id)).rejects.toMatchObject({ status: 404 });
    expect((await service.listTriage(stranger, {})).items).toEqual([]);
    expect((await service.senderRule(stranger, { domain: 'github.com', category: 'digest', preview: true })).affected).toBe(0);
  });

  it('previews and applies a sender rule that stage 1 then honours', async () => {
    const preview = await service.senderRule(userId, { domain: 'github.com', category: 'digest', preview: true });
    expect(preview.affected).toBe(6);
    expect(preview.sample).toHaveLength(5);
    expect(preview.sample[0].account).toMatchObject({ name: 'Gmail · personal' });
    const sib = await service.senderRule(userId, { sender: 'newsletter@moneystuff.example', category: 'spam', preview: true });
    expect(sib.siblings).toEqual([]);
    expect(sib.affected).toBe(6);
    expect(await service.senderRule(userId, { domain: 'github.com', category: 'digest' })).toEqual({ applied: 6 });
    expect((await triageOf('[Team-AER/pensieve] CI failed on main'))).toMatchObject({ category: 'digest', overridden: true });
    // New mail from the domain: stage 1 applies the rule.
    const gh = await loadRows("lower(m.from_email) = 'notifications@github.com'");
    await query('DELETE FROM hedwig_triage WHERE message_id = ANY($1::uuid[])', [gh.map((r) => r.id)]);
    await pipeline.runSteps(gh);
    expect((await triageOf('[Team-AER/pensieve] CI failed on main'))).toMatchObject({ category: 'digest', overridden: false, reason_label: 'Your rule' });
  });

  it('learns from behaviour, retrains and reports stats', async () => {
    const out = await learning.implicitFeedbackForUser(userId, addrs, { hours: 48 });
    expect(out.labelled).toBeGreaterThan(0);
    const { rows: labels } = await query("SELECT label, COUNT(*)::int AS n FROM hedwig_triage_feedback WHERE user_id = $1 AND source = 'implicit' GROUP BY label", [userId]);
    const byLabel = Object.fromEntries(labels.map((l) => [l.label, l.n]));
    expect(byLabel.needs_you).toBeGreaterThan(0); // Priya's visa update, which the user answered
    expect(byLabel.ignored).toBeGreaterThan(0); // newsletters never opened
    const trained = await service.retrain(userId);
    expect(trained.ok).toBe(true);
    expect(trained.samples).toBeGreaterThan(5);
    expect(trained.metrics).toMatchObject({ active: false, minSamples: 40 });
    const stats = await service.triageStats(userId);
    expect(stats.samples).toBeGreaterThan(5);
    expect(stats.trainedAt).toBeTruthy();
    expect(stats.corrections30d).toBe(2);
    expect(stats.stageCounts[1]).toBeGreaterThan(20);
    expect(stats.spamBeyondProvider).toBeGreaterThanOrEqual(0);
    expect(stats.needsYouOpen).toBeGreaterThan(3);
  });

  it('resolves on request and keeps the item out of the list', async () => {
    const id = bySubject.get('Boiler inspection Thursday?');
    expect(await service.resolveTriage(userId, id)).toEqual({ ok: true });
    const { items } = await service.listTriage(userId, { view: 'needs_you' });
    expect(items.some((i) => i.message.id === id)).toBe(false);
  });
});
