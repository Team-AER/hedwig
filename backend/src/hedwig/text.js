// Plain-text views of a message for models and embeddings. Never used for rendering.
import { convert } from './htmlToText.js';

const QUOTE_MARKERS = [
  /^On .{5,200} wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From: .+\nSent: .+/m,
  /^_{10,}/m,
  /^Am .{5,200} schrieb .{1,200}:\s*$/m,
  /^Le .{5,200} a écrit\s*:\s*$/m,
];

/** Strip quoted history and signatures so a message contributes only what it adds. */
export function stripQuoted(text) {
  if (!text) return '';
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index > 40 && m.index < cut) cut = m.index;
  }
  let body = text.slice(0, cut);
  body = body.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const sig = body.search(/^--\s*$/m);
  if (sig > 40) body = body.slice(0, sig);
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/** Best available text for a message row. */
export function messageText(row, { maxChars = 6000, stripQuotes = true } = {}) {
  let text = row.body_text || '';
  if (!text && row.body_html) text = convert(row.body_html);
  if (!text) text = row.snippet || '';
  if (stripQuotes) text = stripQuoted(text) || text;
  text = text.replace(/[ \t]+/g, ' ').replace(/ /g, ' ').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** A compact header block models can cite. */
export function messageHeader(row) {
  const from = row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email || 'unknown';
  const to = (Array.isArray(row.to_addresses) ? row.to_addresses : [])
    .map((a) => (typeof a === 'string' ? a : a?.address || a?.email)).filter(Boolean).slice(0, 6).join(', ');
  const date = row.date ? new Date(row.date).toISOString().slice(0, 16).replace('T', ' ') : '';
  return `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${row.subject || '(no subject)'}`;
}

export function addressesOf(list) {
  if (!list) return [];
  const arr = typeof list === 'string' ? safeJson(list, []) : list;
  return (Array.isArray(arr) ? arr : [])
    .map((a) => (typeof a === 'string' ? { email: a, name: null } : { email: a?.address || a?.email, name: a?.name || null }))
    .filter((a) => a.email && /@/.test(a.email))
    .map((a) => ({ email: a.email.trim().toLowerCase(), name: a.name ? String(a.name).trim() : null }));
}

export function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
