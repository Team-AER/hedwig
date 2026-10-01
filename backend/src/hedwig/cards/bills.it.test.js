// Bills over the demo mailbox (scripts/hedwig-seed.mjs): charges named two ways are one payee and a
// monthly bill, a card alert's currency is read from its sentence, a deposit is money in, a card whose
// mail moved to Trash is pointed at the moved copy, Trash mail about money is fetched and read, and
// the owner's Track / Not a bill (with their undos) hold.
//   set -a && . ./.env.hedwig-dev && set +a && HEDWIG_IT=1 npx vitest run src/hedwig/cards/bills.it.test.js --maxWorkers=1
// Adds its own messages (removed afterwards) and removes the demo user's cards when done.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

const NOW = (() => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0); })();
const DAY_MS = 86400_000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const ddmmyy = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)}`; };
const TRASH = '[Gmail]/Trash';

describe.skipIf(!process.env.HEDWIG_IT)('bills over the demo mailbox', () => {
  let query; let pool; let userId; let accountId; let config;
  let extract; let store; let bills; let ledgerMod;
  const gw = mockGateway();
  const added = [];
  const ids = {};
  let trashFolderAdded = false;
  const ENV = ['HEDWIG_LLM_BASE_URL', 'HEDWIG_LLM_CATALOG_URL', 'HEDWIG_LLM_FALLBACK_MODEL'];
  const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  const addMessage = async (key, { subject, from, fromName, body = null, daysAgo = 1, folder = 'INBOX', sorted = true }) => {
    const { rows } = await query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, from_name, from_email, sender_email, to_addresses, date, snippet, body_text)
       VALUES ($1, (SELECT COALESCE(MAX(uid), 0) + 1 FROM messages WHERE account_id = $1), $2, $3, $4, $5, $6, $6, '[]',
               $8::timestamptz - make_interval(days => $7), $9, $10)
       RETURNING id`,
      [accountId, folder, `<bills-it-${key}-${Date.now()}@hedwig.test>`, subject, fromName, from, daysAgo, new Date(NOW), body ? body.slice(0, 100) : null, body],
    );
    const id = rows[0].id;
    added.push(id);
    ids[key] = id;
    if (sorted) {
      await query(
        `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, bundle, layer, reason) VALUES ($1, $2, $3, 'records', 'finance', 'rule', 'bills IT')
         ON CONFLICT (message_id) DO NOTHING`,
        [id, userId, accountId],
      );
    }
    return id;
  };
  const receipt = (key, fields, quotes) => store.upsertCard(userId, {
    kind: 'receipt', messageId: ids[key], fields, layer: 'reflex', confidence: 0.9,
    sources: Object.fromEntries(Object.entries(quotes).map(([k, q]) => [k, { via: 'reflex', quote: q, messageId: ids[key] }])),
  }, { messageDate: new Date(NOW) });
  const cardOf = async (key) => (await query('SELECT * FROM hedwig_cards WHERE user_id = $1 AND $2 = ANY(message_ids) AND kind = $3', [userId, ids[key], 'receipt'])).rows[0];

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    config = await import('../config.js');
    const u = await query("SELECT id FROM users WHERE username = 'demo'");
    if (!u.rows.length) throw new Error('demo user missing: run node scripts/hedwig-seed.mjs');
    userId = u.rows[0].id;
    accountId = (await query("SELECT id FROM email_accounts WHERE user_id = $1 AND email_address LIKE '%gmail%'", [userId])).rows[0].id;
    process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
    process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;
    process.env.HEDWIG_LLM_FALLBACK_MODEL = '';
    config.invalidateConfigCache();
    gw.install();
    gw.on('cards.extract', () => ({ items: [] }));
    await query('DELETE FROM hedwig_cards WHERE user_id = $1', [userId]);
    await query('DELETE FROM hedwig_card_feedback WHERE user_id = $1', [userId]);
    const f = await query(
      `INSERT INTO folders (account_id, path, name, special_use) VALUES ($1, $2, 'Trash', '\\Trash') ON CONFLICT (account_id, path) DO NOTHING RETURNING id`,
      [accountId, TRASH],
    );
    trashFolderAdded = f.rows.length > 0;
    extract = await import('./extract.js');
    store = await import('./store.js');
    bills = await import('./bills.js');
    ledgerMod = await import('./ledger.js');

    await addMessage('anth1', { subject: 'Your receipt from Anthropic, PBC #2031-9682-9224', from: 'invoice+statements@mail.anthropic.example', fromName: 'Anthropic, PBC', body: 'Amount paid $236.00\nClaude Max plan', daysAgo: 55 });
    await addMessage('alert', { subject: 'A payment was made using your Credit Card', from: 'alerts@bank.example', fromName: 'Bank Alerts', body: `Dear Customer, USD 236 spent at ANTHROPIC on ${ddmmyy(NOW - 25 * DAY_MS)} at 12:52:11 PM. Not you? Call us.`, daysAgo: 25 });
    await addMessage('openai', { subject: 'A payment was made using your Credit Card', from: 'alerts@bank.example', fromName: 'Bank Alerts', body: 'Dear Customer, USD 40 spent at OPENAI. Not you? Call us.', daysAgo: 3 });
    await addMessage('deposit', { subject: 'New Deposit Alert', from: 'alerts@bank.example', fromName: 'Bank Alerts', body: 'Amount received: INR 11,568.00. Interest paid till today.', daysAgo: 2 });
    await receipt('anth1', { merchant: 'Anthropic, PBC', total: 236, currency: 'USD', date: isoDay(NOW - 55 * DAY_MS) }, { total: 'Amount paid $236.00', merchant: 'Your receipt from Anthropic, PBC' });
    await receipt('alert', { merchant: 'ANTHROPIC', total: 236, date: isoDay(NOW - 25 * DAY_MS) },
      { total: 'USD 236 spent at ANTHROPIC', merchant: 'USD 236 spent at ANTHROPIC', date: `on ${ddmmyy(NOW - 25 * DAY_MS)} at 12:52:11 PM` });
    await receipt('openai', { merchant: 'OPENAI', total: 40, date: isoDay(NOW - 3 * DAY_MS) }, { total: 'USD 40 spent at OPENAI' });
    await receipt('deposit', { merchant: 'HDFC Bank', total: 11568, currency: 'INR', date: isoDay(NOW - 2 * DAY_MS) }, { total: 'Amount received: INR 11,568.00' });
  }, 60_000);

  afterAll(async () => {
    gw.restore();
    for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    config.invalidateConfigCache();
    await query("DELETE FROM hedwig_corrections WHERE user_id = $1 AND kind = 'card'", [userId]).catch(() => {});
    await query('DELETE FROM hedwig_card_feedback WHERE user_id = $1', [userId]).catch(() => {});
    await query('DELETE FROM hedwig_cards WHERE user_id = $1', [userId]).catch(() => {});
    await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind IN ('cards.extract', 'cards.fetchIcs')", [userId]).catch(() => {});
    if (added.length) {
      await query("DELETE FROM hedwig_jobs WHERE dedupe_key = ANY($1::text[])", [added.map((id) => `body:${id}`)]).catch(() => {});
      await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [added]);
    }
    if (trashFolderAdded) await query('DELETE FROM folders WHERE account_id = $1 AND path = $2', [accountId, TRASH]);
    await pool?.end();
  });

  it('two charges named two ways are one monthly bill; one charge from a known service is a question', async () => {
    const view = await bills.bills(userId, { now: new Date(NOW) });
    const anthropic = view.bills.find((b) => b.payee === 'anthropic');
    expect(anthropic).toMatchObject({ currency: 'USD', cadence: 'monthly', amount: 236, charges: 2 });
    expect(anthropic.nextDue > isoDay(NOW)).toBe(true);
    expect(view.candidates.map((c) => c.payee)).toContain('openai');
    expect([...view.bills, ...view.candidates].some((b) => b.payee === 'hdfc bank')).toBe(false);
    const detail = await bills.billDetail(userId, 'anthropic', { now: new Date(NOW) });
    expect(detail.charges.map((c) => c.merchant)).toEqual(['ANTHROPIC', 'Anthropic, PBC']);
    // The card alert's currency is the one its amount's sentence states, kept on the card.
    expect(detail.charges[0]).toMatchObject({ currency: 'USD', messageId: ids.alert, missing: false });
    expect((await cardOf('alert')).fields.currency).toBe('USD');
  });

  it('Purchases: the currency comes from the sentence, a deposit is received and not spent', async () => {
    const l = await ledgerMod.ledger(userId, 'purchases');
    expect(l.rows.find((r) => r.merchant === 'ANTHROPIC')).toMatchObject({ currency: 'USD', payee: 'anthropic', missing: false });
    expect(l.rows.find((r) => r.merchant === 'HDFC Bank')).toMatchObject({ status: 'received', direction: 'in' });
    expect(l.totals.find((t) => t.currency === 'INR')).toBeUndefined();
    expect(l.totals.find((t) => t.currency === 'USD')).toMatchObject({ total: 512, count: 3 });
  });

  it('a card whose mail moved to Trash points at the moved copy when the copy is read', async () => {
    const before = await cardOf('alert');
    const body = (await query('SELECT body_text FROM messages WHERE id = $1', [ids.alert])).rows[0].body_text;
    // Upstream's move: the row goes, the copy in Trash is a new row with a new id.
    await query('DELETE FROM messages WHERE id = $1', [ids.alert]);
    expect((await query('SELECT message_id FROM hedwig_cards WHERE id = $1', [before.id])).rows[0].message_id).toBeNull();
    const copy = await addMessage('alertTrash', { subject: 'A payment was made using your Credit Card', from: 'alerts@bank.example', fromName: 'Bank Alerts', body, daysAgo: 25, folder: TRASH, sorted: false });
    const res = await extract.runCardsJob({ userId, messageIds: [copy] }, { now: new Date(NOW) });
    expect(res.note).toMatch(/1 cards relinked/);
    const after = (await query('SELECT message_id, dedupe_key, sources FROM hedwig_cards WHERE id = $1', [before.id])).rows[0];
    expect(after.message_id).toBe(copy);
    expect(after.dedupe_key).toBe(`msg:${copy}`);
    expect(after.sources.total.messageId).toBe(copy);
  });

  it('Trash mail about money is fetched first and read; other Trash mail is looked at once', async () => {
    const money = await addMessage('trashReceipt', { subject: 'Your receipt from OpenAI', from: 'billing@openai.example', fromName: 'OpenAI', body: null, daysAgo: 1, folder: TRASH, sorted: false });
    const news = await addMessage('trashNews', { subject: 'OpenAI ships a new model', from: 'news@openai.example', fromName: 'OpenAI News', body: null, daysAgo: 1, folder: TRASH, sorted: false });
    await extract.scanTick();
    const scans = Object.fromEntries((await query('SELECT message_id, state FROM hedwig_cards_scan WHERE message_id = ANY($1::uuid[])', [[money, news]])).rows.map((r) => [r.message_id, r.state]));
    expect(scans[news]).toBe('done');
    expect(scans[money]).toBe('waiting');
    await extract.runCardsJob({ userId, messageIds: [money] }, { now: new Date(NOW) });
    expect((await query('SELECT 1 FROM hedwig_jobs WHERE dedupe_key = $1', [`body:${money}`])).rows.length).toBe(1);
    expect((await query('SELECT state FROM hedwig_cards_scan WHERE message_id = $1', [money])).rows[0].state).toBe('waiting');
  });

  it('Track and Untrack, Not a bill and Restore', async () => {
    const tracked = await bills.trackBill(userId, 'openai', { cadence: 'monthly' }, { now: new Date(NOW) });
    expect(tracked.bills[0]).toMatchObject({ payee: 'openai', cadence: 'monthly', layer: 'user', currency: 'USD' });
    expect((await bills.bills(userId, { now: new Date(NOW) })).candidates.some((c) => c.payee === 'openai')).toBe(false);
    await bills.untrackBill(userId, 'openai');
    expect((await bills.bills(userId, { now: new Date(NOW) })).candidates.some((c) => c.payee === 'openai')).toBe(true);

    await bills.notBill(userId, 'anthropic');
    let view = await bills.bills(userId, { now: new Date(NOW) });
    expect([...view.bills, ...view.candidates].some((b) => b.payee === 'anthropic')).toBe(false);
    expect((await query("SELECT 1 FROM hedwig_card_feedback WHERE user_id = $1 AND verdict = 'not_recurring' AND merchant_key = 'anthropic'", [userId])).rows.length).toBe(1);
    await bills.restoreBill(userId, 'anthropic');
    view = await bills.bills(userId, { now: new Date(NOW) });
    expect(view.bills.some((b) => b.payee === 'anthropic')).toBe(true);
  });

  it('the finder keeps one subscription card per payee', async () => {
    await extract.syncSubscriptions(userId, { now: new Date(NOW) });
    const { rows } = await query("SELECT dedupe_key, fields FROM hedwig_cards WHERE user_id = $1 AND kind = 'subscription' AND layer = 'derived' AND dismissed_at IS NULL", [userId]);
    expect(rows.map((r) => r.dedupe_key)).toEqual(['merchant:anthropic:USD']);
    expect(rows[0].fields).toMatchObject({ cadence: 'monthly', amount: 236, currency: 'USD', charges: 2 });
  });
});
