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
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
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

/** "Wed 24 Sep, 09:14"; the year too when it is not this year's ("Mon 12 Sep 2025, 09:14"). */
export function fullTime(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const year = d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {};
  return d.toLocaleString(locale(), { weekday: 'short', day: 'numeric', month: 'short', ...year, hour: '2-digit', minute: '2-digit', hour12: false });
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

const TLDR_MAX = 240;
/**
 * The one-line TL;DR Hedwig wrote for a row, or null. The field is `tldr` (a string, or
 * { text }) on stream items and Screener senders; `summary` is read as an alias. Anything that
 * is not plain text, or only repeats the subject, shows nothing rather than noise.
 */
export function tldrOf(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = item.tldr ?? item.summary ?? null;
  const text = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' && typeof raw.text === 'string' ? raw.text : '');
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || clean === 'undefined' || clean === 'null' || /^[[{]/.test(clean)) return null;
  const subject = String(item.subject || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (subject && clean.toLowerCase() === subject) return null;
  return clean.length > TLDR_MAX ? `${clean.slice(0, TLDR_MAX - 1).trimEnd()}…` : clean;
}

/** Whether the row's TL;DR was written by the lighter model (`tldr.lighter`). */
export function tldrLighter(item) {
  const t = item?.tldr;
  return Boolean(t && typeof t === 'object' && t.lighter === true);
}

// ── Quoted history (collapsed in the reader, never deleted) ───────────────────
// The selectors are the backend's (backend/src/hedwig/indexer/parse.js QUOTE_CLASS and
// AFTER_IS_QUOTED_ID), run through DOMParser so nothing is inserted into the page.
const QUOTE_CLASSES = ['gmail_quote', 'gmail_quote_container', 'x_gmail_quote', 'yahoo_quoted', 'protonmail_quote', 'moz-cite-prefix', 'OutlookMessageHeader', 'zmail_extra', 'replyQuote'];
const AFTER_IS_QUOTED_ID = /^(x_)?(divRplyFwdMsg|appendonsend|stopSpelling)/;
const FORWARD_START = /^\s*(-{2,}\s*(Forwarded message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Messaggio inoltrato|Doorgestuurd bericht|Mensagem encaminhada|Vidarebefordrat meddelande)|Begin forwarded message)/i;
const ATTRIBUTION = /(\bwrote|schrieb|a écrit|escribió|skrev|scrisse|napisał|schreef|kirjoitti|escreveu)\s*:?\s*$/i;
const REPLY_SUBJECT = /^\s*(re|sv|aw|antw|ref|rif|odp|vs|r)\s*(\[\d+\])?\s*:/i;

/** Whether a message is a reply: its subject starts with Re: (or a local form) or it has In-Reply-To. */
export function isReplyMessage(subject, inReplyTo) {
  return Boolean(inReplyTo) || REPLY_SUBJECT.test(String(subject || ''));
}

function quoteStartsHere(el, isReply) {
  const cls = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
  if (cls.some((c) => QUOTE_CLASSES.includes(c)) || /^yahoo_quoted/.test(el.id || '')) return true;
  if (el.tagName === 'BLOCKQUOTE') return el.getAttribute('type') === 'cite' || isReply;
  return false;
}

// Nodes after `node` in document order, up to <body>.
function followingNodes(node) {
  const out = [];
  let cur = node;
  while (cur && cur.parentNode && cur.nodeName !== 'BODY') {
    for (let sib = cur.nextSibling; sib; sib = sib.nextSibling) out.push(sib);
    cur = cur.parentNode;
  }
  return out;
}

const textOfNode = (n) => String(n?.textContent || '').replace(/\s+/g, ' ').trim();

/**
 * Split an HTML body into the new part and its quoted history: { main, quoted } where `main`
 * is the HTML to show and `quoted` the HTML that was folded away (null when there is none).
 * Quote containers (Gmail, Yahoo, Proton, Thunderbird, Outlook) and `blockquote type=cite`
 * always count; a bare <blockquote> only when the message is a reply (`isReply`), because
 * newsletters use blockquotes for pull quotes. A forwarded message is never folded.
 */
export function splitQuotedHtml(html, { isReply = false } = {}) {
  const source = String(html || '');
  if (!source.trim() || typeof DOMParser === 'undefined') return { main: source, quoted: null };
  let doc;
  try { doc = new DOMParser().parseFromString(source, 'text/html'); } catch { return { main: source, quoted: null }; }
  const body = doc.body;
  if (!body) return { main: source, quoted: null };
  const removed = [];
  const gone = new Set();
  const within = (n) => { for (let p = n; p; p = p.parentNode) if (gone.has(p)) return true; return false; };
  for (const el of [...body.querySelectorAll('*')]) {
    if (within(el)) continue;
    if (AFTER_IS_QUOTED_ID.test(el.id || '')) {
      const rest = [el, ...followingNodes(el)].filter((n) => !within(n));
      rest.forEach((n) => gone.add(n));
      removed.push(...rest);
      continue;
    }
    if (!quoteStartsHere(el, isReply)) continue;
    if (FORWARD_START.test(el.textContent || '')) continue;
    // "On Mon, Anna wrote:" just before a quote goes with it.
    const prev = el.previousElementSibling;
    if (prev && !within(prev) && !quoteStartsHere(prev, isReply) && ATTRIBUTION.test(textOfNode(prev)) && textOfNode(prev).length < 300) {
      gone.add(prev);
      removed.push(prev);
    }
    gone.add(el);
    removed.push(el);
  }
  if (!removed.length) return { main: source, quoted: null };
  const quoted = removed.map((n) => (n.nodeType === 1 ? n.outerHTML : n.textContent || '')).join('\n');
  for (const n of removed) n.parentNode?.removeChild(n);
  // Nothing new left (a bare forward of a quote): show it all rather than an empty frame.
  if (!textOfNode(body) && !body.querySelector('img')) return { main: source, quoted: null };
  const styles = [...doc.head.querySelectorAll('style')].map((s) => s.outerHTML).join('');
  return { main: styles + body.innerHTML, quoted };
}

/**
 * The plain-text counterpart: { main, quoted } with the history ("On … wrote:", including the
 * two-line Gmail form, "-----Original Message-----", Outlook's From:/Sent: block, a trailing run
 * of "> " lines) and a "-- " signature kept in `quoted` rather than dropped.
 */
export function splitQuotedText(text) {
  const src = String(text || '');
  if (!src.trim()) return { main: src, quoted: null };
  const lines = src.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length && cut < 0; i += 1) {
    const l = lines[i].trim();
    const two = `${l} ${String(lines[i + 1] || '').trim()}`;
    if (/^On .+wrote:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l) || l === '--' || lines[i] === '-- ') cut = i;
    else if (/^On .+/.test(l) && /wrote:\s*$/.test(two) && !/wrote:/.test(l)) cut = i;
    else if (/^(From|Von|De|Fra):\s.+/.test(l) && lines.slice(i + 1, i + 4).some((x) => /^(Sent|Date|Gesendet|Envoyé|Sendt|Datum):\s/.test(x.trim()))) cut = i;
    else if (/^>/.test(l) && lines.slice(i).every((x) => /^>/.test(x.trim()) || !x.trim())) cut = i;
  }
  if (cut <= 0) return { main: src, quoted: null };
  const main = lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!main) return { main: src, quoted: null };
  return { main, quoted: lines.slice(cut).join('\n').replace(/\s+$/, '') };
}

/** "To: Prakhar, Cc: Anna" for a message header (to/cc: strings or [{ name, email }]). */
export function recipientsLine(to, cc) {
  const names = (v) => (Array.isArray(v) ? v.map((a) => (typeof a === 'string' ? a : a?.name || a?.email || a?.address)).filter(Boolean).join(', ') : String(v || ''));
  const t = names(to);
  const c = names(cc);
  return [t && `${tv('hedwig.v2.thread.toLabel', 'To')}: ${t}`, c && `${tv('hedwig.v2.thread.ccLabel', 'Cc')}: ${c}`].filter(Boolean).join(', ');
}

/** The first line of a message for a collapsed row: its snippet, or the start of its text. */
export function snippetOf(m) {
  const s = String(m?.snippet || '').replace(/\s+/g, ' ').trim();
  if (s) return s;
  const t = splitQuotedText(String(m?.text || '')).main;
  return t.replace(/\s+/g, ' ').trim().slice(0, 200);
}
