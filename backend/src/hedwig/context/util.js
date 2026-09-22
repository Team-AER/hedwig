// Small pure helpers shared by the context engine.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** An error whose status the routes pass through (400, 404, …). */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

// Mailboxes that never belong to a person. Mail from them is automated even when the sender
// forgets the bulk headers.
const AUTOMATED_LOCAL = /^(?:.*no-?reply.*|.*do-?not-?reply.*|notifications?|notify|mailer-daemon|postmaster|bounces?(?:[+-].*)?|alerts?|newsletters?|news|receipts?|order-updates?|updates|digest|automated|marketing|invitations?|calendar-notification)$/i;

export function isAutomatedAddress(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at <= 0) return false;
  return AUTOMATED_LOCAL.test(email.slice(0, at));
}

/** The message is a newsletter, notification or other machine mail. */
export function isBulkMessage(row) {
  if (!row) return false;
  if (row.is_bulk === true) return true;
  if (row.category === 'newsletter' || row.category === 'social') return true;
  return isAutomatedAddress(row.from_email);
}

// Second-level labels under a two-letter ccTLD that are not the organisation (example.co.uk).
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc', 'nhs', 'sch', 'gen', 'firm', 'ind', 'or', 'ne', 'go']);

/** Heuristic registrable domain: mail.eu.acme.co.uk → acme.co.uk. No public-suffix list needed. */
export function registrableDomain(domain) {
  const parts = String(domain || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return parts.slice(-take).join('.');
}

export function orgNameFromDomain(domain) {
  const label = registrableDomain(domain).split('.')[0] || '';
  return label.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || null;
}

/** Display name from a header, or null when it is empty or just the address again. */
export function cleanName(name, email) {
  if (!name) return null;
  const n = String(name).replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 200) return null;
  if (n.toLowerCase() === String(email || '').toLowerCase() || /^[^\s@]+@[^\s@]+$/.test(n)) return null;
  return n;
}

export function cleanSubject(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd|aw|sv|wg)\s*(\[\d+\])?\s*:\s*)+/i, '').trim() || null;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'our', 'their', 'them', 'they',
  'will', 'shall', 'can', 'could', 'would', 'should', 'please', 'about', 'into', 'onto', 'over', 'have', 'has', 'had',
  'are', 'was', 'were', 'been', 'being', 'his', 'her', 'its', 'all', 'any', 'some', 'out', 'off', 'get', 'got', 'let',
  'owner', 'mailbox', 'me', 'my', 'to', 'of', 'a', 'an', 'by', 'on', 'in', 'at', 'is', 'be', 'it', 'or', 'as']);

/** Content-word set for fuzzy comparison of short phrases. */
export function wordSet(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  for (let w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

/** { jaccard, overlap } where overlap = |A∩B| / min(|A|,|B|). */
export function phraseSimilarity(a, b) {
  const A = a instanceof Set ? a : wordSet(a);
  const B = b instanceof Set ? b : wordSet(b);
  if (!A.size || !B.size) return { jaccard: 0, overlap: 0 };
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return { jaccard: inter / (A.size + B.size - inter), overlap: inter / Math.min(A.size, B.size) };
}

/** Two phrasings of the same obligation ("send payslips" vs "send the last three payslips"). */
export function nearDuplicate(a, b) {
  const { jaccard, overlap } = phraseSimilarity(a, b);
  return jaccard >= 0.6 || (overlap >= 0.8 && jaccard >= 0.4);
}

function zoneOffsetMs(ts, timeZone) {
  try {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts))) parts[p.type] = p.value;
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) - ts;
  } catch {
    return 0;
  }
}

/** 23:59:59 on a calendar date in a time zone, so "due 30 Sep" is overdue only after the 30th. */
export function endOfDayInZone(ymd, timeZone = 'UTC') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59);
  const check = new Date(guess);
  if (check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3]) return null;
  return new Date(guess - zoneOffsetMs(guess, timeZone));
}

export function isoDay(d = new Date(), timeZone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return new Date(d).toISOString().slice(0, 10);
  }
}

/** First sentence (or first line) of a text, bounded. */
export function gistOf(text, maxChars = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > maxChars ? `${s.slice(0, maxChars - 1).trimEnd()}…` : s;
}
