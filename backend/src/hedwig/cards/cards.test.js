import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ pool: {}, query: vi.fn(async () => ({ rows: [] })) }));

const F = await import('./fixtures.testutil.js');
const { detectSchemaOrg, detectIcs, detectTracking, detectCodes, detectDeterministic, calendarAttachments } = await import('./detect/index.js');
const { findTrackingNumbers, s10Valid, deliveryStatusOf } = await import('./detect/tracking.js');
const { parseIcs, icsDate } = await import('./detect/ics.js');
const { findSubscriptions, cadenceOf, notRecurringReason, recurringSignal } = await import('./subscriptions.js');
const { blocksFrom, isBlocked, feedbackLine, cardMerchantKey } = await import('./feedback.js');
const { renderCardsUser } = await import('../prompts/cards.extract.js');
const { mergeCards, validateEdit } = await import('./store.js');
const { verifyModelCard, locateQuote, quoteSupports, reflexEligible, twinOf } = await import('./extract.js');
const { detectOrders, dataSignal, needsFill, findTotal, senderName } = await import('./detect/orders.js');
const { todayFigures, formatMoney } = await import('./today.js');
const { sortRows, totalsByCurrency } = await import('./ledger.js');
const { cardIcs, reminderFor, cardActions, foldIcs } = await import('./actions.js');
const { dedupeKey, normAmount, normCurrency, merchantKey, eventAt } = await import('./kinds.js');
const { parseLooseDate, parseByTime, sentenceAround } = await import('./text.js');

const row = (x, extra = {}) => ({ id: 'msg-1', date: '2026-09-23T08:00:00Z', ...x, ...extra });

describe('schema.org', () => {
  it('reads an Order with its ParcelDelivery (JSON-LD), citing the markup for every field', () => {
    const cards = detectSchemaOrg(row({ body_html: F.ORDER_JSONLD }));
    const receipt = cards.find((c) => c.kind === 'receipt');
    const delivery = cards.find((c) => c.kind === 'delivery');
    expect(receipt.fields).toMatchObject({ merchant: 'Nordic Outdoor AS', orderNumber: 'NO-448120', total: 1299, currency: 'NOK', date: '2026-09-20' });
    expect(receipt.fields.items).toEqual([{ name: 'Trail running shoes', quantity: 1, price: 1299 }]);
    expect(delivery.fields).toMatchObject({ carrier: 'Posten', trackingNumber: '70712345678901234', status: 'in_transit', expectedDate: '2026-09-24', merchant: 'Nordic Outdoor AS' });
    for (const c of cards) {
      expect(Object.keys(c.sources).sort()).toEqual(Object.keys(c.fields).sort());
      expect(c.layer).toBe('schema_org');
    }
    expect(receipt.sources.orderNumber.quote).toBe('schema.org Order.orderNumber = NO-448120');
  });

  it('reads flight and hotel reservations', () => {
    const [flight, hotel] = detectSchemaOrg(row({ body_html: F.FLIGHT_JSONLD }));
    expect(flight.fields).toMatchObject({ type: 'flight', reference: 'XK7P2Q', provider: 'Norwegian', flightNumber: 'DY 604', from: 'BGO', to: 'OSL', departAt: '2026-10-02T05:10:00.000Z' });
    expect(hotel.fields).toMatchObject({ type: 'hotel', provider: 'Hotel Bristol', checkIn: '2026-10-02', checkOut: '2026-10-04', location: 'Kristian IVs gate 7, Oslo' });
    expect(dedupeKey(flight)).toBe('ref:XK7P2Q:DY 604:2026-10-02');
  });

  it('reads an Invoice and an EventReservation', () => {
    expect(detectSchemaOrg(row({ body_html: F.INVOICE_JSONLD }))[0].fields).toMatchObject({ issuer: 'Fjordkraft', invoiceNumber: 'INV-2026-0912', amount: 1240, currency: 'NOK', dueDate: '2026-09-25', status: 'due' });
    expect(detectSchemaOrg(row({ body_html: F.EVENT_JSONLD }))[0].fields).toMatchObject({ title: 'Bergen Philharmonic: Mahler 2', start: '2026-10-09T17:30:00.000Z', location: 'Grieghallen' });
  });

  it('reads microdata', () => {
    const [receipt] = detectSchemaOrg(row({ body_html: F.ORDER_MICRODATA }));
    expect(receipt.fields).toMatchObject({ merchant: 'Bookshop Ltd', orderNumber: 'BS-10023', total: 24.98, currency: 'GBP', items: [{ name: 'The Overstory', quantity: 1, price: 12.49 }] });
    expect(receipt.sources.merchant.via).toBe('schema.org microdata');
  });

  it('ignores HTML without markup and broken JSON-LD', () => {
    expect(detectSchemaOrg(row({ body_html: '<p>Hello</p>' }))).toEqual([]);
    expect(detectSchemaOrg(row({ body_html: '<script type="application/ld+json">{ not json</script>' }))).toEqual([]);
  });
});

