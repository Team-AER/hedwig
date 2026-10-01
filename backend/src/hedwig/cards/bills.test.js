import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));

const { payeeKey, currencyFromText, merchantKey } = await import('./kinds.js');
const { classifyPayees, findSubscriptions, dedupeCharges, cadenceInText, knownPayee } = await import('./subscriptions.js');
const { chargeOf, directionOf, fillCurrencies, buildBills, billStatus, billTotals, parsePayee } = await import('./bills.js');
const { matchOrphan, cardQuotes } = await import('./relink.js');
const { reflexEligible, trashMoneySignal } = await import('./extract.js');
const { totalsByCurrency } = await import('./ledger.js');

const KNOWN = ['anthropic', 'openai', 'ollama', 'netflix', 'youtube'];
const charge = (date, amount, merchant, currency = 'USD', extra = {}) => ({
  cardId: `c-${merchant}-${date}`, messageId: `m-${merchant}-${date}`, merchant, amount, currency, date, kind: 'receipt', ...extra,
});

describe('payees', () => {
  it('one payee under the names a receipt and a card alert use', () => {
    expect(payeeKey('Anthropic, PBC')).toBe('anthropic');
    expect(payeeKey('ANTHROPIC')).toBe('anthropic');
    expect(payeeKey('Zomato Order')).toBe(payeeKey('Zomato Media Private Limited'));
    expect(payeeKey('Mouser Order Update')).toBe(payeeKey('MOUSER ELECTRONICS INC'));
    expect(payeeKey('GoDaddy Renewals')).toBe('godaddy');
    expect(payeeKey('Amazon.in')).toBe('amazon');
    expect(payeeKey('Interglobe Aviation Limited')).toBe(payeeKey('goindigo'));
    // A name made only of noise words is kept, not emptied.
    expect(payeeKey('Order')).toBe('order');
    // merchantKey, which names cards and feedback, is unchanged.
    expect(merchantKey('Anthropic, PBC')).toBe('anthropic pbc');
  });

  it('reads the currency a sentence states', () => {
    expect(currencyFromText('USD 23.6 spent at ANTHROPIC')).toBe('USD');
    expect(currencyFromText('INR 1,995.8 spent at OLLAMA')).toBe('INR');
    expect(currencyFromText('Rs.499 debited')).toBe('INR');
    expect(currencyFromText('Total: £48.00')).toBe('GBP');
    expect(currencyFromText('on 28/09/26 at 12:52:11 PM')).toBeNull();
    expect(currencyFromText('INRxyz')).toBeNull();
  });

  it('a known service matches longer names that start with it', () => {
    expect(knownPayee('youtube premium', KNOWN)).toBe(true);
    expect(knownPayee('you', KNOWN)).toBe(false);
    expect(knownPayee('anthropic', null)).toBe(false);
  });
});

describe('subscriptions from fewer charges, with evidence', () => {
  const now = new Date('2026-10-01');

  it('a card alert and the merchant\'s receipt for one payment are one charge', () => {
    const series = dedupeCharges([
      { t: Date.parse('2026-09-28T12:00:00Z'), amount: 23.6, merchant: 'ANTHROPIC' },
      { t: Date.parse('2026-09-29T12:00:00Z'), amount: 23.6, merchant: 'Anthropic, PBC' },
      { t: Date.parse('2026-10-28T12:00:00Z'), amount: 23.6, merchant: 'ANTHROPIC' },
    ]);
    expect(series).toHaveLength(2);
    expect(series[0].also).toHaveLength(1);
  });

  it('two steady charges a month apart from a known service are a subscription', () => {
    const c = [charge('2026-08-28', 23.6, 'ANTHROPIC'), charge('2026-09-28', 23.6, 'Anthropic, PBC')];
    expect(findSubscriptions(c, { now, known: KNOWN })).toMatchObject([{ payee: 'anthropic', cadence: 'monthly', nextRenewal: '2026-10-28', charges: 2 }]);
    // Unknown and silent, the same two charges only make a candidate.
    expect(findSubscriptions(c, { now })).toEqual([]);
    expect(classifyPayees(c, { now })).toMatchObject([{ verdict: 'candidate', reason: 'no_evidence', cadence: 'monthly' }]);
  });

  it('one charge whose mail names its cadence and says it recurs is a subscription', () => {
    const one = [charge('2026-09-10', 236, 'Anthropic, PBC', 'USD', { subject: 'Your Claude Max subscription renews monthly' })];
    expect(cadenceInText(one[0])).toBe('monthly');
    expect(findSubscriptions(one, { now })).toMatchObject([{ cadence: 'monthly', nextRenewal: '2026-10-10' }]);
  });

  it('one charge from a known service is a candidate with no cadence yet', () => {
    expect(classifyPayees([charge('2026-10-01', 1995.8, 'OLLAMA', 'INR')], { now, known: KNOWN }))
      .toMatchObject([{ verdict: 'candidate', reason: 'cadence_unknown', cadence: null, evidence: { known: true } }]);
  });

  it('still never the BookMyShow tickets, even as a candidate', () => {
    const bms = (date, amount, order) => charge(date, amount, 'BookMyShow', 'INR', { orderNumber: order, subject: 'Your booking is confirmed!' });
    const two = [bms('2026-06-12', 1039.24, 'WX6NCTF'), bms('2026-07-12', 1322.84, 'TGAMAVT')];
    expect(classifyPayees(two, { now, known: KNOWN })).toMatchObject([{ verdict: 'one_off' }]);
  });

  it('money coming in, and payees the owner turned down, are never subscriptions', () => {
    const c = [charge('2026-08-28', 23.6, 'ANTHROPIC'), charge('2026-09-28', 23.6, 'ANTHROPIC')];
    expect(findSubscriptions(c.map((x) => ({ ...x, direction: 'in' })), { now, known: KNOWN })).toEqual([]);
    expect(classifyPayees(c, { now, known: KNOWN, oneOff: new Set(['anthropic']) })).toMatchObject([{ verdict: 'one_off', reason: 'owner_one_off' }]);
    // The owner's old feedback is under the merchant key; it still counts.
    expect(classifyPayees([charge('2026-08-28', 9, 'Anthropic, PBC'), charge('2026-09-28', 9, 'Anthropic, PBC')], { now, known: KNOWN, oneOff: new Set(['anthropic pbc']) })[0].verdict).toBe('one_off');
  });
});

