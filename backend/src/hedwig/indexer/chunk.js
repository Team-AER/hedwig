// Chunking: ~350-token pieces with 50 tokens of overlap, cut at paragraph boundaries (then
// sentences, then words), each starting with one context header line so a chunk read on its own
// still says what it is from. Pure functions; the database side is in store.js.
import { estimateTokens } from '../text.js';

const WORDS = /\S+/g;

function splitLong(paragraph, maxTokens) {
  const sentences = paragraph.split(/(?<=[.!?…])\s+(?=\S)/u);
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const s of sentences) {
    if (estimateTokens(s) > maxTokens) {
      push();
      // A single sentence longer than a chunk (tables, URLs, no punctuation): cut by words.
      const words = s.match(WORDS) || [];
      let piece = '';
      for (const w of words) {
        if (piece && estimateTokens(`${piece} ${w}`) > maxTokens) { out.push(piece); piece = ''; }
        piece = piece ? `${piece} ${w}` : w;
      }
      if (piece) out.push(piece);
      continue;
    }
    if (cur && estimateTokens(`${cur} ${s}`) > maxTokens) push();
    cur = cur ? `${cur} ${s}` : s;
  }
  push();
  return out;
}

/** The last `tokens` worth of words of a text, for overlap. */
export function tailWords(text, tokens) {
  if (!tokens) return '';
  const words = String(text).match(WORDS) || [];
  const out = [];
  let chars = 0;
  for (let i = words.length - 1; i >= 0; i--) {
    if (chars + words[i].length + 1 > tokens * 4) break;
    out.unshift(words[i]);
    chars += words[i].length + 1;
  }
  return out.join(' ');
}

/**
 * Split text into chunks of about `maxTokens`, packing whole paragraphs, with `overlap` tokens
 * carried from the end of one chunk to the start of the next.
 * @returns {string[]}
 */
export function chunkText(text, { maxTokens = 350, overlap = 50, maxChunks = Infinity } = {}) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const ov = Math.max(0, Math.min(overlap, Math.floor(maxTokens / 2)));
  const units = [];
  for (const p of clean.split(/\n\s*\n/)) {
    const para = p.trim();
    if (!para) continue;
    if (estimateTokens(para) <= maxTokens) units.push(para);
    else units.push(...splitLong(para, maxTokens));
  }
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  let fresh = false; // cur holds something beyond the carried overlap
  const flush = () => {
    if (!fresh) return;
    const body = cur.join('\n\n');
    chunks.push(body);
    const carry = tailWords(body, ov);
    cur = carry ? [carry] : [];
    curTokens = estimateTokens(carry);
    fresh = false;
  };
  for (const u of units) {
    const t = estimateTokens(u);
    if (fresh && curTokens + t > maxTokens) flush();
    if (chunks.length >= maxChunks) break;
    cur.push(u);
    curTokens += t;
    fresh = true;
  }
  if (chunks.length < maxChunks) flush();
  return chunks.slice(0, maxChunks);
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function sender(row) {
  const email = row.from_email || '';
  return row.from_name ? `${oneLine(row.from_name)} <${email}>` : email || 'unknown sender';
}

function recipients(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr.map((a) => (typeof a === 'string' ? a : a?.name ? `${a.name} <${a.address || a.email}>` : a?.address || a?.email))
    .filter(Boolean).slice(0, 8).join(', ');
}

/**
 * The context header line every chunk starts with: subject, sender, date, folder and, for
 * attachment chunks, the file name.
 */
export function contextHeader(row, { kind = 'body', attachmentName = null } = {}) {
  const bits = [oneLine(row.subject) || '(no subject)', sender(row), isoDay(row.date), row.folder || ''];
  if (attachmentName) bits.push(`attachment: ${oneLine(attachmentName)}`);
  if (kind === 'quote') bits.push('quoted history');
  return bits.filter(Boolean).join(' · ');
}

function attachmentList(row) {
  const list = typeof row.attachments === 'string' ? safeJson(row.attachments) : row.attachments;
  return (Array.isArray(list) ? list : []).filter((a) => a && a.disposition !== 'inline').map((a) => a.filename).filter(Boolean);
}

function safeJson(s) { try { return JSON.parse(s); } catch { return []; } }