describe('calendar parts', () => {
  it('parses an Outlook invite: Windows zone, escaped text, alarms ignored, upstream rendering as the source', () => {
    const [ev] = detectIcs(row({}), [{ text: F.ICS_INVITE, filename: 'invite.ics' }], { tz: 'Europe/London' });
    expect(ev.fields).toMatchObject({
      title: "Parents' evening, class 4B", start: '2026-09-24T16:30:00.000Z', end: '2026-09-24T18:00:00.000Z', allDay: false,
      location: 'Møhlenpris skole, room 12', organizer: 'Anna Berg', method: 'request',
    });
    expect(ev.sources.start.quote).toMatch(/^When: Thursday, September 24, 2026, 6:30 PM/);
    expect(ev.sources.location.attachment).toBe('invite.ics');
    expect(dedupeKey(ev)).toBe('uid:040000008200E00074C5B7101A82E0080000000070DA');
  });

  it('marks cancellations and carries the sequence', () => {
    const [ev] = detectIcs(row({}), [{ text: F.ICS_CANCEL }]);
    expect(ev.fields.status).toBe('cancelled');
    expect(ev.sequence).toBe(1);
  });

  it('treats DATE values as all-day with an exclusive end', () => {
    const [ev] = parseIcs(F.ICS_ALLDAY);
    expect(ev).toMatchObject({ start: '2026-10-12', end: '2026-10-14', allDay: true });
    expect(icsDate('20260924T183000Z')).toEqual({ iso: '2026-09-24T18:30:00.000Z', allDay: false });
    expect(icsDate('20260924T183000', { TZID: 'Europe/Oslo' }).iso).toBe('2026-09-24T16:30:00.000Z');
  });

  it('finds calendar attachments and reads VCALENDAR bodies', () => {
    expect(calendarAttachments([{ filename: 'photo.jpg', type: 'image/jpeg', part: '2' }, { filename: 'invite.ics', type: 'application/octet-stream', part: '3', size: 900 }])
      .map((a) => a.index)).toEqual([1]);
    const cards = detectDeterministic(row({ body_text: F.ICS_ALLDAY }));
    expect(cards.map((c) => c.kind)).toEqual(['event']);
  });
});

describe('tracking numbers', () => {
  it('reads a DHL waybill with status, expected date, time and link, and skips the phone number', () => {
    const [d] = detectTracking(row(F.DHL_MAIL), { tz: 'Europe/Oslo' });
    expect(d.fields).toMatchObject({ carrier: 'DHL', trackingNumber: '1234567890', status: 'out_for_delivery', expectedDate: '2026-09-23', expectedBy: '16:00', trackingUrl: 'https://www.dhl.com/track?AWB=1234567890' });
    expect(d.sources.trackingNumber.quote).toBe('Your shipment with waybill number 1234567890 is out for delivery today.');
    expect(detectTracking(row(F.DHL_MAIL))).toHaveLength(1);
  });

  it('reads UPS 1Z numbers with the scheduled day', () => {
    const [d] = detectTracking(row(F.UPS_MAIL));
    expect(d.fields).toMatchObject({ carrier: 'UPS', trackingNumber: '1Z999AA10123456784', status: 'in_transit', expectedDate: '2026-09-24' });
  });

  it('checks UPU S10 check digits and names the carrier by country', () => {
    expect(s10Valid('12345678', '5')).toBe(true);
    expect(s10Valid('12345678', '4')).toBe(false);
    const [d] = detectTracking(row(F.ROYAL_MAIL));
    expect(d.fields).toMatchObject({ carrier: 'Royal Mail', trackingNumber: 'AB123456785GB', status: 'delivered' });
    expect(findTrackingNumbers('Your item AB123456784GB has been delivered')).toEqual([]);
  });

  it('needs the carrier and a tracking word for bare digit runs', () => {
    expect(findTrackingNumbers('Invoice 1234567890 for your parcel')).toEqual([]);            // no carrier named
    expect(findTrackingNumbers('DHL: call 1234567890 about your shipment')).toEqual([]);         // a phone number
    expect(findTrackingNumbers('DHL order reference 1234567890 was paid')).toEqual([]);         // no tracking word near
    expect(findTrackingNumbers('Posten: sporing av pakke 70712345678901234')).toMatchObject([{ carrier: 'Posten/Bring', number: '70712345678901234' }]);
    expect(findTrackingNumbers('Your GLS parcel 12345678901 is on its way', { from: 'GLS' })).toMatchObject([{ carrier: 'GLS' }]);
    expect(findTrackingNumbers('DPD tracking 0123 4567 8901 23')).toMatchObject([{ carrier: 'DPD', number: '01234567890123' }]);
    expect(findTrackingNumbers('PostNord: kolli 00370712345678901234 er sendt')).toMatchObject([{ carrier: 'PostNord' }]);
    expect(findTrackingNumbers('FedEx tracking number 123456789012')).toMatchObject([{ carrier: 'FedEx' }]);
    expect(findTrackingNumbers('USPS tracking 9400 1000 0000 0000 0000 00')).toMatchObject([{ carrier: 'USPS' }]);
  });

  it('reads the latest status the mail states', () => {
    expect(deliveryStatusOf('Your parcel will be delivered tomorrow. It has left the depot.').status).toBe('in_transit');
    expect(deliveryStatusOf('We missed you: delivery attempt failed').status).toBe('exception');
    expect(deliveryStatusOf('Your order has been dispatched').status).toBe('shipped');
  });
});

