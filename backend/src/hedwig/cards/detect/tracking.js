// Carrier tracking numbers: DHL, UPS, FedEx, USPS, Posten/Bring, PostNord, Royal Mail, DPD, GLS and
// the UPU S10 international format (check digit verified). A bare digit run only counts with the
// carrier named in the mail and a tracking word next to it, so order and phone numbers stay out.
// Status and expected date come from the same mail; later mail with the same number refreshes them.
import { detectText, sentenceAround, parseLooseDate, parseByTime } from '../text.js';

const TRACK_WORD = /track|tracking|sendung|shipment|parcel|package|pakke|forsendelse|sporing|kolli|colis|zending|paket|försändelse|waybill|consignment|awb/i;

const PATTERNS = [
  { carrier: 'UPS', re: /\b1Z ?[0-9A-Z]{3} ?[0-9A-Z]{3} ?[0-9A-Z]{2} ?[0-9A-Z]{4} ?[0-9A-Z]{3} ?[0-9A-Z]\b/g, needs: null },
  { carrier: 'DHL', re: /\b(?:JJD\d{16,18}|JVGL\d{8,20}|GM\d{16,18})\b/g, needs: null },
  { carrier: 'USPS', re: /\b9[2-5]\d{2} ?\d{4} ?\d{4} ?\d{4} ?\d{4} ?\d{2}\b/g, needs: /\busps\b|postal service/i },
  { carrier: 'FedEx', re: /\b(?:\d{12}|\d{15}|\d{20}|\d{22})\b/g, needs: /\bfedex\b/i },
  { carrier: 'DHL', re: /\b\d{10,11}\b/g, needs: /\bdhl\b/i },
  { carrier: 'DPD', re: /\b(?:\d{14}|\d{4} \d{4} \d{4} \d{2})\b/g, needs: /\bdpd\b/i },
  { carrier: 'GLS', re: /\b\d{11,12}\b/g, needs: /\bgls\b/i },
  { carrier: 'PostNord', re: /\b(?:00370\d{13,15}|\d{18,20})\b/g, needs: /postnord/i },
  { carrier: 'Posten/Bring', re: /\b(?:70\d{15,18}|37\d{16}|\d{17,20})\b/g, needs: /\b(posten|bring)\b/i },
  // India (audit 2026-09-24: the production mailbox is Indian; none of these were recognised).
  { carrier: 'Blue Dart', re: /\b\d{11}\b/g, needs: /\bblue ?dart\b/i },
  { carrier: 'Delhivery', re: /\b\d{13,14}\b/g, needs: /\bdelhivery\b/i },
  { carrier: 'DTDC', re: /\b[A-Z]\d{8}\b/g, needs: /\bdtdc\b/i },
  { carrier: 'Aramex', re: /\b\d{11,12}\b/g, needs: /\baramex\b/i },
  { carrier: 'Ekart', re: /\b[A-Z]{2,4}[A-Z0-9]\d{9,10}\b/g, needs: /\bekart\b/i },
  { carrier: 'Shiprocket', re: /\b\d{10,15}\b/g, needs: /\bshiprocket\b/i },
];

const S10_RE = /\b([A-Z]{2})(\d{8})(\d)([A-Z]{2})\b/g;
const S10_COUNTRY = { GB: 'Royal Mail', NO: 'Posten/Bring', SE: 'PostNord', DK: 'PostNord', FI: 'Posti', US: 'USPS', DE: 'DHL', NL: 'PostNL', FR: 'La Poste', CN: 'China Post', IE: 'An Post', IN: 'India Post' };

/** UPU S10 check digit (weights 8 6 4 2 3 5 9 7). Pure. */
export function s10Valid(digits8, check) {
  const w = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = [...digits8].reduce((s, d, i) => s + Number(d) * w[i], 0);
  let c = 11 - (sum % 11);
  if (c === 10) c = 0;
  if (c === 11) c = 5;
  return c === Number(check);
}

