// Loading a thread for the v2 thread view. Messages and bodies come from upstream's own routes
// (GET /mail/thread/:threadKey, /mail/messages/:id/body); the story so far (with storyMeta), the
// thread and per-message TL;DRs, the deadline and the quick replies from GET /work/thread/:threadId when the work routes are there (otherwise the
// deadline falls back to the context engine's commitments). Under the mock the messages come
// from the mock's /mock/thread route and the rest from its /work/thread.
import { api } from '../../utils/api.js';
import { hedwigApi } from '../api.js';
import { v2Api, isMockMode } from './client.js';
import { useV2 } from './state.js';
import { htmlToPlain, newTextOf, senderName } from './format.js';
import { tv } from './i18n.js';

function parseList(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

const nameOf = (a) => a?.name || a?.email || a?.address;

export function normaliseMessage(m) {
  const to = parseList(m.to_addresses).map(nameOf).filter(Boolean);
  const cc = parseList(m.cc_addresses).map(nameOf).filter(Boolean);
  return {
    id: m.id,
    from: m.from && typeof m.from === 'object' ? m.from : { name: m.from_name || '', email: m.from_email || '' },
    to: typeof m.to === 'string' ? m.to : to.join(', '),
    cc: typeof m.cc === 'string' ? m.cc : cc.join(', '),
    date: m.date,
    folder: m.folder,
    subject: m.subject || '',
    text: m.text ?? null,
    // The mock can carry an HTML body; upstream rows never do (it comes from the body route).
    html: typeof m.html === 'string' && m.html ? m.html : null,
    snippet: m.snippet || '',
    // Unread only when upstream says so; the mock's messages are read.
    unread: m.is_read === false || m.unread === true,
    starred: Boolean(m.is_starred ?? m.starred),
    hasAttachments: Boolean(m.has_attachments ?? m.hasAttachments),
    inReplyTo: m.in_reply_to || m.inReplyTo || null,
    trackersBlocked: m.trackersBlocked ?? null,
    hasBlockedRemoteImages: Boolean(m.hasBlockedRemoteImages),
    accountId: m.account_id || m.accountId,
    raw: m,
  };
}

/** A body route result as plain text, new text only (quoted history dropped). */
export function textOfBody(b) {
  const text = b?.text ? String(b.text) : htmlToPlain(b?.html);
  return newTextOf(text) || text.trim();
}

/** The body of one message as plain text, new text only (the story and TL;DR paths use this). */
export async function loadBody(messageId) {
  const b = await api.getMessageBody(messageId);
  return { text: textOfBody(b), hasBlockedRemoteImages: Boolean(b?.hasBlockedRemoteImages), trackersBlocked: b?.trackersBlocked ?? null };
}

/**
 * The whole body route result for the reader, untouched: { html, text, attachments,
 * hasBlockedRemoteImages, senderEmail, senderName }. `remote` asks for remote images (only after
 * the user said so). upstream's getMessageBody merges duplicate requests in flight.
 */
export function loadFullBody(messageId, remote = false) {
  return api.getMessageBody(messageId, Boolean(remote));
}

function participantsOf(messages) {
  const names = [];
  for (const m of messages) {
    const n = senderName(m.from);
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

function deadlineFrom(ctx) {
  const list = Array.isArray(ctx?.commitments) ? ctx.commitments : [];
  const open = list.filter((c) => c && c.due_at && (c.status || 'open') === 'open');
  open.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const c = open[0];
  if (!c) return null;
  return { id: c.id, due_at: c.due_at, what: c.what || c.title || '', note: c.direction === 'they_owe' ? 'they' : 'you', source: 'commitment' };
}

/** GET /work/thread's deadline ({ figure, caption, messageId, dueAt, commitmentId, direction }) → the slip's shape. */
export function normaliseDeadline(d) {
  if (!d || typeof d !== 'object') return null;
  const due = d.due_at || d.dueAt;
  if (!due) return null;
  const id = d.id ?? d.commitmentId ?? null;
  return {
    id,
    due_at: due,
    what: d.what || d.caption || d.title || '',
    note: d.note || (d.direction === 'they_owe' ? 'they' : 'you'),
    source: d.source || (id ? 'commitment' : null),
  };
}

/**
 * The story so far: { text, citations: [{ n, messageId }] } from the work route, or a bare string
 * (older shape) whose [n] are message numbers. → { text, cites: { n: messageId } | null }.
 */
export function normaliseStory(story) {
  if (!story) return null;
  if (typeof story === 'string') return { text: story, cites: null };
  if (typeof story.text !== 'string' || !story.text.trim()) return null;
  const cites = {};
  for (const c of Array.isArray(story.citations) ? story.citations : []) if (c && c.n != null && c.messageId) cites[c.n] = c.messageId;
  return { text: story.text, cites };
}

/** Why the work route has no story ('budget' | 'failed'), or null. Never the raw error text. */
export function storyProblem(ex) {
  if (!ex || ex.story || !ex.storyError) return null;
  return ex.storyError === 'budget' ? 'budget' : 'failed';
}

/** { [messageId]: text } from the work route (values may also be { text }). */
export function messageTldrsOf(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    const text = typeof v === 'string' ? v : (v && typeof v.text === 'string' ? v.text : '');
    if (text.trim()) out[id] = text.trim();
  }
  return out;
}

function extrasOf(ex) {
  const prov = ex.provenance && typeof ex.provenance === 'object' ? ex.provenance : {};
  return {
    story: normaliseStory(ex.story),
    // storyMeta ({ source, tier, model, lighter }) is the work route's; provenance.story the older shape.
    storyProvenance: ex.storyMeta && typeof ex.storyMeta === 'object' ? ex.storyMeta : (prov.story && typeof prov.story === 'object' ? prov.story : null),
    tldr: typeof ex.tldr === 'string' && ex.tldr.trim() ? ex.tldr.trim() : (ex.tldr && typeof ex.tldr.text === 'string' ? ex.tldr.text.trim() || null : null),
    messageTldrs: messageTldrsOf(ex.messageTldrs),
    storyProblem: storyProblem(ex),
    deadline: normaliseDeadline(ex.deadline),
    quickReplies: Array.isArray(ex.quickReplies) ? ex.quickReplies.filter((q) => typeof q === 'string' && q.trim()) : [],
  };
}

async function workThread(key, { refresh = false } = {}) {
  const work = useV2.getState().caps.work === true ? true : await useV2.getState().probeWork();
  if (work !== true) return { __error: Object.assign(new Error('off'), { status: 404 }) };
  return v2Api.get(`/work/thread/${encodeURIComponent(key)}${refresh ? '?refresh=1' : ''}`).catch((err) => ({ __error: err }));
}

/** `refresh` asks the work route to write the story again instead of using its cached one. */
export async function loadThread(item, { refresh = false } = {}) {
  if (!item) return null;
  if (item.synthetic || (!item.messageId && String(item.threadId || '').startsWith('reminder:'))) {
    const e = new Error(tv('hedwig.v2.thread.reminder', 'A reminder has no conversation to open.'));
    e.status = 404;
    throw e;
  }
  const key = item.threadId || item.messageId;
  if (isMockMode()) {
    const [t, extras] = await Promise.all([v2Api.get(`/mock/thread/${encodeURIComponent(key)}`), workThread(key, { refresh })]);
    const ex = extras?.__error ? {} : (extras || {});
    return { ...t, messages: (t.messages || []).map(normaliseMessage), ...extrasOf(ex), extrasMissing: Boolean(extras?.__error) };
  }

  const threadRes = item.threadId ? await api.getThread(item.threadId).catch(() => null) : null;
  let rows = Array.isArray(threadRes?.messages) ? threadRes.messages : [];
  if (!rows.length && item.messageId) {
    const one = await api.getMessage(item.messageId).catch(() => null);
    if (one) rows = [one];
  }
  if (!rows.length) {
    const e = new Error(tv('hedwig.v2.thread.gone', 'That conversation is no longer there.'));
    e.status = 404;
    throw e;
  }
  const messages = rows.map(normaliseMessage).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const latest = messages[messages.length - 1];

  // One request for the latest body: the reader renders it, and its text feeds the rest.
  const [body, extras, ctx] = await Promise.all([
    loadFullBody(latest.id).catch(() => null),
    workThread(key, { refresh }),
    hedwigApi.get(`/context/messages/${encodeURIComponent(latest.id)}`).catch(() => null),
  ]);
  if (body) Object.assign(latest, { body, text: textOfBody(body), hasBlockedRemoteImages: Boolean(body.hasBlockedRemoteImages), trackersBlocked: body.trackersBlocked ?? null });
  const extrasMissing = Boolean(extras?.__error);
  const ex = extrasOf(extrasMissing ? {} : (extras || {}));
  const people = participantsOf(messages);
  return {
    subject: latest.raw?.subject || item.subject || '',
    participants: null,
    people,
    label: null,
    messages,
    story: ex.story,
    storyProvenance: ex.storyProvenance,
    storyProblem: ex.storyProblem,
    tldr: ex.tldr,
    messageTldrs: ex.messageTldrs,
    deadline: ex.deadline || deadlineFrom(ctx),
    quickReplies: ex.quickReplies,
    extrasMissing,
  };
}

// ── Regenerate summary ────────────────────────────────────────────────────────
// POST /work/thread/:threadId/story/regenerate and POST /work/message/:id/tldr/regenerate. One
// rewrite in flight per thread (and per message) for the whole page: a second call while the first
// runs gets the same promise, even from a reader that was closed and opened again meanwhile.
const rewriting = new Map();

function rewriteOnce(key, fn) {
  if (!rewriting.has(key)) rewriting.set(key, Promise.resolve().then(fn).finally(() => rewriting.delete(key)));
  return rewriting.get(key);
}

/** Is a rewrite of this story ('story:<threadId>') or TL;DR ('tldr:<messageId>') running? */
export function isRewriting(key) { return rewriting.has(key); }

/** The story written again → { story, storyProvenance, tldr }, shaped as loadThread has them. Rejects when there is none. */
export function regenerateStory(threadId) {
  return rewriteOnce(`story:${threadId}`, async () => {
    const d = await v2Api.post(`/work/thread/${encodeURIComponent(threadId)}/story/regenerate`, {});
    const ex = extrasOf(d && typeof d === 'object' ? d : {});
    if (!ex.story) throw new Error('no story in the answer');
    return { story: ex.story, storyProvenance: ex.storyProvenance, tldr: ex.tldr };
  });
}

/** One message's TL;DR written again → { text, provenance } (provenance: { model, tier, lighter, … } or null). */
export function regenerateTldr(messageId) {
  return rewriteOnce(`tldr:${messageId}`, async () => {
    const d = await v2Api.post(`/work/message/${encodeURIComponent(messageId)}/tldr/regenerate`, {});
    const t = d?.tldr;
    const text = typeof t === 'string' ? t : (t && typeof t.text === 'string' ? t.text : '');
    if (!text.trim()) throw new Error('no TL;DR in the answer');
    return { text: text.trim(), provenance: t && typeof t === 'object' ? t : null };
  });
}