describe('orders, bookings and invoices in plain mail (production shapes)', () => {
  it('reads a Shopify order with its total, citing the sentence for every field', () => {
    const [c] = detectOrders(row(F.SHOPIFY_ORDER));
    expect(c).toMatchObject({ kind: 'receipt', layer: 'pattern', fields: { merchant: 'REES52', orderNumber: '24176', total: 1240, currency: 'INR' } });
    expect(Object.keys(c.sources).sort()).toEqual(Object.keys(c.fields).sort());
    expect(c.sources.orderNumber.quote).toContain('Order #24176');
    expect(c.sources.total.quote).toContain('1,240.00');
    expect(c.sources.merchant).toMatchObject({ via: 'header' });
    expect(needsFill([c])).toBe(false);
  });

  it('makes the shipment notice fill the same order, and a tax invoice an invoice card', () => {
    const [ship] = detectOrders(row(F.SHOPIFY_SHIPPED));
    expect(ship).toMatchObject({ kind: 'receipt', fields: { orderNumber: '24176', merchant: 'REES52' } });
    expect(dedupeKey(ship)).toBe(dedupeKey({ ...detectOrders(row(F.SHOPIFY_ORDER))[0] }));
    expect(needsFill([ship])).toBe(true); // no total: the Reflex model fills it
    const [inv] = detectOrders(row(F.INDIGO_TAX_INVOICE));
    expect(inv).toMatchObject({ kind: 'invoice', fields: { invoiceNumber: 'KL1262707AI06924', issuer: 'Goindigo' } });
    expect(needsFill([inv])).toBe(true);
  });

  it('reads flight bookings (PNR first) and ticket purchases', () => {
    const cards = detectOrders(row(F.MMT_ETICKET));
    expect(cards).toEqual([expect.objectContaining({ kind: 'travel', fields: expect.objectContaining({ type: 'flight', reference: 'HCYP2A', provider: 'MakeMyTrip' }) })]);
    expect(needsFill(cards)).toBe(true); // departure time left to the model
    const [tix] = detectOrders(row(F.BOOKMYSHOW_TICKETS));
    expect(tix).toMatchObject({ kind: 'receipt', fields: { merchant: 'BookMyShow', orderNumber: 'TGAMAVT', total: 1322.84, currency: 'INR' } });
    expect(detectOrders(row(F.SHOP_PAYMENT_RECEIVED))[0]).toMatchObject({ kind: 'receipt', fields: { orderNumber: '1530876', merchant: 'MD Computers' } });
  });

  it('leaves newsletters, purchase-order threads and plain notifications alone', () => {
    expect(detectOrders(row(F.NEWSLETTER_ORDER_WORDS))).toEqual([]);
    expect(detectOrders(row(F.SUPPLIER_PO))).toEqual([]);
    expect(detectOrders(row({ subject: 'Your Dependabot alerts for the week', from_email: 'noreply@github.com', body_text: 'Order 2026 of alerts' }))).toEqual([]);
    expect(detectDeterministic(row(F.NEWSLETTER_ORDER_WORDS))).toEqual([]);
  });

  it('knows which mail carries data, and which the Reflex model reads', () => {
    for (const m of [F.SHOPIFY_ORDER, F.SHOPIFY_SHIPPED, F.INDIGO_TAX_INVOICE, F.MMT_ETICKET, F.BOOKMYSHOW_TICKETS, F.SHOP_PAYMENT_RECEIVED]) expect(dataSignal(m)).toBe(true);
    expect(dataSignal({ subject: 'Aramex Shipment Information', from_email: 'kapildev@aramex.example' })).toBe(true);
    expect(dataSignal(F.NEWSLETTER_ORDER_WORDS)).toBe(true); // subject says "order"; stream decides (Reading is never read)
    expect(dataSignal({ subject: 'Lunch on Friday?', from_email: 'jo@example.org' })).toBe(false);
    const bundles = new Set(['purchases', 'travel']);
    expect(reflexEligible({ stream: 'records', bundle: 'travel', subject: 'x' }, { bundles })).toBe(true);
    expect(reflexEligible({ stream: 'records', bundle: null, ...F.SHOPIFY_ORDER }, { bundles })).toBe(true);
    expect(reflexEligible({ stream: 'people', bundle: null, ...F.INDIGO_TAX_INVOICE }, { bundles })).toBe(true);
    expect(reflexEligible({ stream: 'people', bundle: null, subject: 'Lunch?' }, { bundles })).toBe(false);
    expect(reflexEligible({ stream: 'reading', bundle: null, ...F.NEWSLETTER_ORDER_WORDS }, { bundles })).toBe(false);
    expect(reflexEligible({ stream: 'spam', bundle: 'purchases' }, { bundles })).toBe(false);
    expect(reflexEligible({ stream: 'people', ...F.INDIGO_TAX_INVOICE }, { bundles, signalReflex: false })).toBe(false);
  });

  it('pairs a model card with the pattern card it fills', () => {
    const pattern = detectOrders(row(F.SHOPIFY_SHIPPED));
    expect(twinOf({ kind: 'receipt', fields: { total: 1240 } }, pattern)).toBe(pattern[0]);
    expect(twinOf({ kind: 'receipt', fields: { orderNumber: '#24176'.slice(1) } }, pattern)).toBe(pattern[0]);
    expect(twinOf({ kind: 'receipt', fields: { orderNumber: '99999' } }, pattern)).toBeNull();
    expect(twinOf({ kind: 'travel', fields: {} }, pattern)).toBeNull();
  });

  it('reads totals and sender names the way these senders write them', () => {
    expect(findTotal('AMOUNT PAID Rs.1322.84')).toMatchObject({ amount: 1322.84, currency: 'INR' });
    expect(findTotal('Grand Total: £48.00')).toMatchObject({ amount: 48, currency: 'GBP' });
    expect(findTotal('Total 0.00')).toBeNull();
    expect(senderName({ from_name: 'Amazon.in via Shop', from_email: 'x@amazon.in' })).toBe('Amazon.in');
    expect(senderName({ from_name: '', from_email: 'noreply@notify.cloudflare.com' })).toBe('Cloudflare');
  });

  it('takes the waybill, not a store id inside a link', () => {
    const cards = detectDeterministic(row(F.SHOPIFY_SHIPPED));
    expect(cards.filter((c) => c.kind === 'delivery').map((c) => [c.fields.carrier, c.fields.trackingNumber])).toEqual([['Blue Dart', '90667948000']]);
    expect(cards.map((c) => c.kind).sort()).toEqual(['delivery', 'receipt']);
  });

  it('recognises Indian carriers and India Post', () => {
    expect(findTrackingNumbers('Your Blue Dart shipment AWB 12345678901 is in transit.', { from: 'Blue Dart' })).toEqual([expect.objectContaining({ carrier: 'Blue Dart', number: '12345678901' })]);
    expect(findTrackingNumbers('Track your Delhivery parcel: waybill 1234567890123', { from: 'Delhivery' })[0]).toMatchObject({ carrier: 'Delhivery' });
  });
});