describe('charges', () => {
  const card = (fields, sources = {}, extra = {}) => ({ id: 'c1', kind: 'receipt', fields, sources, messageId: 'm1', messageIds: ['m1'], message: null, layer: 'reflex', ...extra });

  it('reads the currency from the amount\'s sentence when the field is empty', () => {
    const c = chargeOf(card({ merchant: 'OLLAMA', total: 1995.8, date: '2026-10-01' }, { total: { quote: 'INR 1,995.8' } }));
    expect(c).toMatchObject({ currency: 'INR', currencyGuessed: true, payee: 'ollama', direction: 'out' });
  });

  it('falls back to the sender for the merchant, and knows a deposit from a payment', () => {
    expect(chargeOf(card({ total: 9.68, currency: 'USD' }, {}, { message: { from_name: 'GitHub', from_email: 'noreply@github.com', subject: '[GitHub] Payment Receipt' } })).merchant).toBe('GitHub');
    expect(directionOf(card({ total: 11568, merchant: 'HDFC Bank' }, { total: { quote: 'Amount received: INR 11,568.00' } }))).toBe('in');
    expect(directionOf(card({ total: 179 }, { total: { quote: 'Payment received: ₹179' } }))).toBe('out');
    expect(directionOf(card({ total: 23.6 }, { total: { quote: 'USD 23.6 spent at ANTHROPIC' } }))).toBe('out');
    expect(directionOf(card({ total: -19130 }))).toBe('in');
  });

  it('a charge without a currency takes its payee\'s when the payee has one', () => {
    const out = fillCurrencies([
      { payee: 'zomato', currency: 'INR' }, { payee: 'zomato', currency: null }, { payee: 'paypal', currency: null },
      { payee: 'mixed', currency: 'USD' }, { payee: 'mixed', currency: 'INR' }, { payee: 'mixed', currency: null },
    ]);
    expect(out.map((c) => c.currency)).toEqual(['INR', 'INR', null, 'USD', 'INR', null]);
    expect(out[1].currencyGuessed).toBe(true);
  });

  it('purchases totals leave money coming in out', () => {
    expect(totalsByCurrency([{ amount: 100, currency: 'INR' }, { amount: 11568, currency: 'INR', direction: 'in' }])).toEqual([{ currency: 'INR', total: 100, count: 1 }]);
  });
});

