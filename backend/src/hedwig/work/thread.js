// GET /work/thread/:threadId — the story so far ("since you last looked", cited), a timeline line
// per message, quick replies when a short answer fits, each message's TL;DR, and the thread's
// nearest open deadline. The story comes from the summarise family (work.summarise, work/summaries.js):
// normally written eagerly when the mail arrived, computed here only when the cache has nothing for
// the thread's current latest message. Quick replies are computed on open and cached with it. The
// timeline falls back to plain heuristics whenever the model has nothing.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { runPrompt } from '../prompts/index.js';
import { splitBody } from '../indexer/parse.js';
import { summariseThreads, saveStory, tldrFor } from './summaries.js';
import { mapCitations } from '../context/summaries.js';
import { analyseText, senderKind } from '../triage/signals.js';
import {
  httpError, threadKeyOf, loadThreadMessages, ownerOf, attachmentNames, senderLabel, shortDate, clampInt, timeZoneOf,
} from './util.js';
import { voiceWith } from './voice.js';

const DECISION_RE = /\b(agreed|confirmed|confirm(?:ing)? that|approved|go ahead|decided|let'?s go with|sounds good|deal\b|accepted|signed off|booked)\b/i;
const EVENT_KINDS = new Set(['ask', 'decision', 'attachment', 'message']);

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

export function newTextOf(row, maxChars = 1500) {
  const parts = splitBody(row);
  return clip(parts.newText || row.snippet || '', maxChars);
}

/**
 * Index of the first message the owner has not looked at: after the last one they sent or read.
 * -1 when they have seen everything.
 */
export function sinceIndex(messages) {
  let last = -1;
  messages.forEach((m, i) => { if (m.mine || m.is_read) last = i; });
  return last + 1 < messages.length ? last + 1 : -1;
}

/** Variables for one work.summarise thread item from the thread's most recent `max` messages. Pure. */
export function buildStoryVars({ messages, owner, subject, today, max = 20, chars = 1500, cfg = {} }) {
  const window = messages.slice(-max);
  const since = sinceIndex(messages);
  const offset = messages.length - window.length;
  const sinceN = since < 0 ? null : Math.max(1, since - offset + 1);
  return {
    window,
    vars: {
      today, user: owner, subject, count: window.length, sinceN,
      messages: window.map((m, i) => ({
        n: i + 1, from: m.mine ? `${owner?.name || 'The owner'} <${m.from_email}>` : senderLabel(m), mine: Boolean(m.mine),
        date: shortDate(m.date, cfg), attachments: attachmentNames(m), text: newTextOf(m, chars),
      })),
    },
  };
}

/**
 * A work.summarise thread item → { text, citations: [{ n, messageId }] }. Every sentence must cite a message
 * in the window; sentences that cite nothing valid are dropped. Numbers are renumbered in order of
 * first use (context/summaries.js mapCitations). Pure.
 */
export function assembleStory(data, windowIds) {
  const count = windowIds.length;
  const sentences = [];
  for (const s of Array.isArray(data?.sentences) ? data.sentences : []) {
    const text = String(s?.text || '').replace(/\s*\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, '').trim();
    const cites = [...new Set((Array.isArray(s?.cites) ? s.cites : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= count))];
    if (!text || !cites.length) continue;
    const body = text.replace(/[.!?]+$/, '');
    const end = /[!?]$/.test(text) ? text.slice(-1) : '.';
    sentences.push(`${body} ${cites.map((n) => `[${n}]`).join('')}${end}`);
  }
  if (!sentences.length) return null;
  const mapped = mapCitations(sentences.join(' '), windowIds);
  return { text: mapped.text, citations: mapped.sources.map((messageId, i) => ({ n: i + 1, messageId })) };
}

/** A timeline line for one message without the model. Pure. */
export function fallbackEvent(row, chars = 90) {
  const text = newTextOf(row, 2000);
  const facts = analyseText(text, row.date ? new Date(row.date) : new Date());
  let kind = 'message';
  if (facts.question || facts.request) kind = 'ask';
  else if (DECISION_RE.test(text)) kind = 'decision';
  else if (attachmentNames(row).length) kind = 'attachment';
  const first = (text.split(/(?<=[.!?])\s+/)[0] || row.subject || '').trim();
  const line = kind === 'attachment' && !first ? `Sent ${attachmentNames(row).join(', ')}` : first;
  return { kind, line: clip(line || row.subject || '(no text)', chars) };
}

/** Merge the model's timeline with the fallback: one entry per message in the window. Pure. */
export function assembleTimeline(modelEvents, window) {
  const byN = new Map();
  for (const e of Array.isArray(modelEvents) ? modelEvents : []) {
    const n = Number(e?.n);
    if (!Number.isInteger(n) || n < 1 || n > window.length || byN.has(n)) continue;
    if (!EVENT_KINDS.has(e.kind) || !String(e.line || '').trim()) continue;
    byN.set(n, { kind: e.kind, line: clip(e.line, 90) });
  }
  return window.map((m, i) => {
    const ev = byN.get(i + 1) || fallbackEvent(m);
    return { messageId: m.id, at: m.date, who: m.mine ? 'You' : (m.from_name || m.from_email || 'Someone'), kind: ev.kind, line: ev.line };
  });
}

/**
 * Should Hedwig offer quick replies for this thread? Only when the latest message is from a person
 * to the owner, is short, and asks something. Pure: returns { ok, why }.
 */
export function quickReplyGate({ cfg, latest, text }) {
  if (cfg['work.quickReplies'] === false) return { ok: false, why: 'off' };
  if (cfg['ui.helpMeWrite'] === false) return { ok: false, why: 'help_me_write_off' };
  if (!latest) return { ok: false, why: 'empty' };
  if (latest.mine) return { ok: false, why: 'last_word_is_yours' };
  if (latest.is_bulk || latest.list_unsubscribe || senderKind(latest.from_email) !== 'person') return { ok: false, why: 'not_a_person' };
  const max = clampInt(cfg['work.quickReplyMaxChars'], 1500, 100, 10000);
  if (!text || text.length > max) return { ok: false, why: 'too_long' };
  const facts = analyseText(text, latest.date ? new Date(latest.date) : new Date());
  if (!facts.question && !facts.request) return { ok: false, why: 'nothing_asked' };
  return { ok: true, why: null };
}

/** work.quickReplies output → 2–3 one-liners, or [] when a short reply does not fit. Pure. */
export function cleanReplies(data) {
  if (!data?.fits || !Array.isArray(data.replies)) return [];
  const seen = new Set();
  const out = [];
  for (const r of data.replies) {
    const t = String(r || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 120 || /\n/.test(r) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 3) break;
  }
  return out.length >= 2 ? out : [];
}

export async function threadDeadline(userId, threadKey, messageIds, cfg) {
  const { rows } = await query(
    `SELECT id, what, due_at, direction, counterparty, source_message_id FROM hedwig_commitments
      WHERE user_id = $1 AND status = 'open' AND due_at IS NOT NULL
        AND (thread_key = $2 OR source_message_id = ANY($3::uuid[]))
      ORDER BY due_at ASC LIMIT 1`,
    [userId, threadKey, messageIds],
  );
  const c = rows[0];
  if (!c) return null;
  const figure = new Intl.DateTimeFormat('en-GB', { timeZone: timeZoneOf(cfg), weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(c.due_at));
  const who = c.direction === 'i_owe' ? 'You owe this' : `${c.counterparty || 'They'} owe${c.counterparty ? 's' : ''} you this`;
  return { figure, caption: clip(`${c.what} · ${who}`, 140), messageId: c.source_message_id, dueAt: c.due_at, commitmentId: c.id, direction: c.direction };
}

const inflight = new Map();

async function computeQuickReplies(userId, { cfg, owner, messages, subject }) {
  const latest = messages[messages.length - 1];
  const text = newTextOf(latest, clampInt(cfg['work.quickReplyMaxChars'], 1500, 100, 10000) + 1);
  const gate = quickReplyGate({ cfg, latest, text });
  if (!gate.ok) return { replies: [], provenance: null, gate: gate.why };
  const voice = await voiceWith(userId, latest.from_email, { n: 3, addresses: owner.addresses }).catch(() => null);
  const context = messages.slice(-4, -1).map((m) => `${m.mine ? 'Owner' : m.from_name || m.from_email}: ${newTextOf(m, 300)}`).join('\n');
  const { data, provenance } = await runPrompt('work.quickReplies', {
    user: owner, subject, from: senderLabel(latest), text, context,
    voice: voice?.samples?.length ? `write about ${voice.medianWords} words${voice.greeting ? `, open with "${voice.greeting}"` : ''}${voice.signOff ? `, sign off "${voice.signOff}"` : ''}` : null,
  }, { userId, feature: 'work', lane: 'interactive' });
  return { replies: cleanReplies(data), provenance, gate: null };
}

async function compute(userId, threadKey, messages, cfg) {
  const owner = await ownerOf(userId);
  const latest = messages[messages.length - 1];
  const subject = latest.subject || messages[0].subject || '';
  const [res] = await summariseThreads(userId, [{ threadKey, messages }], { cfg, owner, lane: 'interactive', source: 'open' });
  if (!res?.ok) throw new Error(res?.error || 'no story');
  let quick;
  try {
    quick = await computeQuickReplies(userId, { cfg, owner, messages, subject });
  } catch (err) {
    console.warn(`[hedwig] work: quick replies failed for ${threadKey}:`, err.message);
    quick = { replies: null, provenance: null, error: err.message };
  }
  const entry = { ...res.entry, quickReplies: quick.replies, quickReplyGate: quick.gate ?? null };
  const prov = { story: res.provenance, quickReplies: quick.provenance };
  await saveStory(userId, threadKey, messages, entry, prov, { source: 'open', lighter: res.lighter });
  return { entry, provenance: prov, cached: false };
}

/** Is a cached story still good for this thread? Only a different latest message invalidates it. Pure. */
export function cacheValid(cached, messages) {
  if (!cached || !messages.length) return false;
  return cached.up_to_message_id === messages[messages.length - 1].id;
}

/**
 * @returns {{ threadId, upToMessageId, story: { text, citations } | null, storyMeta: { source, tier, model, lighter, … } | null,
 *             tldr: string | null, messageTldrs: { [messageId]: string }, timeline, quickReplies: string[], deadline?,
 *             provenance: { story, quickReplies }, cached: boolean, storyError?: string }}
 */
export async function threadStory(userId, threadId, { refresh = false } = {}) {
  const threadKey = threadKeyOf(threadId);
  const cfg = await getConfig(userId);
  const messages = await loadThreadMessages(userId, threadKey);
  if (!messages.length) throw httpError(404, 'Thread not found');
  const deadline = await threadDeadline(userId, threadKey, messages.map((m) => m.id), cfg).catch(() => null);
  const base = { threadId: threadKey, upToMessageId: messages[messages.length - 1].id, ...(deadline ? { deadline } : {}) };

  const tldrs = await tldrFor(userId, messages.map((m) => m.id)).catch(() => new Map());
  base.messageTldrs = Object.fromEntries([...tldrs].map(([id, t]) => [id, t.text]));

  const { rows: [cached] } = await query('SELECT * FROM hedwig_work_stories WHERE user_id = $1 AND thread_key = $2', [userId, threadKey]);
  let result;
  if (!refresh && cacheValid(cached, messages) && !cached.error) {
    result = { entry: cached.story, provenance: cached.provenance || {}, cached: true };
    if (result.entry.quickReplies == null) {
      // The story was written eagerly (no quick replies yet), or quick replies failed last time: compute them alone.
      try {
        const owner = await ownerOf(userId);
        const q = await computeQuickReplies(userId, { cfg, owner, messages, subject: messages[messages.length - 1].subject || '' });
        result.entry = { ...result.entry, quickReplies: q.replies, quickReplyGate: q.gate ?? null };
        result.provenance = { ...result.provenance, quickReplies: q.provenance };
        await query('UPDATE hedwig_work_stories SET story = $3, provenance = $4, updated_at = NOW() WHERE user_id = $1 AND thread_key = $2',
          [userId, threadKey, JSON.stringify(result.entry), JSON.stringify(result.provenance)]);
      } catch (err) {
        console.warn(`[hedwig] work: quick replies failed for ${threadKey}:`, err.message);
      }
    }
  } else {
    const key = `${userId}|${threadKey}|${messages[messages.length - 1].id}`;
    if (!inflight.has(key)) inflight.set(key, compute(userId, threadKey, messages, cfg).finally(() => inflight.delete(key)));
    try {
      result = await inflight.get(key);
    } catch (err) {
      // Loud but not fatal: the thread still opens, with the heuristic timeline and no story.
      console.warn(`[hedwig] work: story failed for ${threadKey}:`, err.message);
      const window = messages.slice(-clampInt(cfg['work.storyMaxMessages'], 20, 2, 100));
      return { ...base, story: null, storyMeta: null, tldr: null, storyError: err.status === 429 || /budget/i.test(err.message) ? 'budget' : err.message, timeline: assembleTimeline([], window), quickReplies: [], provenance: {}, cached: false };
    }
  }
  const { entry } = result;
  return {
    ...base,
    story: entry.story || null,
    storyMeta: entry.storyMeta || null,
    tldr: entry.tldr || null,
    timeline: entry.timeline || [],
    quickReplies: entry.quickReplies || [],
    provenance: result.provenance,
    cached: result.cached,
  };
}

export function _resetThreadState() { inflight.clear(); }