describe('one-time codes', () => {
  it('reads a code with its service and expiry', () => {
    const [c] = detectCodes(row(F.OTP_MAIL));
    expect(c.fields).toMatchObject({ code: '482913', service: 'Vipps', expiresAt: '2026-09-23T08:10:00.000Z' });
    expect(c.sources.code.quote).toBe('Use this verification code to sign in: 482 913');
  });

  it('reads codes in the subject and leaves booking references alone', () => {
    expect(detectCodes(row(F.GOOGLE_CODE))[0].fields.code).toBe('731904');
    expect(detectCodes(row(F.BOOKING_CONFIRMATION))).toEqual([]);
    expect(detectCodes(row({ subject: 'Your order', body_text: 'Your code: see order #123456 for £1999' }))).toEqual([]);
    expect(detectCodes(row({ subject: 'Newsletter', body_text: 'Security matters in 2026. Read more.' }))).toEqual([]);
  });
});

describe('subscriptions', () => {
  const charge = (date, amount = 139, merchant = 'Netflix', currency = 'NOK', extra = {}) => ({ messageId: `m-${date}`, merchant, amount, currency, date, cardId: `c-${date}`, ...extra });

  it('groups steady monthly charges and predicts the next renewal', () => {
    const subs = findSubscriptions([charge('2026-06-14'), charge('2026-07-14'), charge('2026-08-14', 149, 'Netflix Inc.'), charge('2026-09-14')], { now: new Date('2026-09-23') });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ cadence: 'monthly', lastCharged: '2026-09-14', nextRenewal: '2026-10-14', charges: 4, amount: 139, currency: 'NOK', merchantKey: 'netflix' });
  });

  it('knows yearly and weekly, and month ends', () => {
    expect(findSubscriptions([charge('2023-03-01', 99, 'iCloud'), charge('2024-03-01', 99, 'iCloud'), charge('2025-03-01', 99, 'iCloud')], { now: new Date('2025-06-01') })[0]).toMatchObject({ cadence: 'yearly', nextRenewal: '2026-03-01' });
    expect(cadenceOf([7, 7, 8, 6])).toBe('weekly');
    expect(findSubscriptions([charge('2026-06-30', 10, 'Gym'), charge('2026-07-31', 10, 'Gym'), charge('2026-08-31', 10, 'Gym')], { now: new Date('2026-09-01') })[0].nextRenewal).toBe('2026-09-30');
  });

  it('ignores one-off shopping and irregular charges', () => {
    expect(findSubscriptions([charge('2026-06-01', 89, 'Amazon'), charge('2026-06-20', 12, 'Amazon'), charge('2026-08-03', 240, 'Amazon')])).toEqual([]);
    expect(findSubscriptions([charge('2026-06-01'), charge('2026-06-19'), charge('2026-09-02')])).toEqual([]);
    expect(findSubscriptions([charge('2026-09-01')])).toEqual([]);
  });

  it('keeps currencies apart and drops a lapsed renewal date', () => {
    const subs = findSubscriptions([charge('2025-01-05', 5, 'Spotify', 'GBP'), charge('2025-02-05', 5, 'Spotify', 'GBP'), charge('2025-03-05', 5, 'Spotify', 'GBP'), charge('2025-04-05', 5, 'Spotify', 'EUR')], { now: new Date('2026-09-01') });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ currency: 'GBP', lapsed: true, nextRenewal: null });
  });

  // The production mistake: two BookMyShow movie tickets a month apart became a monthly subscription.
  const bms = (date, amount, order) => charge(date, amount, 'BookMyShow', 'INR', { kind: 'receipt', orderNumber: order, subject: 'Your booking is confirmed!' });
  it('two charges are never a subscription, whatever the interval (the BookMyShow tickets)', () => {
    expect(findSubscriptions([bms('2026-06-12', 1039.24, 'WX6NCTF'), bms('2026-07-12', 1322.84, 'TGAMAVT')], { now: new Date('2026-07-20') })).toEqual([]);
    // Even steady and without order numbers, and even when the setting asks for fewer.
    expect(findSubscriptions([charge('2026-06-14'), charge('2026-07-14')], { minCharges: 2, now: new Date('2026-07-20') })).toEqual([]);
    expect(notRecurringReason([{ amount: 1 }, { amount: 1 }], { minCharges: 2 })).toBe('too_few_charges');
  });

  it('a cadence needs at least two intervals that agree', () => {
    expect(cadenceOf([30])).toBeNull();
    expect(cadenceOf([31, 30])).toBe('monthly');
    expect(cadenceOf([30, 75])).toBeNull();
    expect(findSubscriptions([charge('2026-04-14'), charge('2026-05-14'), charge('2026-08-01')], { now: new Date('2026-08-05') })).toEqual([]);
  });

  it('three charges must be within 15% of each other; four or more within 25%', () => {
    const three = [charge('2026-06-14', 100), charge('2026-07-14', 100), charge('2026-08-14', 120)];
    expect(findSubscriptions(three, { now: new Date('2026-08-20') })).toEqual([]);
    expect(findSubscriptions([...three.slice(0, 2), charge('2026-08-14', 110)], { now: new Date('2026-08-20') })).toHaveLength(1);
    expect(findSubscriptions([...three, charge('2026-09-14', 100)], { now: new Date('2026-09-20') })).toHaveLength(1);
  });

  it('receipts with their own order numbers are one-off orders unless the mail says the charge recurs', () => {
    const tickets = [bms('2026-05-12', 1100, 'AAA1111'), bms('2026-06-12', 1039.24, 'WX6NCTF'), bms('2026-07-12', 1050, 'TGAMAVT')];
    expect(notRecurringReason(tickets)).toBe('separate_orders');
    expect(findSubscriptions(tickets, { now: new Date('2026-07-20') })).toEqual([]);
    // The same numbers on renewal mail are a subscription (Apple, Google Play: an order id each month).
    const renewals = tickets.map((c) => ({ ...c, merchant: 'Apple', subject: 'Your subscription renewal receipt' }));
    expect(findSubscriptions(renewals, { now: new Date('2026-07-20') })).toHaveLength(1);
    // The signal can come from the quotes the card kept.
    expect(recurringSignal({ subject: 'Receipt', sources: { total: { quote: 'Your membership renews on 12 August' } } })).toBe(true);
    expect(recurringSignal({ subject: 'Plan your evening: 2 tickets for Dune' })).toBe(false);
    // One mention in three is not enough.
    expect(notRecurringReason([{ ...tickets[0], subject: 'Get a BookMyShow membership!' }, tickets[1], tickets[2]])).toBe('separate_orders');
  });

  it('invoices from one issuer at a steady amount stay subscriptions (invoice numbers differ by nature)', () => {
    const bill = (date, n) => charge(date, 349, 'Telia', 'NOK', { kind: 'invoice', subject: `Invoice ${n}` });
    expect(findSubscriptions([bill('2026-06-01', 'T-1'), bill('2026-07-01', 'T-2'), bill('2026-08-01', 'T-3')], { now: new Date('2026-08-10') })).toMatchObject([{ merchant: 'Telia', cadence: 'monthly' }]);
  });

  it('mail that is also a ticket, a trip or a parcel is never a subscription charge', () => {
    const withEvent = [charge('2026-06-14'), charge('2026-07-14', 139, 'Netflix', 'NOK', { siblingKinds: ['event'] }), charge('2026-08-14')];
    expect(notRecurringReason(withEvent)).toBe('one_off_kind');
    expect(findSubscriptions(withEvent, { now: new Date('2026-08-20') })).toEqual([]);
    expect(findSubscriptions([charge('2026-06-14'), charge('2026-07-14'), charge('2026-08-14', 139, 'Netflix', 'NOK', { siblingKinds: ['delivery'] })])).toEqual([]);
    expect(findSubscriptions([charge('2026-06-14', 139, 'Netflix', 'NOK', { kind: 'travel' }), charge('2026-07-14'), charge('2026-08-14'), charge('2026-09-14')], { now: new Date('2026-09-20') })).toMatchObject([{ charges: 3 }]);
  });

  it('never derives a merchant the owner said is not recurring', () => {
    const steady = [charge('2026-06-14'), charge('2026-07-14'), charge('2026-08-14')];
    expect(findSubscriptions(steady, { now: new Date('2026-08-20') })).toHaveLength(1);
    expect(findSubscriptions(steady, { now: new Date('2026-08-20'), oneOff: new Set(['netflix']) })).toEqual([]);
  });
});

