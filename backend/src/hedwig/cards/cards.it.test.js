// Cards over the demo mailbox (scripts/hedwig-seed.mjs) with the mock gateway: deterministic
// detectors, Reflex extraction with quote checks, delivery refresh, subscriptions, ledger, Today,
// edits (corrections), dismissals, the commitments view and the Brief.
//   set -a && . ./.env.hedwig-dev && set +a && HEDWIG_IT=1 npx vitest run src/hedwig/cards
// Adds its own messages (removed afterwards) and removes the demo user's cards when done.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';
import * as F from './fixtures.testutil.js';

// One clock for the whole file: noon UTC today (the test runs Today in UTC). Messages are dated
// against it and every "now" the code takes is given it, so "30 minutes ago" is today and "tomorrow"
// is tomorrow whatever the wall clock says (a run just after midnight UTC used to put the DHL
// update on yesterday), and fixture dates are moved relative to it instead of being fixed days.
const NOW = (() => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0); })();
const DAY_MS = 86400_000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const icsDay = (t) => isoDay(t).replace(/-/g, '');
// F.ORDER_JSONLD says the Posten parcel arrives on 2026-09-24 (fixed, for the unit tests): here it
// was ordered three days ago and arrives in three days, so it is never also "arriving today".
const ORDER_JSONLD = F.ORDER_JSONLD
  .replace(/"orderDate": "\d{4}-\d{2}-\d{2}T/, `"orderDate": "${isoDay(NOW - 3 * DAY_MS)}T`)
  .replace(/"expectedArrivalUntil": "\d{4}-\d{2}-\d{2}T/, `"expectedArrivalUntil": "${isoDay(NOW + 3 * DAY_MS)}T`);
if (!ORDER_JSONLD.includes(`"expectedArrivalUntil": "${isoDay(NOW + 3 * DAY_MS)}T`)) throw new Error('ORDER_JSONLD fixture changed shape');

describe.skipIf(!process.env.HEDWIG_IT)('cards over the demo mailbox', () => {
  let query; let pool; let userId; let accountId; let config;
  let extract; let store; let ledgerMod; let todayMod; let briefing;
  const gw = mockGateway();
  const added = [];
  const ids = {};
  const ENV = ['HEDWIG_LLM_BASE_URL', 'HEDWIG_LLM_CATALOG_URL', 'HEDWIG_LLM_FALLBACK_MODEL', 'HEDWIG_INSIGHTS_TIMEZONE'];
  const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  const addMessage = async (key, { subject, from, fromName, body = null, html = null, minutesAgo = 60, bundle = null, stream = 'records' }) => {
    const { rows } = await query(
      `INSERT INTO messages (account_id, uid, folder, message_id, subject, from_name, from_email, sender_email, to_addresses, date, snippet, body_text, body_html)
       VALUES ($1, (SELECT COALESCE(MAX(uid), 0) + 1 FROM messages WHERE account_id = $1), 'INBOX', $2, $3, $4, $5, $5, '[]',
               $9::timestamptz - make_interval(mins => $6), LEFT(COALESCE($7, $3), 100), $7, $8)
       RETURNING id, date`,
      [accountId, `<cards-it-${key}-${Date.now()}@hedwig.test>`, subject, fromName, from, minutesAgo, body, html, new Date(NOW)],
    );
    const id = rows[0].id;
    added.push(id);
    ids[key] = id;
    await query(
      `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, bundle, layer, reason) VALUES ($1, $2, $3, $4, $5, 'rule', 'cards IT')
       ON CONFLICT (message_id) DO UPDATE SET bundle = EXCLUDED.bundle, stream = EXCLUDED.stream`,
      [id, userId, accountId, stream, bundle],
    );
    return id;
  };

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
    process.env.HEDWIG_INSIGHTS_TIMEZONE = 'UTC';
    config.invalidateConfigCache();
    gw.install();
    await query('DELETE FROM hedwig_cards WHERE user_id = $1', [userId]);
    extract = await import('./extract.js');
    store = await import('./store.js');
    ledgerMod = await import('./ledger.js');
    todayMod = await import('./today.js');
    briefing = await import('../insights/briefing.js');

    await addMessage('order', { subject: 'Order confirmation NO-448120', from: 'orders@nordicoutdoor.example', fromName: 'Nordic Outdoor', html: ORDER_JSONLD, bundle: 'purchases', minutesAgo: 3 * 1440 });
    await addMessage('dhl1', { subject: 'Your DHL shipment has been dispatched', from: 'noreply@dhl.example', fromName: 'DHL Express', body: 'Your shipment with waybill number 5566778899 has been dispatched. Track your shipment online.', bundle: 'deliveries', minutesAgo: 2 * 1440 });
    await addMessage('dhl2', { subject: 'Your DHL shipment is out for delivery', from: 'noreply@dhl.example', fromName: 'DHL Express', body: 'Your shipment with waybill number 5566778899 is out for delivery today. Expected delivery: today by 16:00.', bundle: 'deliveries', minutesAgo: 30 });
    await addMessage('otp', { ...F.OTP_MAIL, from: F.OTP_MAIL.from_email, fromName: F.OTP_MAIL.from_name, body: F.OTP_MAIL.body_text, bundle: null, stream: 'people', minutesAgo: 2 });
    await addMessage('ics', { subject: 'Invitation: team dinner', from: 'anna@example.test', fromName: 'Anna', body: F.ICS_ALLDAY.replace('20261012', icsDay(NOW + DAY_MS)).replace('20261015', icsDay(NOW + 2 * DAY_MS)), bundle: 'calendar', minutesAgo: 90 });
    await addMessage('uber', { subject: 'Your Tuesday evening trip with Uber', from: 'receipts@uber.example', fromName: 'Uber Receipts', body: 'Thanks for riding, Prakhar.\nTotal £23.40\nPaid with Visa ••4242.', bundle: 'purchases', minutesAgo: 600 });
    await addMessage('promo', { subject: '20% off everything', from: 'deals@shop.example', fromName: 'Shop', body: 'Big sale this weekend only.', bundle: 'promotions', stream: 'reading', minutesAgo: 700 });
    for (const [i, daysAgo] of [95, 64, 34, 4].entries()) {
      await addMessage(`netflix${i}`, {
        subject: 'Your Netflix receipt', from: 'info@netflix.example', fromName: 'Netflix',
        html: `<script type="application/ld+json">{"@context":"http://schema.org","@type":"Order","merchant":{"@type":"Organization","name":"Netflix"},"orderNumber":"NF-${i}","orderDate":"${isoDay(NOW - daysAgo * DAY_MS)}","price":"139","priceCurrency":"NOK"}</script>`,
        bundle: 'purchases', minutesAgo: daysAgo * 1440,
      });
    }
    gw.on('cards.extract', (req) => {
      const idFor = (subject) => (req.text.match(new RegExp(`### (m\\d+)\\nFrom: [^\\n]*\\nDate: [^\\n]*\\nSubject: ${subject}`)) || [])[1];
      const items = [];
      const uber = idFor('Your Tuesday evening trip with Uber');
      if (uber) {
        items.push({ id: uber, cards: [{ kind: 'receipt', confidence: 0.9, fields: { merchant: 'Uber', orderNumber: null, total: 23.4, currency: 'GBP', date: null, items: [] },
          quotes: [{ field: 'merchant', quote: 'Thanks for riding, Prakhar.' }, { field: 'total', quote: 'Total £23.40' }, { field: 'currency', quote: 'Total £23.40' }] }] });
      }
      return { items };
    });
  }, 60_000);

  afterAll(async () => {
    gw.restore();
    for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    config.invalidateConfigCache();
    await query("DELETE FROM hedwig_corrections WHERE user_id = $1 AND kind = 'card'", [userId]).catch(() => {});
    await query('DELETE FROM hedwig_cards WHERE user_id = $1', [userId]).catch(() => {});
    await query("DELETE FROM hedwig_jobs WHERE user_id = $1 AND kind IN ('cards.extract', 'cards.fetchIcs')", [userId]).catch(() => {});
    if (added.length) await query('DELETE FROM messages WHERE id = ANY($1::uuid[])', [added]);
    await pool?.end();
  });

  it('makes cards deterministically first, and asks Reflex only about sorted Records mail with none', async () => {
    const res = await extract.runCardsJob({ userId, messageIds: added }, { now: new Date(NOW) });
    expect(res.status).toBe('done');
    const calls = gw.callsFor('cards.extract');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Your Tuesday evening trip with Uber');
    expect(calls[0].text).not.toContain('20% off everything');        // promotions: not a card bundle
    expect(calls[0].text).not.toContain('Order confirmation NO-448120'); // schema.org already understood it
    const cards = await store.listCards(userId, { limit: 100 });
    const kinds = (k) => cards.filter((c) => c.kind === k);
    expect(kinds('receipt').map((c) => c.fields.merchant).sort()).toEqual(['Netflix', 'Netflix', 'Netflix', 'Netflix', 'Nordic Outdoor AS', 'Uber']);
    const uber = kinds('receipt').find((c) => c.fields.merchant === 'Uber');
    expect(uber).toMatchObject({ layer: 'reflex', fields: { total: 23.4, currency: 'GBP' }, provenance: { promptId: 'cards.extract', promptVersion: expect.any(String), model: expect.any(String) } });
    expect(uber.sources.total).toMatchObject({ messageId: ids.uber, quote: 'Total £23.40' });
    expect(kinds('code')[0].fields.code).toBe('482913');
    expect(kinds('event')[0]).toMatchObject({ layer: 'ics', fields: { title: 'Autumn break', allDay: true } });
    const { rows: scans } = await query('SELECT state, COUNT(*)::int AS n FROM hedwig_cards_scan WHERE message_id = ANY($1::uuid[]) GROUP BY state', [added]);
    expect(scans).toEqual([{ state: 'done', n: added.length }]);
  });

  it('keeps one delivery card per tracking number, refreshed by the later mail', async () => {
    const deliveries = await store.listCards(userId, { kinds: ['delivery'] });
    const dhl = deliveries.filter((c) => c.fields.trackingNumber === '5566778899');
    expect(dhl).toHaveLength(1);
    expect(dhl[0].fields).toMatchObject({ carrier: 'DHL', status: 'out_for_delivery', expectedBy: '16:00' });
    expect(dhl[0].fields.history.map((h) => h.status)).toEqual(['shipped', 'out_for_delivery']);
    expect(dhl[0].messageIds.sort()).toEqual([ids.dhl1, ids.dhl2].sort());
    expect((await store.listCards(userId, { messageId: ids.dhl2 }))[0].id).toBe(dhl[0].id);
    expect(deliveries.some((c) => c.fields.trackingNumber === '70712345678901234')).toBe(true);
  });

  it('finds the Netflix subscription and lists it in the ledger with monthly totals', async () => {
    const subs = await ledgerMod.ledger(userId, 'subscriptions');
    expect(subs.rows).toHaveLength(1);
    expect(subs.rows[0]).toMatchObject({ merchant: 'Netflix', cadence: 'monthly', amount: 139, currency: 'NOK', charges: 4 });
    expect(subs.totals[0]).toMatchObject({ currency: 'NOK', monthly: 139 });
    const purchases = await ledgerMod.ledger(userId, 'purchases', { sort: 'amount', dir: 'desc' });
    expect(purchases.rows[0]).toMatchObject({ merchant: 'Nordic Outdoor AS', amount: 1299 });
    expect(purchases.totals.find((t) => t.currency === 'GBP')).toMatchObject({ total: 23.4, count: 1 });
    expect((await ledgerMod.ledger(userId, 'deliveries')).rows.length).toBeGreaterThanOrEqual(2);
  });

  it('shows Today figures and puts them on the Brief', async () => {
    const figs = await todayMod.cardsToday(userId, { now: NOW });
    expect(figs.map((f) => f.kind)).toEqual(expect.arrayContaining(['code', 'delivery', 'event']));
    expect(figs.find((f) => f.kind === 'delivery')).toMatchObject({ figure: 'Today', caption: 'DHL, out for delivery', messageId: expect.any(String) });
    const brief = await briefing.compileBrief(userId, { now: NOW });
    expect(brief.cards.some((c) => c.kind === 'code' && c.figure === '482913')).toBe(true);
  });

  it('records an edit as a correction and lets a dismissal hide the card', async () => {
    const [uber] = (await store.listCards(userId, { kinds: ['receipt'] })).filter((c) => c.fields.merchant === 'Uber');
    const edited = await store.patchCard(userId, uber.id, { total: '24.40' });
    expect(edited).toMatchObject({ userEdited: true, fields: { total: 24.4 }, sources: { total: { via: 'user', before: 23.4 } } });
    const { rows: corr } = await query("SELECT before, after, prompt_id FROM hedwig_corrections WHERE user_id = $1 AND kind = 'card' AND target_id = $2", [userId, uber.id]);
    expect(corr[0]).toMatchObject({ before: { kind: 'receipt', fields: { total: 23.4 } }, after: { kind: 'receipt', fields: { total: 24.4 } }, prompt_id: 'cards.extract' });
    // A rerun of the job does not undo the edit.
    await query('DELETE FROM hedwig_cards_scan WHERE message_id = $1', [ids.uber]);
    await extract.runCardsJob({ userId, messageIds: [ids.uber] }, { now: new Date(NOW) });
    expect((await store.getCard(userId, uber.id)).fields.total).toBe(24.4);
    await store.dismissCard(userId, uber.id);
    expect((await store.listCards(userId, { kinds: ['receipt'] })).some((c) => c.id === uber.id)).toBe(false);
  });

  it('reads production-shaped mail: pattern cards first, the Reflex fill for what they miss, wherever it was sorted', async () => {
    const shape = (f) => ({ subject: f.subject, from: f.from_email, fromName: f.from_name, body: f.body_text });
    await addMessage('shopOrder', { ...shape(F.SHOPIFY_ORDER), bundle: null, minutesAgo: 6 * 1440 });
    await addMessage('shopShip', { ...shape(F.SHOPIFY_SHIPPED), bundle: null, minutesAgo: 5 * 1440 });
    await addMessage('indigo', { ...shape(F.INDIGO_TAX_INVOICE), bundle: null, stream: 'people', minutesAgo: 20 * 1440 });
    await addMessage('mmt', { ...shape(F.MMT_ETICKET), bundle: 'travel', minutesAgo: 60 * 1440 }); // older than the old 45-day Reflex window
    await addMessage('ken', { ...shape(F.NEWSLETTER_ORDER_WORDS), bundle: null, stream: 'reading', minutesAgo: 1440 });
    const tomorrow = new Date(NOW + DAY_MS);
    const departAt = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 4, 0)).toISOString();
    gw.reset().install();
    gw.on('cards.extract', (req) => {
      const idFor = (subject) => (req.text.match(new RegExp(`### (m\\d+)\\nFrom: [^\\n]*\\nDate: [^\\n]*\\nSubject: ${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) || [])[1];
      const items = [];
      const mmt = idFor(F.MMT_ETICKET.subject);
      if (mmt) {
        items.push({ id: mmt, cards: [{ kind: 'travel', confidence: 0.9,
          fields: { type: 'flight', provider: 'IndiGo', reference: 'HCYP2A', from: 'Kochi', to: 'Bagdogra', departAt, arriveAt: null, flightNumber: '6E 539', checkIn: null, checkOut: null, location: null },
          quotes: [{ field: 'reference', quote: 'PNR: HCYP2A' }, { field: 'from', quote: 'Kochi - Bagdogra' }, { field: 'to', quote: 'Kochi - Bagdogra' },
            { field: 'departAt', quote: 'Kochi COK 09:30 hrs' }, { field: 'flightNumber', quote: 'IndiGo 6E 539' }] }] });
      }
      const ship = idFor(F.SHOPIFY_SHIPPED.subject);
      if (ship) items.push({ id: ship, cards: [] });
      return { items };
    });
    const mine = ['shopOrder', 'shopShip', 'indigo', 'mmt', 'ken'].map((k) => ids[k]);
    const res = await extract.runCardsJob({ userId, messageIds: mine }, { now: new Date(NOW) });
    expect(res.status).toBe('done');
    const asked = gw.callsFor('cards.extract').map((c) => c.text).join('\n');
    expect(asked).toContain(F.MMT_ETICKET.subject);          // a partial travel card: departure left to the model
    expect(asked).toContain(F.SHOPIFY_SHIPPED.subject);      // records without a bundle, order with no total
    expect(asked).toContain(F.INDIGO_TAX_INVOICE.subject);   // People mail with a data signal
    expect(asked).not.toContain(F.SHOPIFY_ORDER.subject);    // the pattern card is complete
    expect(asked).not.toContain(F.NEWSLETTER_ORDER_WORDS.subject); // Reading is never asked

    const receipt = (await store.listCards(userId, { messageId: ids.shopOrder })).find((c) => c.kind === 'receipt');
    expect(receipt).toMatchObject({ layer: 'pattern', fields: { merchant: 'REES52', orderNumber: '24176', total: 1240, currency: 'INR' } });
    expect(receipt.messageIds.sort()).toEqual([ids.shopOrder, ids.shopShip].sort()); // the shipment notice is the same order
    for (const k of Object.keys(receipt.fields)) expect(receipt.sources[k]).toMatchObject({ messageId: expect.any(String), quote: expect.any(String) });
    const parcel = (await store.listCards(userId, { messageId: ids.shopShip })).find((c) => c.kind === 'delivery');
    expect(parcel.fields).toMatchObject({ carrier: 'Blue Dart', trackingNumber: '90667948000' });
    const invoice = (await store.listCards(userId, { messageId: ids.indigo })).find((c) => c.kind === 'invoice');
    expect(invoice).toMatchObject({ layer: 'pattern', fields: { invoiceNumber: 'KL1262707AI06924' } });
    const trips = (await store.listCards(userId, { messageId: ids.mmt })).filter((c) => c.kind === 'travel');
    expect(trips).toHaveLength(1); // the model filled the pattern card instead of making a second one
    expect(trips[0]).toMatchObject({ fields: { reference: 'HCYP2A', type: 'flight', departAt, from: 'Kochi', to: 'Bagdogra' }, provenance: { promptId: 'cards.extract' } });
    expect(trips[0].sources.departAt).toMatchObject({ messageId: ids.mmt, quote: 'Kochi COK 09:30 hrs', via: 'reflex' });
    expect(trips[0].sources.reference.via).toBe('pattern');
    expect(await store.listCards(userId, { messageId: ids.ken })).toEqual([]);
    const { rows: scans } = await query('SELECT DISTINCT version FROM hedwig_cards_scan WHERE message_id = ANY($1::uuid[])', [mine]);
    expect(scans).toEqual([{ version: 'cards-v2' }]);

    // Ledgers and Today return the rows the views need.
    const purchases = await ledgerMod.ledger(userId, 'purchases');
    expect(purchases.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ merchant: 'REES52', reference: '24176', amount: 1240, currency: 'INR', status: 'paid' }),
      expect.objectContaining({ kind: 'invoice', reference: 'KL1262707AI06924' }),
    ]));
    expect(purchases.totals.find((t) => t.currency === 'INR')).toMatchObject({ total: 1240 });
    expect((await ledgerMod.ledger(userId, 'travel')).rows).toEqual(expect.arrayContaining([expect.objectContaining({ reference: 'HCYP2A', departAt, from: 'Kochi', to: 'Bagdogra' })]));
    expect((await ledgerMod.ledger(userId, 'deliveries')).rows).toEqual(expect.arrayContaining([expect.objectContaining({ carrier: 'Blue Dart', trackingNumber: '90667948000' })]));
    const figs = await todayMod.cardsToday(userId, { now: NOW });
    expect(figs.find((f) => f.kind === 'travel')).toMatchObject({ caption: expect.stringMatching(/^Tomorrow · HCYP2A/), messageId: ids.mmt });
    // List and bundle rows fetch their cards in one call (GET /cards/messages?ids=…).
    const byMsg = await store.cardsForMessages(userId, [ids.shopShip, ids.ken, ids.mmt]);
    expect(byMsg.get(ids.shopShip).map((c) => c.kind).sort()).toEqual(['delivery', 'receipt']);
    expect(byMsg.get(ids.mmt).map((c) => c.kind)).toEqual(['travel']);
    expect(byMsg.has(ids.ken)).toBe(false);
  });

  it('shows open commitments with a due date as deadline cards (a view, not a copy)', async () => {
    const { rows } = await query(
      `INSERT INTO hedwig_commitments (user_id, direction, counterparty, what, due_at, source_message_id)
       VALUES ($1, 'i_owe', 'Priya', 'Send the signed sponsorship form', NOW() + INTERVAL '2 days', $2) RETURNING id`,
      [userId, ids.order],
    );
    const cid = rows[0].id;
    try {
      const card = await store.getCard(userId, cid);
      expect(card).toMatchObject({ kind: 'deadline', fields: { what: 'Send the signed sponsorship form', direction: 'i_owe' } });
      const edited = await store.patchCard(userId, cid, { what: 'Send the signed form and payslips' });
      expect(edited.fields.what).toBe('Send the signed form and payslips');
      const { rows: c } = await query('SELECT what FROM hedwig_commitments WHERE id = $1', [cid]);
      expect(c[0].what).toBe('Send the signed form and payslips');
      await store.dismissCard(userId, cid);
      expect((await store.listCards(userId, { kinds: ['deadline'] })).some((x) => x.id === cid)).toBe(false);
    } finally {
      await query('DELETE FROM hedwig_commitments WHERE id = $1', [cid]);
    }
  });
});
