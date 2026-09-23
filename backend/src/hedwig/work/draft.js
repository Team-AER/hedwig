// POST /work/draft — a reply in the owner's voice (reasoning tier, work.draft), or a rewrite of their
// own text (shorter, friendlier, firmer, fix, translate:<lang>) returned as { before, after }.
// Built from the thread (messageParts for the message being answered), the owner's past replies to
// the same person, and hedwig_profile lines once that exists. Never sends: the frontend inserts the
// text into upstream's composer.
import { getConfig } from '../config.js';
import { runPrompt } from '../prompts/index.js';
import { messageParts } from '../indexer/retrieve.js';
import { addressesOf } from '../text.js';
import { toneInstruction } from '../prompts/work.draft.js';
import {
  httpError, threadKeyOf, loadThreadMessages, ownerOf, todayLine, attachmentNames, senderLabel, shortDate, clampInt,
} from './util.js';
import { newTextOf } from './thread.js';
import { voiceWith, profileLines } from './voice.js';

const TONES = new Set(['shorter', 'friendlier', 'firmer', 'fix']);
const TRANSLATE_RE = /^translate:([\p{L} ()-]{2,40})$/u;
const THREAD_MESSAGES = 8;

export function validTone(tone) {
  if (tone === undefined || tone === null || tone === '') return null;
  if (typeof tone === 'string' && (TONES.has(tone) || TRANSLATE_RE.test(tone))) return tone;
  throw httpError(400, "tone must be shorter, friendlier, firmer, fix or translate:<language>");
}

/** Who the owner is writing to in this thread: the latest sender who is not them, else their last recipient. Pure. */
export function counterpartOf(messages, ownerAddresses = []) {
  const mine = new Set(ownerAddresses.map((a) => a.toLowerCase()));
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.mine && m.from_email) return { email: m.from_email.toLowerCase(), name: m.from_name || null, messageId: m.id, row: m };
  }
  const last = messages[messages.length - 1];
  const to = last ? addressesOf(last.to_addresses).find((a) => !mine.has(a.email)) : null;
  return to ? { email: to.email, name: to.name, messageId: last.id, row: last } : null;
}

/**
 * Variables for work.draft. Pure: every input is passed in.
 * @param {{ mode: 'reply'|'rewrite', messages: object[], owner, voice, profile: string[], intent?, tone?, text?,
 *           today: string, cfg: object, parts?: object, answering?: object }} a
 */
export function buildDraftVars({ mode, messages = [], owner, voice, profile = [], intent = null, tone = null, text = null, today, cfg = {}, parts = null, answering = null }) {
  const chars = clampInt(cfg['work.storyMessageChars'], 1500, 200, 10000);
  const window = messages.slice(-THREAD_MESSAGES);
  const thread = window.map((m) => {
    const isAnswered = answering && m.id === answering.id && parts;
    const body = isAnswered ? String(parts.newText || '').slice(0, chars * 2) : newTextOf(m, chars);
    const files = [...new Set([...attachmentNames(m), ...(isAnswered ? (parts.attachments || []).map((a) => a.filename).filter(Boolean) : [])])];
    return { from: m.mine ? `${owner?.name || 'The owner'}` : senderLabel(m), mine: Boolean(m.mine), date: shortDate(m.date, cfg), text: body || '(no text)', attachments: files };
  });
  return {
    mode,
    today,
    user: owner,
    profile,
    voice,
    subject: (answering || window[window.length - 1])?.subject || '',
    thread,
    replyTo: answering ? senderLabel(answering) : null,
    intent: intent ? String(intent).slice(0, 1000) : null,
    text: text ? String(text).slice(0, 20000) : null,
    toneText: toneInstruction(tone),
  };
}

/** Collapse the model's draft: trim, drop a stray "Subject:" line. Pure. */
export function cleanDraft(s) {
  return String(s || '').replace(/^\s*subject:[^\n]*\n+/i, '').replace(/\n{3,}/g, '\n\n').trim();
}

export async function draft(userId, body = {}) {
  const tone = validTone(body.tone);
  const text = typeof body.text === 'string' && body.text.trim() ? body.text : null;
  const intent = typeof body.intent === 'string' && body.intent.trim() ? body.intent.trim() : null;
  const mode = tone && text ? 'rewrite' : 'reply';
  if (mode === 'reply' && !body.threadId) throw httpError(400, 'threadId is required (or text with a tone to rewrite)');

  const cfg = await getConfig(userId);
  if (cfg['ui.helpMeWrite'] === false) throw httpError(403, 'Help me write is off in your settings');
  const owner = await ownerOf(userId);
  let messages = [];
  if (body.threadId) {
    messages = await loadThreadMessages(userId, threadKeyOf(body.threadId), { addresses: owner.addresses });
    if (!messages.length) throw httpError(404, 'Thread not found');
  }
  const counterpart = counterpartOf(messages, owner.addresses);
  const answering = counterpart?.row && !counterpart.row.mine ? counterpart.row : null;
  const [voice, profile, parts] = await Promise.all([
    counterpart ? voiceWith(userId, counterpart.email, { n: clampInt(cfg['work.voiceSamples'], 5, 0, 20), addresses: owner.addresses }) : Promise.resolve(null),
    profileLines(userId),
    answering ? messageParts(answering.id, { userId }).catch(() => null) : Promise.resolve(null),
  ]);
  const vars = buildDraftVars({ mode, messages, owner, voice, profile, intent, tone, text, today: todayLine(cfg), cfg, parts, answering });
  const { data, provenance } = await runPrompt('work.draft', vars, { userId, feature: 'work', lane: 'interactive' });
  const out = cleanDraft(data?.draft);
  if (!out) throw httpError(502, 'The model returned an empty draft');
  if (mode === 'rewrite') return { mode, draft: out, before: text, after: out, tone, provenance };
  const subject = answering?.subject || messages[messages.length - 1]?.subject || '';
  return {
    mode,
    draft: out,
    provenance,
    reply: answering ? {
      inReplyToMessageId: answering.id,
      to: [{ name: answering.from_name || null, email: answering.from_email }],
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    } : null,
  };
}