describe('card feedback', () => {
  it('turns the owner\'s verdicts into what is not made again', () => {
    const blocks = blocksFrom([
      { kind: 'subscription', merchant_key: 'bookmyshow', verdict: 'not_recurring' },
      { kind: 'event', merchant_key: 'shop', verdict: 'not_this_kind' },
      { kind: 'subscription', merchant_key: 'gym', verdict: 'not_this_kind' },
      { kind: 'receipt', merchant_key: 'uber', verdict: 'wrong_field' },
      { kind: 'receipt', merchant_key: null, verdict: 'not_this_kind' },
    ]);
    expect([...blocks.oneOff].sort()).toEqual(['bookmyshow', 'gym']);
    expect([...blocks.notKind].sort()).toEqual(['event|shop', 'subscription|bookmyshow', 'subscription|gym']);
    expect(isBlocked({ kind: 'subscription', fields: { merchant: 'BookMyShow' } }, blocks)).toBe(true);
    expect(isBlocked({ kind: 'receipt', fields: { merchant: 'BookMyShow' } }, blocks)).toBe(false);
    // A card without a merchant field is matched by its sender's name.
    expect(isBlocked({ kind: 'event', fields: { title: 'Sale party' } }, blocks, { from_name: 'Shop', from_email: 'news@shop.example' })).toBe(true);
    expect(isBlocked({ kind: 'event', fields: { title: 'Dinner' } }, blocks, { from_name: 'Anna', from_email: 'anna@example.test' })).toBe(false);
  });

  it('names a card by its merchant, issuer or provider, else its sender', () => {
    expect(cardMerchantKey({ kind: 'invoice', fields: { issuer: 'Fjordkraft AS' } })).toBe('fjordkraft');
    expect(cardMerchantKey({ kind: 'delivery', fields: { carrier: 'DHL' } })).toBe('dhl');
    expect(cardMerchantKey({ kind: 'event', fields: {}, message: { from_name: null, from_email: 'tickets@bookmyshow.com' } })).toBe('bookmyshow');
  });

  it('writes feedback as lines the extractor reads with the next mail from that sender', () => {
    expect(feedbackLine({ kind: 'subscription', verdict: 'not_recurring', merchant_key: 'bookmyshow', before: { merchant: 'BookMyShow' } }))
      .toBe('a subscription card for BookMyShow: the owner said this is not a subscription (separate one-off purchases).');
    expect(feedbackLine({ kind: 'event', verdict: 'not_this_kind', merchant_key: 'shop' })).toBe('an event card for shop: the owner said this mail is not an event.');
    expect(feedbackLine({ kind: 'receipt', verdict: 'wrong_field', field: 'total', merchant_key: 'uber', before: { total: 23.4, merchant: 'Uber' }, after: { total: 24.4 } }))
      .toBe('a receipt card for Uber: total was 23.4; the owner corrected it to 24.4.');
    expect(feedbackLine({ kind: 'subscription', verdict: 'wrong_field', field: 'cadence', before: { cadence: 'weekly' }, after: { cadence: null } })).toMatch(/cadence was "?weekly"?; the owner cleared it\./);
    const text = renderCardsUser({ today: '2026-09-24', items: [{ id: 'm1', from: 'BookMyShow <tickets@bookmyshow.com>', subject: 'Your booking', text: 'x', feedback: ['a subscription card for BookMyShow: not a subscription.'] }, { id: 'm2', from: 'a@b', subject: 's', text: 'y' }] });
    expect(text).toContain('Subject: Your booking\nThe owner corrected earlier cards from this sender:\n- a subscription card for BookMyShow: not a subscription.');
    expect(text.match(/The owner corrected/g)).toHaveLength(1);
  });
});

