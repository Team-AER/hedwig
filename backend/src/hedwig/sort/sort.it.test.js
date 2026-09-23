// Integration test against the seeded dev database (backend/.env.hedwig-dev, node scripts/hedwig-seed.mjs).
//   set -a; . ./.env.hedwig-dev; set +a; HEDWIG_IT=1 npx vitest run src/hedwig/sort
// Sorts the demo mailbox end to end: pipeline rows → cheap layers → sort.reflex jobs answered by the
// mock gateway → auto-screen, screener, corrections with rules, today + undo, bundles, spam rescue.
// It never calls the live gateway. It leaves a sorted demo mailbox behind for UI work.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { mockGateway } from '../testing/mockGateway.js';

import { engineStamp } from './version.js';
import { fnv1a } from '../triage/features.js';

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
        await query("UPDATE hedwig_jobs SET done_at = NOW(), status = 'done' WHERE id = $1", [job.id]);
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

    // A newsletter is settled by its list headers (Tier 0): no model, and the engine that decided it.
    const why = await service.why(userId, bySubject.get('Money Stuff: The bond market is weird again'));
    expect(why).toMatchObject({ layer: 'rule', promptId: null, model: null, stream: 'reading', bundle: 'updates', reason: 'A newsletter or mailing list (List-Unsubscribe header)', engineVersion: engineStamp(), pending: null });
    expect(why.signals.length).toBeGreaterThan(0);
    const { rows: [judged] } = await query("SELECT message_id FROM hedwig_sort WHERE user_id = $1 AND layer = 'reflex' LIMIT 1", [userId]);
    const byModel = await service.why(userId, judged.message_id);
    expect(byModel).toMatchObject({ layer: 'reflex', promptId: 'sort.reflex', promptVersion: expect.any(String), model: GEMMA, engineVersion: engineStamp() });
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

    // The next Reflex prompt carries the correction as an example (a message the headers do not settle).
    const other = bySubject.get('Re: Sponsorship application – reference number');
    await query("UPDATE hedwig_sort SET pending = 'reflex' WHERE message_id = $1", [other]);
    await engine.runReflexJob({ messageIds: [other] }, { user_id: userId });
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
    expect(n.rescued).toBeGreaterThanOrEqual(1);
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

  it('re-judges spam-folder mail already stored as suspected, records the sweep, and clears false phishing on re-evaluation', async () => {
    const workAccount = (await query("SELECT id FROM email_accounts WHERE user_id = $1 AND email_address = 'prakhar@vantage.example'", [userId])).rows[0].id;
    const mk = async (folder, fromName, fromEmail, subject, body, to = 'prakhar@vantage.example') => {
      const id = randomUUID();
      inserted.push(id);
      await query(
        `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_name, from_email, to_addresses, date, snippet, body_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() - INTERVAL '3 hours', $10, $10)`,
        [id, workAccount, 910000 + inserted.length, folder, `<${id}@hedwig.test>`, subject, fromName, fromEmail, JSON.stringify([{ address: to }]), body],
      );
      return id;
    };
    // What production had after the first night: the classifier stored it as suspected before rescue saw it.
    const known = await mk('Junk', 'Priya Nair', 'priya.nair@vantage.example', 'Revised offsite budget', 'Hi Prakhar, could you sign off the revised budget today?');
    await query(
      `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, spam, spam_reason, confidence, layer, reason, signals, in_spam_folder, decided_at)
       VALUES ($1, $2, $3, 'spam', 'suspected', 'Your provider filed this as spam', 0.82, 'classifier', 'A person writing to you', '[]'::jsonb, true, NOW() - INTERVAL '1 hour')`,
      [known, userId, workAccount],
    );
    // A false phishing flag from the old signals: the sender's own brand on another suffix.
    const brand = await mk('INBOX', 'Vantage HR', 'hr@vantage.email', 'Benefits window opens Monday', 'The benefits window opens on Monday. Details on the intranet.');
    await query(
      `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, spam, spam_reason, confidence, layer, reason, signals, in_spam_folder, decided_at)
       VALUES ($1, $2, $3, 'spam', 'phishing', 'Sender domain vantage.email looks like vantage.example', 0.72, 'classifier', 'Sender domain vantage.email looks like vantage.example', '[]'::jsonb, false, NOW() - INTERVAL '1 hour')`,
      [brand, userId, workAccount],
    );

    // The evidence queries run against the real schema (sent mail To/Cc, not-spam marks and labels).
    const warned = [];
    const warn = console.warn;
    console.warn = (...a) => { warned.push(a.join(' ')); };
    let ev;
    try {
      ev = await engine.rescueEvidence(userId, ['priya.nair@vantage.example', 'nobody@nowhere.example'], new Set(['prakhar@vantage.example', 'me@prafiles.example', 'prakhar.demo@gmail.com']));
    } finally {
      console.warn = warn;
    }
    expect(warned).toEqual([]);
    expect(ev.get('priya.nair@vantage.example').wroteTo).toBeGreaterThanOrEqual(1);
    expect(ev.get('nobody@nowhere.example')).toEqual({ wroteTo: 0, notSpam: 0 });

    const res = await engine.rescueSweep({ userIds: [userId] });
    expect(res.scanned).toBeGreaterThanOrEqual(1);
    const row = (await query('SELECT * FROM hedwig_sort WHERE message_id = $1', [known])).rows[0];
    expect(row).toMatchObject({ spam: 'rescued', in_spam_folder: true });
    expect(row.stream).not.toBe('spam');
    expect(row.signals[0]).toMatchObject({ name: 'rescue' });
    const { rows: st } = await query("SELECT value FROM hedwig_state WHERE key = 'schedule.sort.rescue'");
    expect(st[0].value).toMatchObject({ at: expect.any(String), scanned: expect.any(Number), rescued: expect.any(Number) });
    // Judged once: the next sweep does not pick it up again.
    const again = await engine.rescueSweep({ userIds: [userId] });
    expect(again.scanned).toBe(0);

    const out = await engine.runReevaluateSpamJob({}, { user_id: userId });
    expect(out.checked).toBeGreaterThanOrEqual(2);
    const fixed = (await query('SELECT spam, stream, spam_reason FROM hedwig_sort WHERE message_id = $1', [brand])).rows[0];
    expect(fixed.spam).not.toBe('phishing');
    expect(fixed.stream).not.toBe('spam');
    const { rows: ver } = await query('SELECT value FROM hedwig_state WHERE key = $1', [`spam.signalsVersion:${userId}`]);
    expect(ver[0].value).toMatchObject({ doneAt: expect.any(String) });
    expect((await query('SELECT spam FROM hedwig_sort WHERE message_id = $1', [known])).rows[0].spam).toBe('rescued');
  });

  // ── v2 sort audit (2026-09-24) ────────────────────────────────────────────

  it('sorts a newsletter from a sender you once wrote to into Reading by its headers, with no model call', async () => {
    await query(
      `INSERT INTO hedwig_senders (user_id, key, scope, decision, source, confidence, reason)
       VALUES ($1, 'info@the-ken.example', 'address', 'people', 'import', 0.95, 'You have written to them')
       ON CONFLICT (user_id, scope, key) WHERE undone_at IS NULL DO NOTHING`,
      [userId],
    );
    const id = randomUUID();
    inserted.push(id);
    await query(
      `INSERT INTO messages (id, account_id, uid, folder, message_id, subject, from_name, from_email, to_addresses, date, snippet, body_text, is_bulk, list_unsubscribe, category)
       VALUES ($1, $2, 930001, 'INBOX', $3, 'Rakesh Biyani takes the fight to Zudio', 'The Ken', 'info@the-ken.example', $4, NOW() - INTERVAL '1 hour', 'Hi Prakhar', $5, true, '<mailto:u@the-ken.example>', 'newsletter')`,
      [id, personalAccount, `<${id}@hedwig.test>`, JSON.stringify([{ address: 'prakhar.demo@gmail.com' }]), 'Hi Prakhar,\n\nGood morning. Rakesh Biyani is back, and this time he wants to beat Zudio at its own game.'],
    );
    const before = gw.callsFor('sort.reflex').length;
    const res = await engine.sortRows(await loadRows('m.id = $2', [id]));
    expect(res.reflex).toBe(0);
    const { rows } = await query('SELECT * FROM hedwig_sort WHERE message_id = $1', [id]);
    expect(rows[0]).toMatchObject({ stream: 'reading', layer: 'rule', pending: null, engine_version: engineStamp(), reason: 'A newsletter or mailing list (List-Unsubscribe header)' });
    expect(gw.callsFor('sort.reflex').length).toBe(before);
  });

  it('rebuilds Reflex work from the data: a failed job is re-enqueued by the sweep and reconciled once it succeeds', async () => {
    const jobs = await import('../jobs.js');
    const id = bySubject.get('Follow-up appointment options');
    // What production had: the row waits for Reflex and its only job failed for good on a full lane.
    await query("UPDATE hedwig_sort SET pending = 'reflex', layer = 'classifier', prompt_id = NULL, model = NULL WHERE message_id = $1", [id]);
    await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind = 'sort.reflex' AND done_at IS NULL", [userId]);
    const key = `sort.reflex:${fnv1a(id)}`;
    const { rows: f } = await query(
      `INSERT INTO hedwig_jobs (kind, payload, user_id, dedupe_key, status, attempts, max_attempts, failed_at, last_error)
       VALUES ('sort.reflex', $1, $2, $3, 'failed', 3, 3, NOW() - INTERVAL '1 hour', 'the background model lane stayed full for 240 s') RETURNING id`,
      [JSON.stringify({ messageIds: [id] }), userId, key],
    );
    expect(await engine.reflexPayloads(userId, { 'sort.batchSize': 5, 'sort.reflexMaxAgeDays': 14 })).toEqual(expect.arrayContaining([{ messageIds: [id] }]));
    const sweep = await engine.reflexSweep({ userIds: [userId] });
    expect(sweep.enqueued).toBeGreaterThanOrEqual(1);
    const { rows: queued } = await query("SELECT * FROM hedwig_jobs WHERE user_id = $1 AND kind = 'sort.reflex' AND done_at IS NULL AND failed_at IS NULL", [userId]);
    expect(queued.find((j) => j.dedupe_key === key)?.payload).toEqual({ messageIds: [id] });
    // A second sweep while that job is live adds nothing for this row.
    await engine.reflexSweep({ userIds: [userId] });
    const { rows: again } = await query("SELECT COUNT(*)::int AS n FROM hedwig_jobs WHERE user_id = $1 AND kind = 'sort.reflex' AND done_at IS NULL AND failed_at IS NULL AND payload->'messageIds' ? $2", [userId, id]);
    expect(again[0].n).toBe(1);
    await drainReflexJobs();
    expect(await sortOf('Follow-up appointment options')).toMatchObject({ layer: 'reflex', pending: null, model: GEMMA, engine_version: engineStamp() });
    await jobs.reconcile();
    const { rows: old } = await query('SELECT status FROM hedwig_jobs WHERE id = $1', [f[0].id]);
    expect(old[0].status).toBe('resolved');
  });

  it('re-sorts once per user when the engine version changes, with Reflex for recent mail', async () => {
    await query("UPDATE hedwig_sort SET engine_version = 'old-engine' WHERE user_id = $1 AND layer <> 'user'", [userId]);
    await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind = 'sort.resort'", [userId]);
    await query('DELETE FROM hedwig_state WHERE key = $1', [`sort.engineVersion:${userId}`]);
    const out = await engine.ensureSortEngineCurrent({ userIds: [userId] });
    expect(out).toEqual({ version: engineStamp(), enqueued: 1 });
    const { rows: [job] } = await query("SELECT * FROM hedwig_jobs WHERE user_id = $1 AND kind = 'sort.resort' AND done_at IS NULL", [userId]);
    expect(job.payload).toEqual({ engine: engineStamp(), allowReflex: true, sinceDays: null });
    let payload = job.payload;
    for (let i = 0; i < 20 && payload; i++) {
      const res = await engine.runResortJob(payload, { user_id: userId });
      const { rows: next } = await query("SELECT * FROM hedwig_jobs WHERE user_id = $1 AND kind = 'sort.resort' AND done_at IS NULL AND payload->>'cursor' IS NOT NULL ORDER BY id DESC LIMIT 1", [userId]);
      payload = res.continued ? next[0].payload : null;
    }
    await drainReflexJobs();
    const { rows: left } = await query(
      "SELECT COUNT(*)::int AS n FROM hedwig_sort WHERE user_id = $1 AND layer NOT IN ('user') AND NOT own AND engine_version IS DISTINCT FROM $2",
      [userId, engineStamp()],
    );
    expect(left[0].n).toBe(0);
    const { rows: st } = await query('SELECT value FROM hedwig_state WHERE key = $1', [`sort.engineVersion:${userId}`]);
    expect(st[0].value).toMatchObject({ version: engineStamp(), doneAt: expect.any(String) });
  });
});
