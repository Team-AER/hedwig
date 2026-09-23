// Order, booking and invoice references in plain mail, for the senders that embed no schema.org
// markup (most of them: Shopify stores, Indian airlines and travel agents, small web shops). A card
// is made only from a reference the mail states next to a word that names it ("Order #24176",
// "Booking ID: NF2A…", "PNR: HCYP2A", "Tax Invoice - KL12…"), with the total when the mail states one
// next to a total word. Everything else (dates, routes, items) is left to the Reflex fill, which
// merges into the same card. Every field's source is the sentence it came from.
import { detectText, sentenceAround } from '../text.js';

// Mail that probably carries a card: subject words and sender local parts. Used to decide which
// People/Records mail the Reflex model reads when no bundle says so.
const SUBJECT_SIGNAL = /\b(orders?|invoice|taxinvoice|receipt|booking|booked|reservation|e-?tickets?|tickets?|boarding pass|itinerary|pnr|shipment|shipped|dispatched|delivered|delivery|tracking|out for delivery|payment (?:received|confirmation|successful|confirmed)|subscription|renewal|renews?|your (?:trip|flight|stay|stay at)|web check-?in|check-?in|awb|waybill|bill (?:is )?(?:due|ready)|statement|domain (?:registered|renewal)|purchase)\b/i;
const SENDER_SIGNAL = /^(orders?|order-?updates?|receipts?|billing|invoices?|gstinvoice|\w*invoice|bookings?|reservations?|tickets?|shipping|shipment|delivery|deliveries|tracking|payments?|store\+\d+)$/i;

/** Does this message look like data (an order, booking, invoice, ticket, delivery)? Pure. */
export function dataSignal(row) {
  const local = String(row?.from_email || '').toLowerCase().split('@')[0];
  return SUBJECT_SIGNAL.test(String(row?.subject || '')) || SENDER_SIGNAL.test(local);
}

const REF = '([A-Z0-9][A-Z0-9-]{3,29})';
const ORDER_RE = new RegExp(String.raw`\border\s*(?:#|no\.?|number|id|ref(?:erence)?)?\s*[:#]?\s*#?${REF}`, 'gi');
const BOOKING_RE = new RegExp(String.raw`\b(?:booking|reservation|confirmation|trip)\s*(?:#|id|no\.?|number|ref(?:erence)?|code)\s*[:#]?\s*${REF}`, 'gi');
const PNR_RE = /\bPNR\s*(?:no\.?|number)?\s*[:#-]?\s*([A-Z0-9]{5,8})\b/g;
const INVOICE_RE = new RegExp(String.raw`\b(?:tax\s*)?invoice\s*(?:#|no\.?|number|id)?\s*[:#-]?\s*${REF}`, 'gi');
const TOTAL_RE = /\b(grand total|order total|total amount|total paid|amount paid|amount due|total due|amount payable|total)\b\s*(?:\(incl[^)]*\))?\s*[:-]?\s*(rs\.?|inr|₹|£|€|\$|usd|eur|gbp|nok|sek|dkk)?\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(inr|usd|eur|gbp|nok|sek|dkk)?/gi;
const RECEIPT_CONTEXT = /order (?:is )?(?:confirmed|placed|received)|thank you for (?:your )?(?:order|purchase|shopping)|payment (?:received|successful|confirmed)|order summary|amount paid|your order|purchase confirmation|receipt/i;
const TRAVEL_CONTEXT = /\b(flight|boarding|airline|airport|e-?ticket|pnr|web check-?in|itinerary|departure|hotel|check-?in date|stay|train|rail|coach|cab booking)\b/i;

const CURRENCY = { 'rs': 'INR', 'rs.': 'INR', 'inr': 'INR', '₹': 'INR', '£': 'GBP', '€': 'EUR', '$': 'USD', usd: 'USD', eur: 'EUR', gbp: 'GBP', nok: 'NOK', sek: 'SEK', dkk: 'DKK' };

/**
 * A reference must carry a digit and not be a year, a date or a phone number. With lettersOk (after
 * "Booking ID" / "PNR"), 6–10 capital letters also count ("TGAMAVT"). Pure.
 */
export function plausibleRef(ref, { lettersOk = false } = {}) {
  const r = String(ref || '').replace(/-+$/, '');
  if (lettersOk && /^[A-Z]{6,10}$/.test(r)) return r;
  if (r.length < 4 || !/\d/.test(r)) return null;
  if (/^(19|20)\d{2}$/.test(r) || /^\d{1,2}-\d{1,2}(-\d{2,4})?$/.test(r)) return null;
  if (/^\+?\d{12,}$/.test(r) && !/[A-Z]/i.test(r) && r.length > 16) return null;
  return r.toUpperCase();
}

function firstRef(re, text, opts) {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const ref = plausibleRef(m[1], opts);
    if (ref) return { ref, index: m.index };
  }
  return null;
}

