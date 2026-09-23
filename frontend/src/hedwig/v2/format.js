// Pure formatting and grouping helpers for the v2 views (no DOM, no React), so node tests can
// cover them directly. Dates format with Intl in the UI language.
import i18n from 'i18next';
import { tv } from './i18n.js';

function locale() {
  const l = i18n.language || 'en';
  return l === 'zhCN' ? 'zh-CN' : l === 'ptBR' ? 'pt-BR' : l;
}

function toDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayDiff(a, b) { return Math.round((startOfDay(a) - startOfDay(b)) / 86400000); }

/** List time: 09:40 today, "Yesterday", a weekday within the week, otherwise "26 Sep". */
export function listTime(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const diff = dayDiff(now, d);
  if (diff <= 0) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff === 1) return tv('hedwig.v2.time.yesterday', 'Yesterday');
  if (diff < 7) return d.toLocaleDateString(locale(), { weekday: 'short' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

/** "4 days" style age, for Waiting on and Needs you rows in the Brief. */
export function ageLabel(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const days = dayDiff(now, d);
  if (days <= 0) return listTime(d, now);
  if (days === 1) return tv('hedwig.v2.time.oneDay', '1 day');
  return tv('hedwig.v2.time.days', '{{n}} days', { n: days });
}

/** The deadline slip's big figure: "Fri 26". */
export function slipDate(value) {
  const d = toDate(value);
  if (!d) return '';
  const wd = d.toLocaleDateString(locale(), { weekday: 'short' });
  return `${wd.replace(/\.$/, '')} ${d.getDate()}`;
}

/** The Brief's date line: "Wednesday 23 September · 07:00". */
export function briefDateLine(value, time) {
  const d = toDate(value) || new Date();
  const day = d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const t = time ? toDate(time) : null;
  const hm = t ? t.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }) : null;
  return hm ? `${day} · ${hm}` : day;
}

// A bare YYYY-MM-DD is a calendar day, not an instant: read it as local midnight so every zone
// keeps the day.
function toDay(v) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) {
    const [y, m, d] = String(v).split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return toDate(v);
}

/** "Today", "Tomorrow", "Yesterday", a weekday within the coming week, otherwise "26 Sep". */
export function relDay(value, now = new Date()) {
  const d = toDay(value);
  if (!d) return '';
  const diff = dayDiff(d, now);
  if (diff === 0) return tv('hedwig.v2.time.today', 'Today');
  if (diff === 1) return tv('hedwig.v2.time.tomorrow', 'Tomorrow');
  if (diff === -1) return tv('hedwig.v2.time.yesterday', 'Yesterday');
  if (diff > 1 && diff < 7) return d.toLocaleDateString(locale(), { weekday: 'short' }).replace(/\.$/, '');
  return shortDate(d, now);
}

/** "26 Sep", with the year when it is not this year. */
export function shortDate(value, now = new Date()) {
  const d = toDay(value);
  if (!d) return '';
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return d.toLocaleDateString(locale(), opts);
}

/** "NOK 1,240", "£89.99": an amount in its currency, in the UI language; null without an amount. */
export function money(amount, currency) {
  if (amount == null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const whole = Number.isInteger(n);
  const digits = { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 };
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try { return new Intl.NumberFormat(locale(), { style: 'currency', currency, ...digits }).format(n); } catch { /* unknown code */ }
  }
  const num = new Intl.NumberFormat(locale(), digits).format(n);
  return currency ? `${num} ${currency}` : num;
}

export function fullTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return d.toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function senderName(from) {
  if (!from) return '';
  if (typeof from === 'string') return from;
  return from.name || from.email || '';
}

export function firstName(from) {
  const n = senderName(from);
  if (!n || n.includes('@')) return n;
  const parts = n.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').split(/\s+/);
  return parts[0].length <= 2 && parts[1] ? parts[1] : parts[0];
}

/** Needs you first (newest first), then the rest grouped by day label. */
export function splitStream(items, now = new Date()) {
  const sorted = [...(items || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const needs = sorted.filter((i) => i.needsYou);
  const rest = sorted.filter((i) => !i.needsYou);
  const groups = [];
  for (const it of rest) {
    const d = toDate(it.date);
    const diff = d ? dayDiff(now, d) : 99;
    const key = diff <= 0 ? 'today' : diff === 1 ? 'yesterday' : diff < 7 ? 'week' : 'earlier';
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  return { needs, groups };
}

export function groupLabel(key) {
  if (key === 'today') return tv('hedwig.v2.group.today', 'Today');
  if (key === 'yesterday') return tv('hedwig.v2.group.yesterday', 'Yesterday');
  if (key === 'week') return tv('hedwig.v2.group.week', 'This week');
  return tv('hedwig.v2.group.earlier', 'Earlier');
}

/** Records: one group per bundle (unbundled mail last), each with a one-line summary. */
export function groupBundles(items, bundles = []) {
  const byKey = new Map();
  for (const it of [...(items || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))) {
    const key = it.bundle || '';
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }
  const meta = new Map((bundles || []).map((b) => [b.key, b]));
  const out = [];
  for (const [key, list] of byKey) {
    const b = meta.get(key);
    const senders = [...new Set(list.map((i) => senderName(i.from)).filter(Boolean))];
    out.push({
      key,
      name: key ? (b?.name || key.charAt(0).toUpperCase() + key.slice(1)) : tv('hedwig.v2.records.unbundled', 'Not in a bundle'),
      position: key ? (b?.position ?? 50) : 999,
      items: list,
      unread: list.filter((i) => i.unread).length,
      latest: list[0]?.date || null,
      summary: senders.slice(0, 3).join(', ') + (senders.length > 3 ? ` +${senders.length - 3}` : ''),
    });
  }
  return out.sort((a, b) => a.position - b.position || String(b.latest || '').localeCompare(String(a.latest || '')));
}

/** Split a story with [n] citation markers into text and citation parts. */
export function storyParts(story) {
  if (!story || typeof story !== 'string') return [];
  const parts = [];
  const re = /\s?\[(\d{1,3})\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(story))) {
    if (m.index > last) parts.push({ text: story.slice(last, m.index) });
    parts.push({ cite: Number(m[1]) });
    last = re.lastIndex;
  }
  if (last < story.length) parts.push({ text: story.slice(last) });
  return parts;
}

/** Plain text of an HTML body without ever inserting it into the page. */
export function htmlToPlain(html) {
  if (!html) return '';
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    for (const el of doc.querySelectorAll('script,style,head')) el.remove();
    return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Drop quoted history ("On … wrote:" and "> " lines) from a plain-text body. */
export function newTextOf(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim())) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function percent(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}
