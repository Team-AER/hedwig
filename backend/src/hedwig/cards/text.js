// Text helpers for the detectors: the sentence around a match, loose dates ("Thursday", "26 Sep").
import { messageText } from '../text.js';
import { zonedParts, validTimezone } from '../insights/time.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Plain text of a message for detection: subject line, then the body with quotes kept (receipts quote little). */
export function detectText(row, { maxChars = 20000 } = {}) {
  const body = messageText(row, { maxChars, stripQuotes: false });
  return `${row.subject || ''}\n${body}`;
}

/** The sentence (or line) containing position `index`, trimmed to `max` characters. Pure. */
export function sentenceAround(text, index, max = 240) {
  const s = String(text || '');
  const boundary = (i) => s[i] === '\n' || s[i] === '!' || s[i] === '?' || (s[i] === '.' && /\s/.test(s[i + 1] || ' '));
  let start = Math.max(0, Math.min(index, s.length));
  while (start > 0 && !boundary(start - 1)) start--;
  let end = Math.max(start, Math.min(index, s.length));
  while (end < s.length && !boundary(end)) end++;
  let out = s.slice(start, Math.min(s.length, end + 1)).replace(/\s+/g, ' ').trim();
  if (out.length > max) {
    const from = Math.max(start, index - Math.floor(max / 2));
    out = s.slice(from, from + max).replace(/\s+/g, ' ').trim();
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * A date written loosely, relative to `ref` in `tz`: today, tomorrow, a weekday (the next one on or
 * after ref), "26 September [2026]", "Sep 26[, 2026]", "26/09/2026", "2026-09-26". Pure.
 * @returns {string|null} YYYY-MM-DD
 */
export function parseLooseDate(text, ref = new Date(), tz = 'UTC') {
  const s = String(text || '').toLowerCase();
  const zone = validTimezone(tz);
  const p = zonedParts(new Date(ref), zone);
  const refDay = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const shift = (n) => { const d = new Date(refDay); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\.? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,? ?(\d{4})?\b/.exec(s);
  const fromParts = (day, mon, year) => {
    const mi = MONTHS.indexOf(mon.slice(0, 3)) + 1;
    if (mi < 1 || day < 1 || day > 31) return null;
    let y = year || p.year;
    // No year: a date more than two months in the past means next year ("5 Jan" written in December).
    if (!year && Date.UTC(y, mi - 1, day) < refDay.getTime() - 60 * 86400_000) y += 1;
    return ymd(y, mi, day);
  };
  if (m) return fromParts(+m[1], m[2], m[3] ? +m[3] : null);
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? ?(\d{4})?\b/.exec(s);
  if (m) return fromParts(+m[2], m[1], m[3] ? +m[3] : null);
  m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(s);
  if (m) { const a = +m[1]; const b = +m[2]; return a > 12 ? ymd(+m[3], b, a) : ymd(+m[3], b, a); }
  if (/\btoday\b|\bi dag\b|\bheute\b/.test(s)) return shift(0);
  if (/\btomorrow\b|\bi morgen\b|\bmorgen\b/.test(s)) return shift(1);
  m = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(s);
  if (m) {
    const want = DAYS.indexOf(m[1]);
    const have = refDay.getUTCDay();
    return shift((want - have + 7) % 7);
  }
  return null;
}

/** "by 16:00", "between 8 and 12" → the latest time mentioned, 'HH:MM'. Pure. */
export function parseByTime(text) {
  const s = String(text || '').toLowerCase();
  let m = /\b(?:by|before|until|innen|før)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/.exec(s);
  if (!m) m = /\bbetween\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s+and\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (h > 23) return null;
  return `${pad(h)}:${m[2] || '00'}`;
}
