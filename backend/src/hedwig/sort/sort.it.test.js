// Integration test against the seeded dev database (backend/.env.hedwig-dev, node scripts/hedwig-seed.mjs).
//   set -a; . ./.env.hedwig-dev; set +a; HEDWIG_IT=1 npx vitest run src/hedwig/sort
// Sorts the demo mailbox end to end: pipeline rows → cheap layers → sort.reflex jobs answered by the
// mock gateway → auto-screen, screener, corrections with rules, today + undo, bundles, spam rescue.
// It never calls the live gateway. It leaves a sorted demo mailbox behind for UI work.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { mockGateway } from '../testing/mockGateway.js';

const GEMMA = 'google/gemma-4-12B-it-qat-w4a16-ct';
const QWEN = 'Qwen/Qwen3.8-Flash-Next';

// What the mock "model" thinks of each demo sender (by address).
const VERDICTS = {
  'reception@anandclinic.example': { stream: 'people', needs_you: true, needs_you_reason: 'Dr Anand needs you to pick a slot before Friday', confidence: 0.93, reason: 'Your clinic writes to you directly' },
  'sam.wilson@lettings.example': { stream: 'people', needs_you: true, needs_you_reason: 'Sam asks whether someone will be in on Thursday', confidence: 0.9, reason: 'Your letting agent asks you something' },
  'amaan.q@gmail.com': { stream: 'people', needs_you: true, needs_you_reason: 'Amaan asks you to send £160 for the cabin', confidence: 0.91, reason: 'A friend writes to you' },
  'thomas@reedlaw.example': { stream: 'people', needs_you: false, needs_you_reason: '', confidence: 0.55, reason: 'Your solicitor, probably' },
  'notifications@github.com': { stream: 'records', bundle: 'forums', confidence: 0.88, reason: 'GitHub notifications for your repositories' },
  'newsletter@moneystuff.example': { stream: 'reading', bundle: 'updates', confidence: 0.9, reason: 'A newsletter you subscribed to' },
  'thebatch@deeplearning.example': { stream: 'reading', bundle: 'updates', confidence: 0.9, reason: 'A weekly AI newsletter' },
  'messages-noreply@linkedin.example': { stream: 'records', bundle: 'social', confidence: 0.86, reason: 'LinkedIn activity' },
  'info@hetzner.example': { stream: 'reading', bundle: 'promotions', confidence: 0.82, reason: 'An offer from your hosting provider' },
  'order-update@amazon.example': { stream: 'records', bundle: 'deliveries', confidence: 0.95, reason: 'Your Amazon order shipped' },
  'receipts@uber.example': { stream: 'records', bundle: 'purchases', confidence: 0.95, reason: 'Your Uber receipt' },
  'team@notion.example': { stream: 'reading', bundle: 'updates', confidence: 0.8, reason: 'Product news from Notion' },
  'billing@fast-crypto-win.example': { stream: 'people', spam: 'phishing', confidence: 0.9, reason: 'A crypto lure asking you to verify a wallet' },
};

