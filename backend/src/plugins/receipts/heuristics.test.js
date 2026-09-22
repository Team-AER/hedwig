import { describe, it, expect } from 'vitest';
import { scoreReceipt, parseAmount, pickTotal, heuristicExtract, normaliseReceipt, summarise, toCsv, filterReceipts } from './heuristics.js';

const receipt = {
  subject: 'Your receipt from Acme Coffee #1042',
  from_name: 'Acme Coffee Receipts',
  from_email: 'receipts@acmecoffee.com',
  date: '2026-09-12T08:30:00Z',
  folder: 'INBOX',
  text: 'Thanks for your order!\nFlat white   £3.20\nCroissant   £2.10\nSubtotal £5.30\nTotal: £5.30\nOrder number: AC-99812',
};
const promo = { subject: '48 hours only: 30% off everything', from_email: 'news@shop.example', text: 'Save £20 today on orders over £100. Unsubscribe.' };
const shipping = { subject: 'Your order has shipped', from_email: 'orders@shop.example', text: 'Track your parcel. Order number: 12345678' };

describe('receipt detection', () => {
  it('scores a real receipt above the default threshold and promotions below it', () => {
    expect(scoreReceipt(receipt).score).toBeGreaterThanOrEqual(4);
    expect(scoreReceipt(promo).score).toBeLessThan(4);
    expect(scoreReceipt(shipping).score).toBeLessThan(4);
  });
  it('ignores sent mail', () => {
    expect(scoreReceipt({ ...receipt, folder: 'Sent' }).score).toBe(0);
  });
});

describe('amounts', () => {
  it('parses US and European formats', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('12,50')).toBe(12.5);
    expect(parseAmount('1,234')).toBe(1234);
  });
  it('prefers the total line over the subtotal and items', () => {
    expect(pickTotal('Item €9.99\nShipping €4.00\nSubtotal €13.99\nGrand total €13.99')).toMatchObject({ amount: 13.99, currency: 'EUR' });
    expect(pickTotal('Charged USD 42.00 to your card')).toMatchObject({ amount: 42, currency: 'USD' });
    expect(pickTotal('Betrag: 19,90 €')).toMatchObject({ amount: 19.9, currency: 'EUR' });
    expect(pickTotal('no money here')).toBeNull();
  });
  it('extracts vendor, amount, date and reference by rule', () => {
    expect(heuristicExtract(receipt)).toEqual({ vendor: 'Acme Coffee', amount: 5.3, currency: 'GBP', date: '2026-09-12', order_ref: 'AC-99812', category: 'food' });
  });
});

describe('model output', () => {
  it('keeps only well-typed fields from the model and falls back for the rest', () => {
    const fb = heuristicExtract(receipt);
    const out = normaliseReceipt({ vendor: 'Acme Coffee Ltd', amount: '5.30', currency: 'gbp', date: 'yesterday', category: 'crypto', order_ref: 42 }, fb);
    expect(out).toEqual({ ...fb, vendor: 'Acme Coffee Ltd', amount: 5.3, currency: 'GBP' });
    expect(normaliseReceipt(null, fb)).toEqual(fb);
    expect(normaliseReceipt({ amount: -3 }, fb).amount).toBe(5.3);
  });
});

describe('ledger', () => {
  const rows = [
    { date: '2026-09-12', vendor: 'Acme', amount: 5.3, currency: 'GBP', messageId: 'a' },
    { date: '2026-09-02', vendor: 'Acme', amount: 4.7, currency: 'GBP', messageId: 'b' },
    { date: '2026-08-30', vendor: '=HYPERLINK("x")', amount: 10, currency: 'EUR', messageId: 'c' },
  ];
  it('totals by month and vendor without mixing currencies', () => {
    const s = summarise(rows);
    expect(s.byMonth).toEqual([
      { month: '2026-09', currency: 'GBP', total: 10, count: 2 },
      { month: '2026-08', currency: 'EUR', total: 10, count: 1 },
    ]);
    expect(s.byVendor[0]).toMatchObject({ vendor: 'Acme', total: 10, currency: 'GBP' });
  });
  it('exports CSV with formula injection neutralised', () => {
    const csv = toCsv(rows);
    expect(csv.split('\r\n')[0]).toBe('date,vendor,amount,currency,category,order_ref,subject,from,message_id');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('filters by month and vendor', () => {
    expect(filterReceipts(rows, { month: '2026-09' })).toHaveLength(2);
    expect(filterReceipts(rows, { vendor: 'acm' })).toHaveLength(2);
  });
});