describe('merging and editing cards', () => {
  const old = {
    fields: { carrier: 'DHL', trackingNumber: '1234567890', status: 'shipped', history: [{ status: 'shipped', at: '2026-09-20T08:00:00.000Z', messageId: 'a' }] },
    sources: { carrier: { quote: 'x' }, status: { quote: 'shipped' } }, layer: 'pattern', confidence: 0.9, messageIds: ['a'], messageDate: '2026-09-20T08:00:00.000Z',
  };

  it('takes a delivery status from later mail and keeps the history', () => {
    const m = mergeCards('delivery', old, { fields: { carrier: 'DHL', trackingNumber: '1234567890', status: 'out_for_delivery', expectedDate: '2026-09-23' }, sources: { status: { quote: 'out for delivery' }, expectedDate: { quote: 'today' } }, layer: 'pattern', confidence: 0.9, messageId: 'b', messageDate: '2026-09-23T07:00:00.000Z' });
    expect(m.fields.status).toBe('out_for_delivery');
    expect(m.fields.history.map((h) => h.status)).toEqual(['shipped', 'out_for_delivery']);
    expect(m.fields.expectedDate).toBe('2026-09-23');
    expect(m.sources.status.quote).toBe('out for delivery');
    expect(m.messageIds).toEqual(['a', 'b']);
  });

  it('never moves a delivery back because of an older mail, and never overrides an edit', () => {
    const delivered = mergeCards('delivery', old, { fields: { status: 'delivered' }, sources: {}, layer: 'pattern', messageId: 'c', messageDate: '2026-09-24T12:00:00Z' });
    const late = mergeCards('delivery', { ...old, fields: delivered.fields, messageDate: '2026-09-24T12:00:00Z' }, { fields: { status: 'in_transit' }, sources: {}, layer: 'pattern', messageId: 'd', messageDate: '2026-09-21T12:00:00Z' });
    expect(late.fields.status).toBe('delivered');
    const edited = mergeCards('receipt', { fields: { merchant: 'My name for it', total: 10 }, sources: { merchant: { via: 'user' } }, layer: 'reflex', messageIds: [] }, { fields: { merchant: 'ACME', total: 12 }, sources: {}, layer: 'schema_org', messageId: 'x', messageDate: '2026-09-30' });
    expect(edited.fields).toEqual({ merchant: 'My name for it', total: 12 });
  });

  it('lets a calendar update with a higher sequence replace the event', () => {
    const m = mergeCards('event', { fields: { title: 'Parents evening', start: '2026-09-24T16:30:00.000Z', sequence: 0 }, sources: {}, layer: 'ics', messageIds: ['a'], messageDate: '2026-09-25' },
      { fields: { title: 'Parents evening', start: '2026-09-24T17:00:00.000Z', status: 'confirmed' }, sources: {}, layer: 'ics', messageId: 'b', messageDate: '2026-09-20', sequence: 2 });
    expect(m.fields).toMatchObject({ start: '2026-09-24T17:00:00.000Z', sequence: 2 });
  });

  it('validates edits against the kind', () => {
    expect(validateEdit('receipt', { total: '£12.50', merchant: 'ACME', orderNumber: null })).toEqual({ set: { total: 12.5, merchant: 'ACME' }, clear: ['orderNumber'] });
    expect(() => validateEdit('receipt', { trackingNumber: 'x' })).toThrow(/not a field/);
    expect(() => validateEdit('delivery', { status: 'lost' })).toThrow(/invalid value/);
    expect(() => validateEdit('delivery', { history: [] })).toThrow(/not a field/);
  });
});