/**
 * Build a message's chunks.
 * @param {object} row       message row (MESSAGE_COLUMNS)
 * @param {{ newText: string, quoted: string, signature: string }} parts
 * @param {{ index: number, filename: string, text: string }[]} attachments extracted attachment text
 * @returns {{ kind: string, ordinal: number, attachmentIndex: number|null, text: string, tsSubject: string, tsBody: string, tokens: number }[]}
 */
export function buildMessageChunks(row, parts, attachments = [], { maxTokens = 350, overlap = 50, maxChunks = 80 } = {}) {
  const out = [];
  const subject = oneLine(row.subject);
  const add = (kind, ordinal, content, { attachmentIndex = null, attachmentName = null } = {}) => {
    const header = contextHeader(row, { kind, attachmentName });
    const text = `${header}\n${content}`;
    // The subject is weighted on its own (A); the rest of the header line counts with the body.
    const headerRest = header.startsWith(subject) && subject ? header.slice(subject.length) : header;
    out.push({ kind, ordinal, attachmentIndex, text, tsSubject: subject, tsBody: `${headerRest}\n${content}`, tokens: estimateTokens(text) });
  };

  // Header chunk: who, when, to whom, attachment names, signature. Carries the snippet when the
  // body has not arrived yet.
  const hasBody = row.body_text != null || row.body_html != null;
  const head = [
    `From: ${sender(row)}`,
    recipients(row.to_addresses) && `To: ${recipients(row.to_addresses)}`,
    recipients(row.cc_addresses) && `Cc: ${recipients(row.cc_addresses)}`,
    row.date && `Date: ${new Date(row.date).toISOString().slice(0, 16).replace('T', ' ')}`,
    `Subject: ${subject || '(no subject)'}`,
    attachmentList(row).length && `Attachments: ${attachmentList(row).join(', ')}`,
    !hasBody && row.snippet && `Snippet: ${oneLine(row.snippet)}`,
    parts.signature && `Signature: ${oneLine(parts.signature).slice(0, 400)}`,
  ].filter(Boolean).join('\n');
  add('header', 0, head);

  let budget = Math.max(1, maxChunks - 1);
  const opts = { maxTokens, overlap };
  const body = chunkText(parts.newText, { ...opts, maxChunks: budget });
  body.forEach((c, i) => add('body', i, c));
  budget -= body.length;

  for (const att of attachments) {
    if (budget <= 0) break;
    const pieces = chunkText(att.text, { ...opts, maxChunks: budget });
    pieces.forEach((c, i) => add('attachment', i, c, { attachmentIndex: att.index, attachmentName: att.filename }));
    budget -= pieces.length;
  }

  if (budget > 0 && parts.quoted) {
    const q = chunkText(parts.quoted, { ...opts, maxChunks: Math.min(budget, 6) });
    q.forEach((c, i) => add('quote', i, c));
  }
  return out;
}

/**
 * One rollup chunk for a thread: who took part, when, and the gist of each message in order.
 * @param {{ row: object, newText: string }[]} messages oldest first, at least two
 */
export function buildThreadRollup(messages, { maxTokens = 350 } = {}) {
  if (!messages || messages.length < 2) return null;
  const first = messages[0].row;
  const last = messages[messages.length - 1].row;
  const people = [...new Set(messages.map((m) => oneLine(m.row.from_name) || m.row.from_email).filter(Boolean))].slice(0, 8);
  const subject = oneLine(first.subject).replace(/^((re|fw|fwd|aw|wg|sv|tr)\s*:\s*)+/i, '') || '(no subject)';
  const header = `${subject} · thread of ${messages.length} messages · ${people.join(', ')} · ${isoDay(first.date)} to ${isoDay(last.date)}`;
  const budgetChars = Math.max(600, Math.round(maxTokens * 1.4 * 4)) - header.length;
  const per = Math.max(120, Math.floor(budgetChars / messages.length));
  let lines = messages.map((m) => `${isoDay(m.row.date)} ${oneLine(m.row.from_name) || m.row.from_email || '?'}: ${oneLine(m.newText || m.row.snippet).slice(0, per)}`);
  // Long threads: keep the opening message and the most recent ones.
  while (lines.join('\n').length > budgetChars && lines.length > 2) lines = [lines[0], ...lines.slice(2)];
  const content = lines.join('\n');
  const text = `${header}\n${content}`;
  return { kind: 'thread', ordinal: 0, attachmentIndex: null, text, tsSubject: subject, tsBody: text.slice(subject.length), tokens: estimateTokens(text) };
}