function reflexReply(req) {
  const blocks = req.text.split(/\n### /).slice(1);
  return {
    items: blocks.map((b) => {
      const id = b.split('\n')[0].trim();
      const email = (/From: .*?<([^>]+)>/.exec(b) || /From: (\S+@\S+)/.exec(b) || [])[1] || '';
      const v = VERDICTS[email.toLowerCase()] || { stream: 'records', confidence: 0.5, reason: 'Not sure' };
      return { id, bundle: '', needs_you: false, needs_you_reason: '', spam: 'clean', matches: [], ...v };
    }),
  };
}

describe.skipIf(!process.env.HEDWIG_IT)('sorting the seeded demo mailbox', () => {
  const gw = mockGateway();
  let query; let pool; let pipeline; let engine; let service; let bundles; let userId; let personalAccount;
  const bySubject = new Map();
  const inserted = [];

  const TABLES = ['hedwig_sort', 'hedwig_senders', 'hedwig_sender_proposals', 'hedwig_sort_log', 'hedwig_rules', 'hedwig_bundle_deliveries', 'hedwig_bundles', 'hedwig_sort_models'];

  async function reset() {
    for (const t of TABLES) await query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    await query("DELETE FROM hedwig_corrections WHERE user_id = $1 AND kind IN ('sort','screener','spam')", [userId]).catch(() => {});
    await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind LIKE 'sort.%'", [userId]);
    await query("DELETE FROM hedwig_state WHERE key LIKE 'sort.seeded:%' OR key = $1", [`sort.contactsSeeded:${userId}`]);
  }

  async function loadRows(where = 'TRUE', params = []) {
    const { rows } = await query(
      `SELECT ${pipeline.MESSAGE_COLUMNS}
         FROM messages m JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE a.user_id = $1 AND NOT m.is_deleted AND ${where}
        ORDER BY m.date ASC`,
      [userId, ...params],
    );
    return pipeline.decorate(rows);
  }

  async function drainReflexJobs() {
    let n = 0;
    for (let round = 0; round < 5; round++) {
      const { rows: jobs } = await query(
        "SELECT * FROM hedwig_jobs WHERE user_id = $1 AND kind = 'sort.reflex' AND done_at IS NULL AND failed_at IS NULL ORDER BY id",
        [userId],
      );
      if (!jobs.length) break;
      for (const job of jobs) {
        await engine.runReflexJob(job.payload, job);
        await query('UPDATE hedwig_jobs SET done_at = NOW() WHERE id = $1', [job.id]);
        n++;
      }
    }
    return n;
  }

  async function sortOf(subject) {
    const id = bySubject.get(subject);
    expect(id, `seeded message "${subject}"`).toBeTruthy();
    const { rows } = await query('SELECT * FROM hedwig_sort WHERE message_id = $1', [id]);
    return rows[0];
  }

  beforeAll(async () => {
    process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
    process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;
    process.env.HEDWIG_LLM_MODELS_FAST = GEMMA;
    process.env.HEDWIG_LLM_MODELS_LONG = QWEN;
    process.env.HEDWIG_LLM_FALLBACK_MODEL = '';
    gw.install();
    gw.on('sort.reflex', reflexReply);
    gw.on('sort.screener', (req) => ({
      senders: [...req.text.matchAll(/### (\S+) \((\w+)\)/g)].map((m) => ({ key: m[1], proposed: 'people', confidence: 0.6, reason: 'A person who writes to you' })),
    }));
    gw.on('spam.reflex', (req) => ({
      items: [...req.text.matchAll(/### (m\d+)\nFrom: [^\n]*<([^>]+)>/g)].map((m) => ({
        id: m[1], verdict: m[2].includes('priya') ? 'legit' : 'phishing', confidence: 0.9, reason: m[2].includes('priya') ? 'Your colleague' : 'A lure',
      })),
    }));
    gw.on('sort.bundleDescribe', { key: 'kids-school', hint: 'Letters, newsletters and payments from the children’s school', keywords: ['school', 'term', 'pupil', 'parents evening'], stream: 'records' });

    ({ query, pool } = await import('../../services/db.js'));
    pipeline = await import('../pipeline.js');
    engine = await import('./engine.js');
    service = await import('./service.js');
    bundles = await import('./bundles.js');
    const { invalidateConfigCache } = await import('../config.js');
    invalidateConfigCache();
    const { rows: u } = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u[0].id;
    personalAccount = (await query("SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = 'prakhar.demo@gmail.com'", [userId])).rows[0].id;
    await reset();
    const rows = await loadRows();
    for (const r of rows) if (!bySubject.has(r.subject)) bySubject.set(r.subject, r.id);
    await engine.sortRows(rows);
    await drainReflexJobs();
  }, 120_000);

  afterAll(async () => {
    gw.restore();
    if (!userId) return;
    if (inserted.length) await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [inserted]);
    await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind LIKE 'sort.%' AND done_at IS NULL", [userId]);
    await pool.end();
  }, 60_000);

  it('sorts the demo mailbox into streams with reasons and provenance', async () => {
    const visa = await sortOf('Re: Visa sponsorship — final documents by 30 Sep');
    expect(visa).toMatchObject({ stream: 'people', needs_you: true, layer: 'rule', reason: 'A reply in a thread you wrote in' });
    expect(visa.needs_you_reason).toMatch(/^Priya needs a reply by /);

    const boiler = await sortOf('Boiler inspection Thursday?');
    expect(boiler).toMatchObject({ stream: 'people', needs_you: true, layer: 'reflex', prompt_id: 'sort.reflex', model: GEMMA });
    expect(boiler.needs_you_reason).toBe('Sam asks whether someone will be in on Thursday');

    expect(await sortOf('Money Stuff: The bond market is weird again')).toMatchObject({ stream: 'reading', bundle: 'updates' });
    expect(await sortOf('Your order has shipped: USB-C dock')).toMatchObject({ stream: 'records', bundle: 'deliveries' });
    expect((await sortOf('[Team-AER/pensieve] CI failed on main')).stream).toBe('records');
    expect(await sortOf('URGENT: verify your wallet to claim 2.4 BTC')).toMatchObject({ stream: 'spam', needs_you: false });
    expect(['phishing', 'suspected']).toContain((await sortOf('URGENT: verify your wallet to claim 2.4 BTC')).spam);

    // Every non-own row records its layer and reason.
    const { rows: missing } = await query("SELECT COUNT(*)::int AS n FROM hedwig_sort WHERE user_id = $1 AND NOT own AND (layer IS NULL OR reason IS NULL)", [userId]);
    expect(missing[0].n).toBe(0);
    const { rows: pending } = await query('SELECT COUNT(*)::int AS n FROM hedwig_sort WHERE user_id = $1 AND pending IS NOT NULL', [userId]);
    expect(pending[0].n).toBe(0);
  });

  it('escalates the unsure to the reasoning tier and keeps them in the Screener', async () => {
    const calls = gw.callsFor('sort.reflex');
    expect(calls.some((c) => c.model === GEMMA)).toBe(true);
    expect(calls.some((c) => c.model === QWEN && c.text.includes('thomas@reedlaw.example'))).toBe(true);
    const thomas = await sortOf('Re: Sponsorship application – reference number');
    expect(thomas).toMatchObject({ stream: 'screener', proposed_stream: 'people', layer: 'reasoning' });
    const { senders } = await service.screener(userId);
    const s = senders.find((x) => x.key === 'thomas@reedlaw.example');
    expect(s).toMatchObject({ scope: 'address', proposed: 'people', inSpam: false, count: 1 });
    expect(s.reason).toBeTruthy();
  });

  it('auto-screens confident senders, logs it, and undo sends their mail back to the Screener', async () => {
    const { rows: auto } = await query("SELECT * FROM hedwig_senders WHERE user_id = $1 AND key = 'sam.wilson@lettings.example' AND undone_at IS NULL", [userId]);
    expect(auto[0]).toMatchObject({ decision: 'people', source: 'auto' });
    const t = await service.today(userId);
    expect(t.screened).toBeGreaterThan(0);
    const entry = t.entries.find((e) => e.action === 'screen' && e.after.key === 'sam.wilson@lettings.example');
    expect(entry).toMatchObject({ undoable: true, text: 'Screened sam.wilson@lettings.example into People' });
    await service.undo(userId, { logId: entry.id });
    expect((await sortOf('Boiler inspection Thursday?')).stream).toBe('screener');
    await expect(service.undo(userId, { logId: entry.id })).rejects.toMatchObject({ status: 409 });
    // The user decides from the Screener instead.
    const res = await service.decide(userId, { key: 'sam.wilson@lettings.example', scope: 'address', decision: 'people' });
    expect(res.moved).toBe(1);
    expect((await sortOf('Boiler inspection Thursday?')).stream).toBe('people');
  });

  it('lists streams with cursors, Needs you first, and explains a decision', async () => {
    const first = await service.streamList(userId, 'people', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next).toBeTruthy();
    const second = await service.streamList(userId, 'people', { limit: 2, cursor: first.next });
    expect(second.items[0].messageId).not.toBe(first.items[0].messageId);
    expect(new Date(second.items[0].date) <= new Date(first.items[1].date)).toBe(true);
    const ny = await service.streamList(userId, 'people', { needsYou: true, limit: 50 });
    expect(ny.items.every((i) => i.needsYou)).toBe(true);
    expect(ny.items.map((i) => i.subject)).toEqual(expect.arrayContaining(['Re: Visa sponsorship — final documents by 30 Sep', 'Boiler inspection Thursday?']));
    const item = ny.items.find((i) => i.subject === 'Boiler inspection Thursday?');
    expect(item).toMatchObject({ threadId: expect.any(String), accountId: expect.any(String), unread: true, reason: 'Sam asks whether someone will be in on Thursday' });

    const why = await service.why(userId, bySubject.get('Money Stuff: The bond market is weird again'));
    expect(why).toMatchObject({ layer: 'reflex', promptId: 'sort.reflex', model: GEMMA, stream: 'reading', bundle: 'updates' });
    expect(why.signals.length).toBeGreaterThan(0);
    const reading = await service.streamList(userId, 'reading', { limit: 50, held: true });
    expect(reading.items.some((i) => i.bundle === 'updates')).toBe(true);
  });

  it('turns an "always" correction into a rule, dry-runs it, and undo reverses all of it', async () => {
    const id = bySubject.get('Money Stuff: Everything is securities fraud');
    const res = await service.correct(userId, { messageId: id, stream: 'records', bundle: 'finance', always: 'sender', note: 'I file these' });
    expect(res.sort).toMatchObject({ stream: 'records', bundle: 'finance', layer: 'user' });
    expect(res.ruleId).toBeTruthy();
    expect(res.correctionId).toBeTruthy();
    const { rows: corr } = await query('SELECT * FROM hedwig_corrections WHERE id = $1', [res.correctionId]);
    expect(corr[0]).toMatchObject({ kind: 'sort', target_id: id, note: 'I file these' });
    expect(corr[0].before.stream).toBe('reading');
    const { rows: dec } = await query("SELECT * FROM hedwig_senders WHERE user_id = $1 AND key = 'newsletter@moneystuff.example' AND undone_at IS NULL", [userId]);
    expect(dec[0]).toMatchObject({ decision: 'records', source: 'user' });
    const dry = await service.dryRunRule(userId, res.ruleId, {});
    expect(dry.matched).toBeGreaterThanOrEqual(6);
    expect(dry.sample[0].from.email).toBe('newsletter@moneystuff.example');
    const { rules } = await service.rules(userId);
    expect(rules.find((r) => r.id === res.ruleId)).toMatchObject({ source: 'correction', created_from_correction_id: String(res.correctionId) });

    // The next Reflex prompt carries the correction as an example.
    const other = await query("SELECT id FROM messages WHERE subject = 'The Batch: new open-weight models'");
    await query("UPDATE hedwig_sort SET pending = 'reflex' WHERE message_id = $1", [other.rows[0].id]);
    await engine.runReflexJob({ messageIds: [other.rows[0].id] }, { user_id: userId });
    expect(gw.callsFor('sort.reflex').at(-1).text).toContain('the user chose records/finance (I file these)');

    // A rule the user made sorts new mail from that sender before any model is asked.
    await engine.resortMessages(userId, [bySubject.get('Money Stuff: The bond market is weird again')]);
    expect(await sortOf('Money Stuff: The bond market is weird again')).toMatchObject({ layer: 'rule', stream: 'records', bundle: 'finance' });

    await service.undo(userId, { logId: res.logId });
    expect(await sortOf('Money Stuff: Everything is securities fraud')).toMatchObject({ stream: 'reading', bundle: 'updates' });
    expect((await query('SELECT 1 FROM hedwig_rules WHERE id = $1', [res.ruleId])).rows).toHaveLength(0);
    const { rows: after } = await query("SELECT * FROM hedwig_senders WHERE user_id = $1 AND key = 'newsletter@moneystuff.example' AND undone_at IS NULL", [userId]);
    expect(after[0]?.source).not.toBe('user');
    // The sender's other mail left Records with the rule.
    const bond = await sortOf('Money Stuff: The bond market is weird again');
    expect(bond.stream).not.toBe('records');
    expect(bond.rule_id).toBeNull();
  });

  it('delivers scheduled bundles and makes custom bundles from a description', async () => {
    const { rows: b } = await query("SELECT * FROM hedwig_bundles WHERE user_id = $1 AND key = 'updates'", [userId]);
    expect(b[0].schedule).toEqual({ mode: 'daily', at: '08:00' });
    const id = bySubject.get('The Batch: new open-weight models');
    await query('UPDATE hedwig_sort SET held = true WHERE message_id = $1', [id]);
    expect((await service.streamList(userId, 'reading', { limit: 100 })).items.some((i) => i.messageId === id)).toBe(false);
    await query("UPDATE hedwig_bundles SET last_delivered_at = NOW() - INTERVAL '3 days' WHERE id = $1", [b[0].id]);
    expect(await bundles.releaseDueBundles(new Date())).toBeGreaterThanOrEqual(1);
    expect((await sortOf('The Batch: new open-weight models')).held).toBe(false);
    const { rows: del } = await query('SELECT * FROM hedwig_bundle_deliveries WHERE bundle_id = $1', [b[0].id]);
    expect(del[0].message_ids).toContain(id);

    const created = await service.addBundle(userId, { name: 'School', description: 'Anything from the kids’ school', schedule: { mode: 'weekly', day: 5, at: '18:00' } });
    expect(created.bundle).toMatchObject({ key: 'kids-school', stream: 'records', builtin: false, schedule: { mode: 'weekly', day: 5, at: '18:00' } });
    expect(created.bundle.keywords).toContain('parents evening');
    expect(created.promptId).toBe('sort.bundleDescribe');
    const list = await service.bundles(userId);
    expect(list.bundles.map((x) => x.key)).toEqual(expect.arrayContaining(['purchases', 'finance', 'travel', 'deliveries', 'social', 'updates', 'promotions', 'forums', 'calendar', 'kids-school']));
  });

  it('rescues legitimate mail from the spam folder and leaves the rest', async () => {
    const workAccount = (await query("SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = 'prakhar@vantage.example'", [userId])).rows[0].id;
    const mk = async (account, fromName, fromEmail, to, subject, body) => {
      const id = randomUUID();
      inserted.push(id);
      await query(
        `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_name, from_email, to_addresses, date, snippet, body_text)
         VALUES ($1, $2, $3, 'Junk', $4, $5, $6, $7, $8, NOW() - INTERVAL '2 hours', $9, $9)`,
        [id, account, 900000 + inserted.length, `<${id}@hedwig.test>`, subject, fromName, fromEmail, JSON.stringify([{ address: to }]), body],
      );
      return id;
    };
    const legit = await mk(workAccount, 'Priya Nair', 'priya.nair@vantage.example', 'prakhar@vantage.example', 'Offsite agenda', 'Hi Prakhar, can you review the offsite agenda before Friday?');
    const lure = await mk(personalAccount, 'PayPal', 'service@paypa1.com', 'prakhar.demo@gmail.com', 'Your account is limited', 'Please verify your account at https://paypa1-secure.example/login or it will be suspended.');
    const n = await engine.rescueSweep({ userIds: [userId] });
    expect(n).toBeGreaterThanOrEqual(1);
    const { rows } = await query('SELECT message_id, stream, spam, spam_reason, in_spam_folder FROM hedwig_sort WHERE message_id = ANY($1::uuid[])', [[legit, lure]]);
    const by = new Map(rows.map((r) => [r.message_id, r]));
    expect(by.get(legit)).toMatchObject({ spam: 'rescued', stream: 'people', in_spam_folder: true });
    expect(by.get(lure)).toMatchObject({ stream: 'spam', in_spam_folder: true });
    expect(['phishing', 'suspected']).toContain(by.get(lure).spam);
    const t = await service.today(userId);
    expect(t.rescued).toBeGreaterThanOrEqual(1);
    const spamList = await service.streamList(userId, 'spam', { limit: 50 });
    expect(spamList.items.map((i) => i.messageId)).toContain(lure);
    expect(spamList.items.map((i) => i.messageId)).not.toContain(legit);
  });
});
