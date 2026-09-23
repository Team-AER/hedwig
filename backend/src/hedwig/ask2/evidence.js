// Evidence for an answer: retrieved chunks grouped by thread, one numbered [n] entry per message,
// within a token budget. Pure functions; ask2/answer.js loads the rows.
import { estimateTokens, messageText } from '../text.js';

const KIND_ORDER = { header: 0, body: 1, attachment: 2, quote: 3, thread: 4 };
const time = (d) => (d ? new Date(d).getTime() : 0);

/**
 * Group chunks by thread, and inside a thread by message.
 * @param {object[]} chunks retrieve() chunks
 * @param {Map<string, object>} rows message rows the user can see, by id (others are dropped)
 * @param {{ latest?: boolean, pinned?: string[] }} [opts] pinned: message ids that must appear
 *   (a follow-up's earlier sources), placed first
 * @returns {{ key: string, score: number, latestAt: number, rollups: string[], messages: { id, row, score, chunks }[] }[]}
 */
export function groupByThread(chunks, rows, { latest = false, pinned = [] } = {}) {
  const threads = new Map();
  const pinnedSet = new Set(pinned);
  const ensure = (row, withMessage = true) => {
    const key = row.thread_key || `msg:${row.id}`;
    if (!threads.has(key)) threads.set(key, { key, score: 0, latestAt: 0, pinned: false, rollups: [], byMessage: new Map() });
    const t = threads.get(key);
    if (!withMessage) return t;
    if (!t.byMessage.has(row.id)) t.byMessage.set(row.id, { id: row.id, row, score: 0, chunks: [] });
    t.latestAt = Math.max(t.latestAt, time(row.date));
    return t;
  };
  for (const c of chunks || []) {
    const row = rows.get(c.messageId);
    if (!row) continue;
    const t = ensure(row, c.kind !== 'thread');
    t.score = Math.max(t.score, Number(c.score) || 0);
    if (c.kind === 'thread') {
      const body = stripContextLine(c.text);
      if (body && !t.rollups.includes(body)) t.rollups.push(body);
      t.rollupRow = t.rollupRow || row;
      continue;
    }
    const m = t.byMessage.get(row.id);
    m.score = Math.max(m.score, Number(c.score) || 0);
    if (!m.chunks.some((x) => x.chunkId === c.chunkId)) m.chunks.push(c);
  }
  // A thread matched only through its outline still needs one citable message: the outline's own.
  for (const t of threads.values()) {
    if (!t.byMessage.size && t.rollupRow) ensure(t.rollupRow);
  }
  for (const id of pinnedSet) {
    const row = rows.get(id);
    if (!row) continue;
    ensure(row).pinned = true;
  }
  const out = [...threads.values()].filter((t) => t.byMessage.size).map((t) => ({
    key: t.key,
    score: t.score,
    latestAt: t.latestAt,
    pinned: t.pinned,
    rollups: t.rollups,
    messages: [...t.byMessage.values()]
      .map((m) => ({ ...m, chunks: m.chunks.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
        || (a.attachmentIndex ?? -1) - (b.attachmentIndex ?? -1) || a.ordinal - b.ordinal) }))
      .sort((a, b) => time(a.row.date) - time(b.row.date)),
  }));
  return out.sort((a, b) => (b.pinned - a.pinned)
    || (latest ? b.latestAt - a.latestAt || b.score - a.score : b.score - a.score || b.latestAt - a.latestAt));
}

/** A chunk's text without its context header line (the message header is printed once instead). */
export function stripContextLine(text) {
  const s = String(text || '');
  const i = s.indexOf('\n');
  return (i >= 0 ? s.slice(i + 1) : s).trim();
}

function attachmentNames(row) {
  let list = row.attachments;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  return (Array.isArray(list) ? list : []).filter((a) => a && a.disposition !== 'inline').map((a) => a.filename).filter(Boolean);
}

function headerLine(n, row) {
  const from = row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email || 'unknown';
  const date = row.date ? new Date(row.date).toISOString().slice(0, 16).replace('T', ' ') : 'unknown date';
  const att = attachmentNames(row);
  return `[${n}] From: ${from} · Date: ${date} · Subject: ${row.subject || '(no subject)'}${row.folder ? ` · Folder: ${row.folder}` : ''}${att.length ? ` · Attachments: ${att.slice(0, 6).join(', ')}` : ''}`;
}

/** The text shown for one message: its retrieved passages, topped up from the body when thin. */
export function messageEvidence(m, { messageChars = 4000 } = {}) {
  const parts = [];
  const seen = new Set();
  for (const c of m.chunks) {
    if (c.kind === 'header' && m.chunks.length > 1) continue;
    let body = stripContextLine(c.text);
    if (!body || seen.has(body)) continue;
    seen.add(body);
    if (c.kind === 'attachment') {
      const name = /attachment: ([^·\n]+)/.exec(String(c.text).split('\n')[0])?.[1]?.trim();
      body = `(from the attachment${name ? ` ${name}` : ''}) ${body}`;
    } else if (c.kind === 'quote') body = `(quoted earlier mail) ${body}`;
    parts.push(body);
  }
  let text = parts.join('\n…\n');
  if (text.length < 400) {
    const full = messageText(m.row, { maxChars: messageChars });
    if (full && !text.includes(full.slice(0, 80))) text = text ? `${text}\n…\n${full}` : full;
  }
  return text.length > messageChars ? `${text.slice(0, messageChars)}…` : (text || '(no text)');
}

/**
 * Number the messages and render the evidence block, stopping at the token budget (at least one
 * message is always included).
 * @returns {{ sources: { n: number, messageId: string, threadKey: string }[], block: string, tokens: number, omitted: number }}
 */
export function buildEvidence(groups, { contextTokens = 24000, messageChars = 4000 } = {}) {
  const sources = [];
  const sections = [];
  let tokens = 0;
  let omitted = 0;
  for (const g of groups) {
    const lines = [];
    const subject = g.messages[0]?.row.subject || '(no subject)';
    const head = `## Thread: ${String(subject).replace(/^((re|fw|fwd|aw|wg|sv|tr)\s*:\s*)+/i, '')} (${g.messages.length} message${g.messages.length === 1 ? '' : 's'} shown)`;
    let cost = estimateTokens(head);
    const rollup = g.rollups[0] ? `Thread outline (not citable): ${g.rollups[0]}` : '';
    if (rollup) cost += estimateTokens(rollup);
    const entries = [];
    for (const m of g.messages) {
      const n = sources.length + entries.length + 1;
      const entry = `${headerLine(n, m.row)}\n${messageEvidence(m, { messageChars })}`;
      const t = estimateTokens(entry);
      if (tokens + cost + t > contextTokens && (sources.length + entries.length) > 0) { omitted++; continue; }
      cost += t;
      entries.push({ n, messageId: m.id, threadKey: g.key, entry });
    }
    if (!entries.length) continue;
    tokens += cost;
    lines.push(head);
    if (rollup) lines.push(rollup);
    for (const e of entries) {
      lines.push(e.entry);
      sources.push({ n: e.n, messageId: e.messageId, threadKey: e.threadKey });
    }
    sections.push(lines.join('\n\n'));
  }
  return { sources, block: sections.join('\n\n'), tokens, omitted };
}