describe('bills', () => {
  const now = new Date('2026-10-01T09:00:00Z');
  const sub = (fields, extra = {}) => ({ id: `s-${fields.merchant}`, kind: 'subscription', fields, sources: {}, layer: 'derived', messageId: null, message: null, ...extra });

  it('statuses: late renewals, due soon, overdue invoices, ended', () => {
    expect(billStatus({ nextDue: '2026-09-28' }, '2026-10-01')).toBe('late');
    expect(billStatus({ nextDue: '2026-09-28', invoice: true }, '2026-10-01')).toBe('overdue');
    expect(billStatus({ nextDue: '2026-10-05' }, '2026-10-01')).toBe('due_soon');
    expect(billStatus({ nextDue: '2026-10-20' }, '2026-10-01')).toBe('upcoming');
    expect(billStatus({ nextDue: null }, '2026-10-01')).toBe('unknown');
    expect(billStatus({ nextDue: null, invoice: true }, '2026-10-01')).toBe('due');
    expect(billStatus({ nextDue: '2026-10-20', lapsed: true }, '2026-10-01')).toBe('ended');
  });

  it('builds bills from found subscriptions, stored cards and unpaid invoices; asks about candidates', () => {
    const charges = [
      charge('2026-08-28', 23.6, 'ANTHROPIC'), charge('2026-09-28', 23.6, 'Anthropic, PBC'),
      charge('2026-09-28', 11.8, 'OPENAI'),
      charge('2026-09-01', 349, 'Telia', 'NOK', { kind: 'invoice', status: 'due', dueDate: '2026-10-04', cardId: 'inv-1' }),
      charge('2026-09-27', 684.44, 'ZOMATO', 'INR'),
    ];
    const subscriptions = [sub({ merchant: 'Spotify', amount: 179, currency: 'INR', cadence: 'monthly', lastCharged: '2026-09-15' })];
    const view = buildBills({ charges, subscriptions, now, known: KNOWN });
    expect(view.bills.map((b) => [b.payee, b.status, b.nextDue])).toEqual([
      ['telia', 'due_soon', '2026-10-04'],
      ['spotify', 'upcoming', '2026-10-15'],
      ['anthropic', 'upcoming', '2026-10-28'],
    ]);
    expect(view.bills.find((b) => b.payee === 'spotify')).toMatchObject({ monthly: 179, cardId: 's-Spotify' });
    expect(view.candidates.map((c) => c.payee)).toEqual(['openai']);
    expect(view.totals.find((t) => t.currency === 'NOK')).toMatchObject({ due: 349, dueCount: 1 });
    expect(view.totals.find((t) => t.currency === 'USD')).toMatchObject({ monthly: 23.6, count: 1 });
  });

  it('a stored subscription the owner turned down is not a bill unless they made it', () => {
    const subscriptions = [sub({ merchant: 'Pocket' }), sub({ merchant: 'Gym', cadence: 'monthly', amount: 30 }, { layer: 'user' })];
    const view = buildBills({ charges: [], subscriptions, now, oneOff: new Set(['pocket', 'gym']) });
    expect(view.bills.map((b) => b.payee)).toEqual(['gym']);
  });

  it('a renewal long overdue has ended and leaves the monthly total', () => {
    const view = buildBills({ charges: [], subscriptions: [sub({ merchant: 'Netflix', amount: 199, currency: 'INR', cadence: 'monthly', lastCharged: '2026-05-01' })], now });
    expect(view.bills[0].status).toBe('ended');
    expect(billTotals(view.bills)).toEqual([]);
  });

  it('a payee in a route is normalised, and an empty one is refused', () => {
    expect(parsePayee('Anthropic, PBC')).toBe('anthropic');
    expect(() => parsePayee('  ')).toThrow(/invalid payee/);
  });
});

describe('cards whose mail moved', () => {
  const orphan = {
    fields: { merchant: 'ANTHROPIC', total: 23.6, date: '2026-09-28' },
    sources: { total: { quote: 'USD 23.6 spent at ANTHROPIC' }, date: { quote: 'on 28/09/26 at 12:52:11 PM' }, currency: { quote: 'USD 23.6 spent at ANTHROPIC' } },
  };

  it('finds the moved copy by the sentences the card kept, near its date', () => {
    expect(cardQuotes(orphan)).toHaveLength(2);
    const rows = [
      { id: 'other', date: '2026-09-28T07:00:00Z', body_text: 'USD 11.8 spent at OPENAI on 28/09/26 at 12:52:11 PM' },
      { id: 'far', date: '2026-08-01T07:00:00Z', body_text: 'USD 23.6 spent at ANTHROPIC on 28/09/26 at 12:52:11 PM' },
      { id: 'moved', date: '2026-09-28T07:24:00Z', subject: 'A payment was made using your Credit Card', body_text: 'Dear Customer, USD 23.6 spent at ANTHROPIC on 28/09/26 at 12:52:11 PM.' },
    ];
    expect(matchOrphan(orphan, rows)).toBe('moved');
    expect(matchOrphan(orphan, rows.slice(0, 2))).toBeNull();
    expect(matchOrphan({ fields: {}, sources: { total: { quote: '23.6' } } }, rows)).toBeNull();
  });
});

describe('Trash mail', () => {
  it('is read when its subject is about a charge', () => {
    expect(trashMoneySignal({ subject: 'A payment was made using your Credit Card' })).toBe(true);
    expect(trashMoneySignal({ subject: '❗  You have done a UPI txn. Check details!' })).toBe(true);
    expect(trashMoneySignal({ subject: 'Your receipt from Anthropic, PBC #2480-4450-9744' })).toBe(true);
    expect(trashMoneySignal({ subject: '❗ New Deposit Alert: Check your A/c balance now!' })).toBe(false);
    expect(trashMoneySignal({ subject: 'Anthropic warned to slow down AI' })).toBe(false);
    const bundles = new Set(['finance']);
    expect(reflexEligible({ trash: true, subject: 'A payment was made using your Credit Card' }, { bundles })).toBe(true);
    expect(reflexEligible({ trash: false, subject: 'A payment was made using your Credit Card' }, { bundles })).toBe(false);
  });
});