/** Tracking numbers in text, with the carrier and position. Pure. */
export function findTrackingNumbers(text, { from = '' } = {}) {
  const s = String(text || '');
  const haystack = `${from}\n${s}`;
  const found = new Map();
  const add = (number, carrier, index) => {
    const key = number.replace(/\s+/g, '').toUpperCase();
    if (!found.has(key)) found.set(key, { number: key, carrier, index });
  };
  for (const m of s.matchAll(S10_RE)) {
    if (!s10Valid(m[2], m[3])) continue;
    if (!TRACK_WORD.test(haystack) && !/post|mail|bring|dhl|usps/i.test(haystack)) continue;
    add(m[0], S10_COUNTRY[m[4]] || `Post (${m[4]})`, m.index);
  }
  for (const p of PATTERNS) {
    if (p.needs && !p.needs.test(haystack)) continue;
    for (const m of s.matchAll(p.re)) {
      const key = m[0].replace(/\s+/g, '').toUpperCase();
      if (found.has(key)) continue;
      if (p.needs) {
        // A bare number: a tracking word within 120 characters, and not a phone, date or amount.
        const around = s.slice(Math.max(0, m.index - 120), m.index + m[0].length + 60);
        if (!TRACK_WORD.test(around)) continue;
        const before = s.slice(Math.max(0, m.index - 12), m.index);
        if (/(tel|phone|call|fax|ring|\+)\W*$/i.test(before) || /[£€$]\s*$/.test(before)) continue;
        if (/[/=+?&#]$/.test(before) || /https?:\/\/\S*$/i.test(s.slice(Math.max(0, m.index - 200), m.index))) continue; // part of a link (a store id), not a waybill
      }
      add(m[0], p.carrier, m.index);
    }
  }
  return [...found.values()];
}

const STATUS_RULES = [
  ['delivered', /\b(has been|was|were|have been|got) delivered\b|\bdelivered to\b|\bsuccessfully delivered\b|^delivered\b|\bzugestellt\b|\ber levert\b|\butlevert\b|\blevererad\b/im],
  ['exception', /delivery (exception|failed|attempt(ed)?)|we (missed you|couldn'?t deliver|could not deliver)|unable to deliver|returned to sender|address problem/i],
  ['out_for_delivery', /out for delivery|with (the|our|your) (driver|courier)|arriving today|on (its|the) way to you today|ute for levering|in zustellung/i],
  ['in_transit', /in transit|on (its|the) way|has left|departed|arrived at (the|our|a) (facility|depot|hub|terminal|sorting)|under transport|unterwegs/i],
  ['shipped', /\b(shipped|dispatched|has been sent|is sent|sendt|versandt|picked up|handed (over )?to)\b/i],
];

/** The latest delivery status the text states. Pure. */
export function deliveryStatusOf(text) {
  for (const [status, re] of STATUS_RULES) {
    const m = re.exec(text);
    if (m) return { status, index: m.index };
  }
  return null;
}

const EXPECTED_RE = /(arriv(?:es|ing|al)|expected( delivery| arrival)?( date)?|estimated delivery( date)?|scheduled( for)? delivery|delivery (date|by|on|expected|window)|will be delivered|should arrive|forventet levert|leveres|voraussichtlich)[^.\n]{0,60}/i;

function hrefWith(html, number) {
  if (!html) return null;
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(re)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(url) && url.replace(/%20|\s/g, '').toUpperCase().includes(number)) return url.slice(0, 500);
  }
  return null;
}

/**
 * Delivery cards from tracking numbers in a message.
 * @param {{ id, subject, from_name, from_email, date, body_text?, body_html?, snippet? }} row
 */
export function detectTracking(row, { tz = 'UTC' } = {}) {
  const text = detectText(row);
  const numbers = findTrackingNumbers(text, { from: `${row.from_name || ''} ${row.from_email || ''}` });
  if (!numbers.length) return [];
  const status = deliveryStatusOf(text);
  const exp = EXPECTED_RE.exec(text);
  const expectedDate = exp ? parseLooseDate(exp[0], row.date || new Date(), tz) : null;
  const expectedBy = exp ? parseByTime(sentenceAround(text, exp.index, 200)) : null;
  const src = (index) => ({ messageId: row.id, quote: sentenceAround(text, index), via: 'pattern' });
  return numbers.slice(0, 5).map((t) => {
    const fields = { carrier: t.carrier, trackingNumber: t.number, status: status?.status || 'shipped' };
    const sources = { carrier: src(t.index), trackingNumber: src(t.index), status: status ? src(status.index) : src(t.index) };
    const url = hrefWith(row.body_html, t.number);
    if (url) { fields.trackingUrl = url; sources.trackingUrl = { messageId: row.id, quote: url, via: 'pattern' }; }
    if (expectedDate) { fields.expectedDate = expectedDate; sources.expectedDate = src(exp.index); }
    if (expectedBy) { fields.expectedBy = expectedBy; sources.expectedBy = src(exp.index); }
    return { kind: 'delivery', messageId: row.id, fields, sources, confidence: 0.9, layer: 'pattern' };
  });
}