describe('model cards are only kept with real quotes', () => {
  const text = 'Thanks for your order from Kaffebrenneriet.\nOrder total: 289,00 kr\nOrder number KB-7781.';
  it('keeps quoted fields and drops invented ones', () => {
    const card = verifyModelCard({
      kind: 'receipt', confidence: 0.8,
      fields: { merchant: 'Kaffebrenneriet', total: 289, currency: 'NOK', orderNumber: 'KB-7781', date: '2026-09-01' },
      quotes: [
        { field: 'merchant', quote: 'Thanks for your order from Kaffebrenneriet.' },
        { field: 'total', quote: 'Order total: 289,00 kr' },
        { field: 'orderNumber', quote: 'Order number KB-7780.' },            // wrong number: dropped
        { field: 'date', quote: 'Ordered on 1 September 2026' },             // not in the mail: dropped
      ],
    }, { messageId: 'm1', text, attachments: [], provenance: { promptId: 'cards.extract' } });
    expect(card.fields).toEqual({ merchant: 'Kaffebrenneriet', total: 289, currency: 'NOK' });
    expect(card.sources.total).toMatchObject({ messageId: 'm1', quote: 'Order total: 289,00 kr', via: 'reflex' });
    expect(card.provenance.promptId).toBe('cards.extract');
  });

  it('finds quotes in attachments and rejects a card without its key fields', () => {
    expect(locateQuote('Amount due: 1 240,00 NOK', { text: 'see attached', attachments: [{ filename: 'faktura.pdf', text: 'Faktura\nAmount due: 1 240,00 NOK\nDue 25.09.2026' }] })).toEqual({ attachment: 'faktura.pdf' });
    expect(verifyModelCard({ kind: 'event', fields: { title: 'Dinner' }, quotes: [{ field: 'title', quote: 'Thanks for your order' }] }, { messageId: 'm', text })).toBeNull();
    expect(quoteSupports('receipt', 'total', 289, 'Order total: 289,00 kr')).toBe(true);
    expect(quoteSupports('receipt', 'total', 300, 'Order total: 289,00 kr')).toBe(false);
  });
});

describe('Today figures', () => {
  const now = new Date('2026-09-23T07:30:00Z').getTime(); // Wednesday, 09:30 in Oslo
  const card = (kind, fields, extra = {}) => ({ id: `${kind}-1`, kind, fields, messageId: 'm', updatedAt: '2026-09-23T06:00:00Z', message: { date: '2026-09-23T07:25:00Z' }, ...extra });
  it('shows parcels arriving today, bills due this week, events today or tomorrow and fresh codes', () => {
    const figs = todayFigures([
      card('delivery', { carrier: 'DHL', item: 'Running shoes', status: 'out_for_delivery', history: [{ status: 'out_for_delivery', at: '2026-09-23T06:00:00Z' }] }),
      card('delivery', { carrier: 'Posten', item: 'Two books', status: 'in_transit', expectedDate: '2026-09-23', expectedBy: '16:00' }),
      card('delivery', { carrier: 'UPS', status: 'delivered', expectedDate: '2026-09-23' }),
      card('invoice', { issuer: 'Fjordkraft', amount: 1240, currency: 'NOK', dueDate: '2026-09-25' }),
      card('invoice', { issuer: 'Old', amount: 5, currency: 'NOK', dueDate: '2026-10-25' }),
      card('event', { title: "Parents' evening", start: '2026-09-24T16:30:00.000Z' }),
      card('event', { title: 'Cancelled', start: '2026-09-24T16:30:00.000Z', status: 'cancelled' }),
      card('code', { code: '482913', service: 'Vipps', expiresAt: '2026-09-23T07:35:00Z' }),
      card('code', { code: '111111', service: 'Old' }, { message: { date: '2026-09-23T05:00:00Z' } }),
    ], { now, tz: 'Europe/Oslo' });
    expect(figs.map((f) => [f.kind, f.figure, f.title, f.caption])).toEqual([
      ['code', '482913', 'Vipps', 'code, expires in 5 min'],
      ['delivery', 'Today', 'Running shoes', 'DHL, out for delivery'],
      ['delivery', 'Today', 'Two books', 'Posten, by 16:00'],
      ['event', '18:30', "Parents' evening", 'Tomorrow'],
      ['invoice', '1,240 NOK', 'Fjordkraft', 'Fjordkraft, due Friday'],
    ]);
    expect(figs.every((f) => f.messageId === 'm' && f.cardId)).toBe(true);
  });

  it('formats money the way the Brief shows it', () => {
    expect(formatMoney(1240, 'NOK')).toBe('1,240 NOK');
    expect(formatMoney(89.99, 'GBP')).toBe('£89.99');
    expect(formatMoney(1600, 'EUR')).toBe('€1,600');
  });
});