/** The first stated total ("Amount paid Rs.1322.84", "Total: £48.00"). Pure. */
export function findTotal(text) {
  TOTAL_RE.lastIndex = 0;
  for (const m of text.matchAll(TOTAL_RE)) {
    const amount = Number(m[3].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const cur = (m[2] || m[4] || '').toLowerCase();
    return { amount: Math.round(amount * 100) / 100, currency: CURRENCY[cur] || null, index: m.index };
  }
  return null;
}

/** "REES52" from the display name; "Goindigo" from 6egstinvoice@goindigo.in when the name is an address. Pure. */
export function senderName(row) {
  const name = String(row?.from_name || '').replace(/\s+via\s+.*$/i, '').trim();
  if (name && !/@/.test(name)) return name.slice(0, 120);
  const domain = String(row?.from_email || '').toLowerCase().split('@')[1] || '';
  const parts = domain.split('.').filter((p) => !['com', 'co', 'in', 'uk', 'net', 'org', 'io', 'mail', 'email', 'e', 'notify', 't', 'shopifyemail'].includes(p));
  const base = parts[parts.length - 1] || domain;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
}

function travelType(text, subject = '') {
  // The subject names the booking; a body can mention an airport shuttle or a flight upsell.
  if (subject) {
    if (/\bhotel|voucher for .*\b(inn|hotel|resort|suites?)\b|\bstay\b/i.test(subject)) return 'hotel';
    if (/\bcab\b|\btaxi\b|car rental/i.test(subject)) return 'car';
    if (/\b(train|rail|irctc)\b/i.test(subject)) return 'train';
    if (/\b(flight|boarding|pnr|web check-?in|e-?ticket)\b/i.test(subject)) return 'flight';
  }
  if (/\b(flight|boarding|airline|airport|pnr|web check-?in)\b/i.test(text)) return 'flight';
  if (/\bhotel|check-?in date|\bstay\b/i.test(text)) return 'hotel';
  if (/\b(train|rail)\b/i.test(text)) return 'train';
  if (/\bcab\b|\btaxi\b|car rental/i.test(text)) return 'car';
  return 'other';
}

/**
 * Pattern cards for one message. Pure.
 * @param {{ id, subject, from_name, from_email, date, body_text?, body_html?, snippet? }} row
 */
export function detectOrders(row) {
  const text = detectText(row, { maxChars: 12000 });
  const subject = String(row.subject || '');
  if (!SUBJECT_SIGNAL.test(subject) && !RECEIPT_CONTEXT.test(text)) return [];
  const src = (index) => ({ messageId: row.id, quote: sentenceAround(text, index), via: 'pattern' });
  const header = { messageId: row.id, quote: `From: ${row.from_name || ''} <${row.from_email || ''}>`.trim(), via: 'header' };
  const who = senderName(row);
  const total = findTotal(text);
  const withTotal = (fields, sources, amountKey) => {
    if (!total) return;
    fields[amountKey] = total.amount;
    sources[amountKey] = src(total.index);
    if (total.currency) { fields.currency = total.currency; sources.currency = src(total.index); }
  };
  const cards = [];

  const invoice = firstRef(INVOICE_RE, text);
  if (invoice) {
    const fields = { invoiceNumber: invoice.ref };
    const sources = { invoiceNumber: src(invoice.index) };
    if (who) { fields.issuer = who; sources.issuer = header; }
    withTotal(fields, sources, 'amount');
    cards.push({ kind: 'invoice', messageId: row.id, fields, sources, confidence: 0.8, layer: 'pattern' });
  }

  const pnr = firstRef(PNR_RE, text, { lettersOk: true });
  const booking = firstRef(BOOKING_RE, text, { lettersOk: true });
  const travel = TRAVEL_CONTEXT.test(text);
  if (travel && (pnr || booking)) {
    const ref = pnr || booking;
    const fields = { type: travelType(text, subject), reference: ref.ref };
    const sources = { type: src(ref.index), reference: src(ref.index) };
    if (who) { fields.provider = who; sources.provider = header; }
    cards.push({ kind: 'travel', messageId: row.id, fields, sources, confidence: 0.75, layer: 'pattern' });
  }

  const order = firstRef(ORDER_RE, text) || (!travel && booking && total ? booking : null);
  if (order && (RECEIPT_CONTEXT.test(text) || /\border\b/i.test(subject) || total) && !(invoice && invoice.ref === order.ref)) {
    const fields = { orderNumber: order.ref };
    const sources = { orderNumber: src(order.index) };
    if (who) { fields.merchant = who; sources.merchant = header; }
    withTotal(fields, sources, 'total');
    cards.push({ kind: 'receipt', messageId: row.id, fields, sources, confidence: 0.75, layer: 'pattern' });
  }
  return cards;
}

// Fields a pattern card of each kind still wants from the Reflex model.
const WANTS = {
  receipt: (f) => f.total == null,
  invoice: (f) => f.amount == null && !f.dueDate,
  travel: (f) => !f.departAt && !f.checkIn,
  delivery: (f) => !f.expectedDate && (!f.status || f.status === 'shipped'),
};

/** Should the Reflex model fill these deterministic cards? Only pattern cards missing their main figure. Pure. */
export function needsFill(cards) {
  return cards.some((c) => c.layer === 'pattern' && WANTS[c.kind]?.(c.fields || {}));
}
