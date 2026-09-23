// Loading a thread for the v2 thread view. Messages and bodies come from upstream's own routes
// (GET /mail/thread/:threadKey, /mail/messages/:id/body); the story so far, the deadline and the
// quick replies from GET /work/thread/:threadId when the work routes are there (otherwise the
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

export function normaliseMessage(m) {
  const to = parseList(m.to_addresses).map((a) => a?.name || a?.email).filter(Boolean);
  return {
    id: m.id,
    from: m.from && typeof m.from === 'object' ? m.from : { name: m.from_name || '', email: m.from_email || '' },
    to: typeof m.to === 'string' ? m.to : to.join(', '),
    date: m.date,
    folder: m.folder,
    text: m.text ?? null,
    snippet: m.snippet || '',
    trackersBlocked: m.trackersBlocked ?? null,
    hasBlockedRemoteImages: Boolean(m.hasBlockedRemoteImages),
    accountId: m.account_id || m.accountId,
    raw: m,
  };
}

/** The body of one message as plain text, new text only (quoted history dropped). */
export async function loadBody(messageId) {
  const b = await api.getMessageBody(messageId);
  const text = b?.text ? String(b.text) : htmlToPlain(b?.html);
  return { text: newTextOf(text) || text.trim(), hasBlockedRemoteImages: Boolean(b?.hasBlockedRemoteImages), trackersBlocked: b?.trackersBlocked ?? null };
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

function extrasOf(ex) {
  return {
    story: normaliseStory(ex.story),
    deadline: normaliseDeadline(ex.deadline),
    quickReplies: Array.isArray(ex.quickReplies) ? ex.quickReplies.filter((q) => typeof q === 'string' && q.trim()) : [],
  };
}

async function workThread(key) {
  const work = useV2.getState().caps.work === true ? true : await useV2.getState().probeWork();
  if (work !== true) return { __error: Object.assign(new Error('off'), { status: 404 }) };
  return v2Api.get(`/work/thread/${encodeURIComponent(key)}`).catch((err) => ({ __error: err }));
}

export async function loadThread(item) {
  if (!item) return null;
  if (item.synthetic || (!item.messageId && String(item.threadId || '').startsWith('reminder:'))) {
    const e = new Error(tv('hedwig.v2.thread.reminder', 'A reminder has no conversation to open.'));
    e.status = 404;
    throw e;
  }
  const key = item.threadId || item.messageId;
  if (isMockMode()) {
    const [t, extras] = await Promise.all([v2Api.get(`/mock/thread/${encodeURIComponent(key)}`), workThread(key)]);
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

  const [body, extras, ctx] = await Promise.all([
    loadBody(latest.id).catch(() => null),
    workThread(key),
    hedwigApi.get(`/context/messages/${encodeURIComponent(latest.id)}`).catch(() => null),
  ]);
  if (body) Object.assign(latest, body);
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
    deadline: ex.deadline || deadlineFrom(ctx),
    quickReplies: ex.quickReplies,
    extrasMissing,
  };
}
