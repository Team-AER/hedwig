// Card kinds: their fields, how a card names the thing it is about (dedupe key), and the date it is
// about (event_at). Shared by the detectors, the Reflex prompt, the store and the routes.

export const CARD_KINDS = ['receipt', 'invoice', 'subscription', 'delivery', 'travel', 'event', 'code', 'deadline'];
export const DELIVERY_STATUSES = ['ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'unknown'];
export const TRAVEL_TYPES = ['flight', 'train', 'bus', 'hotel', 'car', 'other'];
export const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'];

// type: string | number | date (YYYY-MM-DD) | datetime (ISO) | boolean | enum | items
export const FIELDS = {
  receipt: { merchant: 'string', orderNumber: 'string', total: 'number', currency: 'string', date: 'date', items: 'items', paymentMethod: 'string' },
  invoice: { issuer: 'string', invoiceNumber: 'string', amount: 'number', currency: 'string', issuedDate: 'date', dueDate: 'date', status: ['due', 'paid', 'overdue'] },
  subscription: { merchant: 'string', amount: 'number', currency: 'string', cadence: CADENCES, lastCharged: 'date', nextRenewal: 'date', charges: 'number' },
  delivery: { carrier: 'string', trackingNumber: 'string', trackingUrl: 'string', status: DELIVERY_STATUSES, expectedDate: 'date', expectedBy: 'string', merchant: 'string', item: 'string' },
  travel: { type: TRAVEL_TYPES, provider: 'string', reference: 'string', from: 'string', to: 'string', departAt: 'datetime', arriveAt: 'datetime', flightNumber: 'string', checkIn: 'date', checkOut: 'date', location: 'string', passenger: 'string' },
  event: { title: 'string', start: 'datetime', end: 'datetime', allDay: 'boolean', location: 'string', organizer: 'string', uid: 'string', method: 'string', status: 'string' },
  code: { code: 'string', service: 'string', purpose: 'string', expiresAt: 'datetime' },
  deadline: { what: 'string', dueAt: 'datetime', direction: ['i_owe', 'they_owe'], counterparty: 'string' },
};

// Fields maintained by Hedwig, never set by an edit.
export const INTERNAL_FIELDS = new Set(['history', 'messageIds', 'receipts', 'sequence']);

const CURRENCY_SYMBOLS = { '£': 'GBP', '€': 'EUR', $: 'USD', '¥': 'JPY', '₹': 'INR', kr: 'NOK', 'US$': 'USD', 'A$': 'AUD', 'C$': 'CAD' };

/** 'GBP' from '£', 'gbp', 'GBP'; null when unknown. */
export function normCurrency(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (CURRENCY_SYMBOLS[s]) return CURRENCY_SYMBOLS[s];
  return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
}

/** 1240, '1,240.50', '1.240,50', '£89.99' → number; null when not a number. */
export function normAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  if (v == null) return null;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  if (/,\d{2}$/.test(s) && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');      // 1.240,50
  else if (/,\d{2}$/.test(s) && !s.includes('.')) s = s.replace(',', '.');                    // 89,99
  else s = s.replace(/,/g, '');                                                               // 1,240.50
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function normDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function normDateTime(v) {
  if (v == null || v === '') return null;
  const d = new Date(String(v).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Coerce one field to its declared type; undefined when the value does not fit. */
export function normField(kind, key, value) {
  const type = FIELDS[kind]?.[key];
  if (!type || value == null || value === '') return undefined;
  if (Array.isArray(type)) { const v = String(value).toLowerCase().trim(); return type.includes(v) ? v : undefined; }
  switch (type) {
    case 'number': { const n = normAmount(value); return n == null ? undefined : n; }
    case 'date': return normDate(value) ?? undefined;
    case 'datetime': return normDateTime(value) ?? undefined;
    case 'boolean': return typeof value === 'boolean' ? value : /^(true|yes|1)$/i.test(String(value)) ? true : /^(false|no|0)$/i.test(String(value)) ? false : undefined;
    case 'items':
      return Array.isArray(value)
        ? value.slice(0, 30).map((it) => ({ name: String(it?.name || '').slice(0, 200), quantity: normAmount(it?.quantity) ?? 1, price: normAmount(it?.price) }))
          .filter((it) => it.name)
        : undefined;
    default: {
      const s = String(value).replace(/\s+/g, ' ').trim();
      if (!s) return undefined;
      return key === 'currency' ? (normCurrency(s) ?? undefined) : s.slice(0, 300);
    }
  }
}

/** Keep only a kind's declared fields, coerced. */
export function normFields(kind, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const n = normField(kind, k, v);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/** Lower-case, no punctuation or company suffixes: 'Netflix, Inc.' → 'netflix'. */
export function merchantKey(name) {
  return String(name || '').toLowerCase()
    .replace(/\b(inc|ltd|llc|gmbh|as|ab|plc|limited|co|corp|corporation|bv|sa|srl)\b\.?/g, '')
    .replace(/\.(com|co\.uk|net|org|io|no|se|de)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Words that name a department or a mail stream of a payee, not the payee: "Zomato Order",
// "Mouser Order Update", "GoDaddy Renewals", "Anthropic, PBC", "Tata Starbucks Private".
const PAYEE_NOISE = new Set(['pbc', 'pvt', 'private', 'pte', 'india', 'order', 'orders', 'update', 'updates', 'renewal', 'renewals', 'billing',
  'payment', 'payments', 'receipt', 'receipts', 'invoice', 'invoices', 'services', 'service', 'support', 'team', 'media', 'technologies', 'the',
  'electronics', 'labs', 'software', 'systems', 'solutions', 'online', 'retail', 'digital', 'global', 'international', 'ventures', 'enterprises']);
// One payee under several names (the brand on the receipt, the legal name on the card statement).
const PAYEE_ALIASES = { goindigo: 'indigo', 'interglobe aviation': 'indigo', 'bigtree entertainment': 'bookmyshow', claude: 'anthropic', chatgpt: 'openai' };

/**
 * Who a charge is paid to, for grouping charges into bills: 'Anthropic, PBC' and 'ANTHROPIC' are one
 * payee, so are 'Zomato Order' and 'ZOMATO'. Looser than merchantKey, which names cards and the
 * owner's feedback and must not change under them. Pure.
 */
export function payeeKey(name) {
  const base = merchantKey(String(name || '').replace(/\.in\b/gi, ''));
  const words = base.split(' ').filter((w) => w && !PAYEE_NOISE.has(w));
  const key = (words.length ? words : base.split(' ')).join(' ').trim();
  return PAYEE_ALIASES[key] || key;
}

// The currency a sentence states: "USD 23.6 spent at ANTHROPIC", "INR 1,995.8", "Rs.499", "£48.00".
const CURRENCY_IN_TEXT = /(?:^|[^A-Za-z])(INR|USD|EUR|GBP|SGD|AUD|CAD|NOK|SEK|DKK|JPY|AED|Rs\.?|US\$|S\$|A\$|C\$|₹|£|€|\$)(?=\s?\d|[^A-Za-z]|$)/;
const CURRENCY_WORD = { 'RS': 'INR', 'RS.': 'INR', 'US$': 'USD', 'S$': 'SGD', 'A$': 'AUD', 'C$': 'CAD', '₹': 'INR', '£': 'GBP', '€': 'EUR', $: 'USD' };

/** The first currency a text names, as a code; null when it names none. Pure. */
export function currencyFromText(text) {
  const m = CURRENCY_IN_TEXT.exec(String(text || ''));
  if (!m) return null;
  const tok = m[1].toUpperCase();
  return CURRENCY_WORD[tok] || (/^[A-Z]{3}$/.test(tok) ? tok : null);
}

/** The key naming the thing a card is about; cards with the same key are one card. */
export function dedupeKey(card) {
  const f = card.fields || {};
  const byMsg = `msg:${card.messageId}`;
  switch (card.kind) {
    case 'receipt': return f.orderNumber ? `order:${merchantKey(f.merchant)}:${String(f.orderNumber).toUpperCase()}` : byMsg;
    case 'invoice': return f.invoiceNumber ? `invoice:${merchantKey(f.issuer)}:${String(f.invoiceNumber).toUpperCase()}` : byMsg;
    case 'delivery': return f.trackingNumber ? `track:${String(f.trackingNumber).replace(/\s+/g, '').toUpperCase()}` : byMsg;
    case 'travel': {
      const leg = f.flightNumber || [f.from, f.to].filter(Boolean).join('-') || '';
      const day = (f.departAt || f.checkIn || '').slice(0, 10);
      return f.reference ? `ref:${String(f.reference).toUpperCase()}:${leg.toUpperCase()}:${day}` : `${byMsg}:${leg}:${day}`;
    }
    case 'event': return f.uid ? `uid:${f.uid}` : `${byMsg}:${merchantKey(f.title)}:${f.start || ''}`;
    case 'code': return `${byMsg}:${f.code}`;
    case 'subscription': return `merchant:${merchantKey(f.merchant)}:${f.currency || ''}`;
    default: return byMsg;
  }
}

/** The date a card is about, for sorting and the Brief. */
export function eventAt(card, messageDate = null) {
  const f = card.fields || {};
  const pick = {
    receipt: f.date, invoice: f.dueDate || f.issuedDate, subscription: f.nextRenewal, delivery: f.expectedDate,
    travel: f.departAt || f.checkIn, event: f.start, code: null, deadline: f.dueAt,
  }[card.kind];
  const d = new Date(pick || messageDate || NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