describe('ledger', () => {
  it('sorts with nulls last and totals by currency', () => {
    const rows = [{ amount: 10, currency: 'GBP', date: '2026-09-01' }, { amount: null, date: null }, { amount: 5.5, currency: 'GBP', date: '2026-09-03' }, { amount: 100, currency: 'NOK', date: '2026-08-01', cadence: 'yearly' }];
    expect(sortRows(rows, 'date', 'desc').map((r) => r.date)).toEqual(['2026-09-03', '2026-09-01', '2026-08-01', null]);
    expect(sortRows(rows, 'amount', 'asc')[0].amount).toBe(5.5);
    expect(totalsByCurrency(rows)).toEqual([{ currency: 'GBP', total: 15.5, count: 2 }, { currency: 'NOK', total: 100, count: 1 }]);
    expect(totalsByCurrency([{ amount: 120, currency: 'NOK', cadence: 'yearly' }, { amount: 10, currency: 'NOK', cadence: 'monthly' }], { monthly: true })[0]).toMatchObject({ total: 130, monthly: 20, unknownCadence: 0 });
    // A subscription whose cadence is unknown adds nothing to the monthly figure, and is counted as such.
    expect(totalsByCurrency([{ amount: 1322.84, currency: 'INR', cadence: null }], { monthly: true })[0]).toEqual({ currency: 'INR', total: 1322.84, count: 1, monthly: 0, unknownCadence: 1 });
  });
});

describe('actions', () => {
  const ev = { id: 'card-1', kind: 'event', messageId: 'm', fields: { title: "Parents' evening, class 4B", start: '2026-09-24T16:30:00.000Z', end: '2026-09-24T18:00:00.000Z', location: 'Møhlenpris skole; room 12' }, message: { subject: 'Invitation', thread_key: 't' } };
  it('builds an .ics for the calendar', () => {
    const { ics, filename, mime } = cardIcs(ev, { now: new Date('2026-09-23T08:00:00Z') });
    expect(mime).toBe('text/calendar');
    expect(filename).toBe('Parents-evening-class-4B.ics');
    expect(ics).toContain('DTSTART:20260924T163000Z\r\n');
    expect(ics).toContain('SUMMARY:Parents\' evening\\, class 4B');
    expect(ics).toContain('LOCATION:Møhlenpris skole\\; room 12');
    expect(ics).toContain('UID:card-1@hedwig');
    expect(cardIcs({ id: 'x', kind: 'invoice', fields: { dueDate: '2026-09-25', issuer: 'Fjordkraft', amount: 1240, currency: 'NOK' } }).ics).toContain('DTSTART;VALUE=DATE:20260925\r\nDTEND;VALUE=DATE:20260926');
    expect(foldIcs('X'.repeat(80)).split('\r\n ').map((l) => l.length)).toEqual([75, 5]);
  });

  it('builds reminder payloads without side effects', () => {
    expect(reminderFor(ev, { now: new Date('2026-09-23T08:00:00Z') })).toMatchObject({ title: "Parents' evening, class 4B", remindAt: '2026-09-24T15:30:00.000Z', messageId: 'm', threadId: 't', source: { kind: 'card', cardId: 'card-1' } });
    const bill = reminderFor({ id: 'b', kind: 'invoice', fields: { dueDate: '2026-09-30', issuer: 'Fjordkraft' } }, { tz: 'Europe/Oslo', now: new Date('2026-09-23T08:00:00Z') });
    expect(bill.remindAt).toBe('2026-09-28T07:00:00.000Z');
    expect(cardActions({ id: 'c', kind: 'code', fields: { code: '123456' } }).map((a) => a.id)).toEqual(['copy']);
    expect(cardActions(ev).map((a) => a.id)).toEqual(['calendar', 'reminder']);
  });
});

describe('kinds and text helpers', () => {
  it('normalises amounts, currencies and merchants', () => {
    expect([normAmount('1.240,50'), normAmount('1,240.50'), normAmount('89,99'), normAmount('£89.99'), normAmount('abc')]).toEqual([1240.5, 1240.5, 89.99, 89.99, null]);
    expect([normCurrency('£'), normCurrency('nok'), normCurrency('pounds')]).toEqual(['GBP', 'NOK', null]);
    expect(merchantKey('Netflix, Inc.')).toBe('netflix');
    expect(eventAt({ kind: 'invoice', fields: { dueDate: '2026-09-25' } })).toBe('2026-09-25T00:00:00.000Z');
  });

  it('parses loose dates and times', () => {
    const ref = '2026-09-23T08:00:00Z';
    expect(parseLooseDate('Arriving Thursday', ref)).toBe('2026-09-24');
    expect(parseLooseDate('arriving tomorrow', ref)).toBe('2026-09-24');
    expect(parseLooseDate('Estimated delivery: 26 September', ref)).toBe('2026-09-26');
    expect(parseLooseDate('Delivery on Oct 2, 2026', ref)).toBe('2026-10-02');
    expect(parseLooseDate('by 5 Jan', '2026-12-20T08:00:00Z')).toBe('2027-01-05');
    expect(parseByTime('between 8 and 12')).toBe('12:00');
    expect(parseByTime('by 4pm')).toBe('16:00');
    expect(sentenceAround('First one. The total is £89.99 today. Last.', 20)).toBe('The total is £89.99 today.');
  });
});
