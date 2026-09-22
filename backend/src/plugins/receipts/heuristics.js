// Receipt detection and parsing rules. Pure functions: no I/O, no facade, easy to test.

const SUBJECT_STRONG = /\b(receipt|invoice|order confirm(?:ation|ed)|your order|payment (?:received|confirmation|successful)|purchase confirmation|billing statement|tax invoice|rechnung|quittung|facture|recibo|bestellbestätigung)\b/i;
const SUBJECT_MEDIUM = /\b(order\s*(?:#|no\.?|number)?\s*[A-Z0-9-]*\d|payment|paid|subscription (?:renew(?:al|ed)|confirmation)|you(?:'ve| have) been charged|your bill|thanks for your (?:order|purchase))\b/i;
const SUBJECT_NEGATIVE = /\b(sale|\d+% off|deal|offer|webinar|newsletter|shipped|out for delivery|delivered|track your|review your|rate your|survey)\b/i;
const SENDER_LOCAL = /^(receipts?|invoices?|invoicing|billing|orders?|payments?|purchases?|store|shop|accounts?|noreply|no-reply|donotreply|do-not-reply)[._+-]?[a-z0-9]*@/i;
const SENDER_DOMAIN = /@(?:[a-z0-9-]+\.)*(paypal|stripe|squareup|square|amazon|apple|uber|lyft|doordash|deliveroo|airbnb|booking|github|google|microsoft|steampowered|shopify|paddle|gumroad|itch|digitalocean|hetzner|ovh|netflix|spotify|trainline|ryanair|easyjet)\.[a-z.]+$/i;
const TOTAL_WORD = /\b(total|amount (?:due|paid|charged)|grand total|order total|subtotal|balance due|betrag|gesamt|montant)\b/i;
const ORDER_REF = /\b(?:order|invoice|receipt|transaction|booking|reference|ref)\s*(?:number|no\.?|#|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,39})\b/i;

const CURRENCY_SYMBOL = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };
const CODES = 'USD|EUR|GBP|INR|CAD|AUD|NZD|CHF|JPY|SEK|NOK|DKK|PLN|CZK|SGD|HKD';
const NUM = '(\\d{1,3}(?:[,.\\s]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const MONEY_RE = new RegExp(`(?:\\b(${CODES})\\s?|([$€£₹¥])\\s?)${NUM}|${NUM}\\s?(?:(${CODES})\\b|([€£₹]))`, 'g');

export const CATEGORIES = ['shopping', 'travel', 'food', 'software', 'utilities', 'transport', 'entertainment', 'other'];

/** Parse "1,234.56", "1.234,56", "12,50" or "1 234" into a number. */
export function parseAmount(raw) {
  let s = String(raw).replace(/\s/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // Comma is the decimal separator only when it has 1–2 digits after it.
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else {
    s = /\.\d{1,2}$/.test(s) ? s.replace(/,/g, '') : s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Every money amount in the text: [{ amount, currency, index, line }]. */
export function findAmounts(text) {
  const out = [];
  const src = String(text || '');
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(src))) {
    const code = m[1] || m[5];
    const sym = m[2] || m[6];
    const num = m[3] || m[4];
    const amount = parseAmount(num);
    if (amount === null || amount <= 0 || amount > 10_000_000) continue;
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    out.push({ amount, currency: code ? code.toUpperCase() : CURRENCY_SYMBOL[sym] || null, index: m.index, line: src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd) });
  }
  return out;
}

/** The amount most likely to be the total: on a "total" line if any, else the largest. */
export function pickTotal(text) {
  const all = findAmounts(text);
  if (!all.length) return null;
  const totals = all.filter((a) => TOTAL_WORD.test(a.line) && !/\bsub\s?total\b/i.test(a.line));
  const pool = totals.length ? totals : all;
  return pool.reduce((best, a) => (a.amount > best.amount ? a : best), pool[0]);
}

/**
 * Score how much a message looks like a receipt. `msg` is the facade's message view
 * ({ subject, from_email, from_name, text, folder }).
 */
export function scoreReceipt(msg) {
  const signals = [];
  let score = 0;
  const subject = msg?.subject || '';
  const from = String(msg?.from_email || '').toLowerCase();
  const text = String(msg?.text || msg?.snippet || '').slice(0, 20_000);
  if (/(^|\/)(sent|drafts?)$/i.test(msg?.folder || '')) return { score: 0, signals: ['outgoing'] };
  if (SUBJECT_STRONG.test(subject)) { score += 3; signals.push('subject'); } else if (SUBJECT_MEDIUM.test(subject)) { score += 2; signals.push('subject-weak'); }
  if (SUBJECT_NEGATIVE.test(subject)) { score -= 2; signals.push('promo-or-shipping'); }
  if (SENDER_LOCAL.test(from)) { score += 1; signals.push('sender'); }
  if (SENDER_DOMAIN.test(from)) { score += 1; signals.push('merchant'); }
  if (findAmounts(text).length) { score += 2; signals.push('amount'); }
  if (TOTAL_WORD.test(text)) { score += 1; signals.push('total'); }
  if (ORDER_REF.test(text) || ORDER_REF.test(subject)) { score += 1; signals.push('reference'); }
  return { score, signals };
}

function vendorFrom(msg) {
  const name = String(msg?.from_name || '').replace(/["']/g, '').replace(/\b(receipts?|billing|payments?|orders?|no-?reply|team|support)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (name && name.length <= 60 && !name.includes('@')) return name;
  const domain = String(msg?.from_email || '').split('@')[1] || '';
  const parts = domain.split('.').filter(Boolean);
  const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return core ? core.charAt(0).toUpperCase() + core.slice(1) : null;
}

export function guessCategory(vendor, subject = '') {
  const s = `${vendor || ''} ${subject}`.toLowerCase();
  if (/uber|lyft|bolt|taxi|trainline|rail|ryanair|easyjet|airline|airways|flight|booking|airbnb|hotel/.test(s)) return /uber|lyft|bolt|taxi/.test(s) ? 'transport' : 'travel';
  if (/doordash|deliveroo|just eat|ubereats|restaurant|cafe|coffee|pizza/.test(s)) return 'food';
  if (/github|digitalocean|hetzner|ovh|aws|google cloud|microsoft|apple|jetbrains|openai|anthropic|software|subscription|saas|paddle|gumroad/.test(s)) return 'software';
  if (/electric|energy|water|gas|broadband|internet|mobile|phone|utility/.test(s)) return 'utilities';
  if (/netflix|spotify|steam|cinema|ticket|disney|hbo|youtube/.test(s)) return 'entertainment';
  if (/amazon|shop|store|order/.test(s)) return 'shopping';
  return 'other';
}

/** Rule-based extraction; the model's answer (when allowed) refines it. */
export function heuristicExtract(msg) {
  const total = pickTotal(`${msg?.subject || ''}\n${msg?.text || msg?.snippet || ''}`);
  const ref = ORDER_REF.exec(msg?.text || '') || ORDER_REF.exec(msg?.subject || '');
  const vendor = vendorFrom(msg);
  return {
    vendor,
    amount: total?.amount ?? null,
    currency: total?.currency ?? null,
    date: msg?.date ? new Date(msg.date).toISOString().slice(0, 10) : null,
    order_ref: ref ? ref[1] : null,
    category: guessCategory(vendor, msg?.subject),
  };
}

/** Validate a model answer and merge it over the heuristic fallback. Never trusts the model's types. */
export function normaliseReceipt(raw, fallback) {
  const out = { ...fallback };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.vendor === 'string' && raw.vendor.trim()) out.vendor = raw.vendor.trim().slice(0, 80);
  const amount = typeof raw.amount === 'number' ? raw.amount : (typeof raw.amount === 'string' ? parseAmount(raw.amount.replace(/[^\d.,\s]/g, '')) : null);
  if (Number.isFinite(amount) && amount > 0 && amount < 10_000_000) out.amount = Math.round(amount * 100) / 100;
  if (typeof raw.currency === 'string') {
    const c = raw.currency.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(c)) out.currency = c;
    else if (CURRENCY_SYMBOL[raw.currency.trim()]) out.currency = CURRENCY_SYMBOL[raw.currency.trim()];
  }
  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.date) && !Number.isNaN(Date.parse(raw.date.slice(0, 10)))) out.date = raw.date.slice(0, 10);
  if (typeof raw.order_ref === 'string' && raw.order_ref.trim()) out.order_ref = raw.order_ref.trim().slice(0, 60);
  if (typeof raw.category === 'string' && CATEGORIES.includes(raw.category.trim().toLowerCase())) out.category = raw.category.trim().toLowerCase();
  return out;
}

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    vendor: { type: ['string', 'null'] },
    amount: { type: ['number', 'null'], description: 'the total actually charged, as a number' },
    currency: { type: ['string', 'null'], description: 'ISO 4217 code such as EUR' },
    date: { type: ['string', 'null'], description: 'purchase date as YYYY-MM-DD' },
    order_ref: { type: ['string', 'null'] },
    category: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
  },
  required: ['vendor', 'amount', 'currency', 'date', 'order_ref', 'category'],
};

/** Totals by month and by vendor, per currency (amounts in different currencies are never summed). */
export function summarise(receipts) {
  const months = new Map();
  const vendors = new Map();
  for (const r of receipts) {
    if (!Number.isFinite(r.amount)) continue;
    const cur = r.currency || '???';
    const month = (r.date || '').slice(0, 7) || 'unknown';
    const mk = `${month}|${cur}`;
    const m = months.get(mk) || { month, currency: cur, total: 0, count: 0 };
    m.total = Math.round((m.total + r.amount) * 100) / 100; m.count++;
    months.set(mk, m);
    const vk = `${(r.vendor || 'Unknown').toLowerCase()}|${cur}`;
    const v = vendors.get(vk) || { vendor: r.vendor || 'Unknown', currency: cur, total: 0, count: 0 };
    v.total = Math.round((v.total + r.amount) * 100) / 100; v.count++;
    vendors.set(vk, v);
  }
  return {
    byMonth: [...months.values()].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : a.currency.localeCompare(b.currency))),
    byVendor: [...vendors.values()].sort((a, b) => b.total - a.total),
  };
}

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Spreadsheet formula injection: a cell starting with = + - @ (or tab/CR) is prefixed with '.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(receipts) {
  const header = ['date', 'vendor', 'amount', 'currency', 'category', 'order_ref', 'subject', 'from', 'message_id'];
  const lines = [header.join(',')];
  for (const r of receipts) {
    lines.push([r.date, r.vendor, Number.isFinite(r.amount) ? r.amount.toFixed(2) : '', r.currency, r.category, r.order_ref, r.subject, r.from_email, r.messageId].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Filter a ledger by month ("2026-09") and/or vendor substring. */
export function filterReceipts(receipts, { month, vendor } = {}) {
  return receipts.filter((r) => (!month || (r.date || '').startsWith(month))
    && (!vendor || String(r.vendor || '').toLowerCase().includes(String(vendor).toLowerCase())));
}
