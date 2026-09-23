// Mail actions for the v2 views, on upstream's own routes: mark read, archive (Done), snooze,
// reply, and the reply composer for Nudge. Nothing here runs on its own; each is a click. Under
// the mock the mail routes are not called and the action just reports success.
import { api } from '../../utils/api.js';
import { useStore } from '../../store/index.js';
import { openReplyFromMessage } from '../../utils/composeFromMessage.js';
import { v2Api, isMockMode, announceSortChange } from './client.js';
import { useV2 } from './state.js';
import { tv } from './i18n.js';

function notify(type, title, body) {
  useStore.getState().addNotification?.({ type, title, ...(body ? { body } : {}) });
}

export async function markRead(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length || isMockMode()) return;
  await api.bulkRead(list, true);
}

/**
 * Done: archive the thread's messages that are in the inbox. Only rows upstream returned for this
 * thread are touched, and only INBOX copies (never Sent or anything already filed).
 */
export async function archiveThread(messages) {
  const ids = (messages || []).filter((m) => m?.id && (m.folder === undefined || m.folder === 'INBOX')).map((m) => m.id);
  if (isMockMode()) { notify('success', tv('hedwig.v2.thread.doneToast', 'Done. Archived.')); announceSortChange({ done: ids }); return; }
  if (!ids.length) return;
  await api.bulkArchive(ids);
  notify('success', tv('hedwig.v2.thread.doneToast', 'Done. Archived.'));
  announceSortChange({ done: ids });
}

export function snoozeTimes(now = new Date()) {
  const later = new Date(now); later.setHours(now.getHours() + 3, 0, 0, 0);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  const nextWeek = new Date(now); nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); nextWeek.setHours(8, 0, 0, 0);
  return [
    { id: 'later', label: tv('hedwig.v2.snooze.later', 'Later today'), until: later },
    { id: 'tomorrow', label: tv('hedwig.v2.snooze.tomorrow', 'Tomorrow morning'), until: tomorrow },
    { id: 'week', label: tv('hedwig.v2.snooze.week', 'Next week'), until: nextWeek },
  ];
}

/**
 * Snooze through POST /work/snooze when the work routes are there (it snoozes upstream and keeps
 * the thread out of People until then), otherwise upstream's own snooze route.
 */
export async function snooze(messageId, until, threadId) {
  if (useV2.getState().caps.work === true) {
    await v2Api.post('/work/snooze', { ...(messageId ? { messageId } : { threadId }), until: until.toISOString() });
  } else if (!isMockMode()) {
    await api.snoozeMessage(messageId, until.toISOString());
  }
  notify('success', tv('hedwig.v2.snooze.done', 'Snoozed until {{when}}.', { when: until.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }));
  announceSortChange({ snoozed: messageId });
}

// The work routes' list kinds (they also accept the camelCase names).
export const LIST_KIND = { replyLater: 'reply_later', setAside: 'set_aside', snoozed: 'snoozed' };
const kindOf = (list) => LIST_KIND[list] || list;

/** Reply Later / Set Aside: POST /work/lists/:kind { threadId }. */
export async function addToList(list, threadId, extra = {}) {
  if (!threadId) return;
  const res = await v2Api.post(`/work/lists/${encodeURIComponent(kindOf(list))}`, { threadId, ...extra });
  if (res?.counts) useV2.getState().applyListCounts(res.counts);
  notify('success', list === 'replyLater'
    ? tv('hedwig.v2.list.addedReplyLater', 'Added to Reply Later.')
    : tv('hedwig.v2.list.addedSetAside', 'Set aside.'));
  announceSortChange({ list, threadId });
}

/** DELETE /work/lists/:kind/:threadId (not for Snoozed: a snooze ends by itself). */
export async function removeFromList(list, threadId) {
  if (!threadId || list === 'snoozed') return;
  const res = await v2Api.del(`/work/lists/${encodeURIComponent(kindOf(list))}/${encodeURIComponent(threadId)}`);
  if (res?.counts) useV2.getState().applyListCounts(res.counts);
  announceSortChange({ list, threadId });
}

async function fullMessage(messageId) {
  const msg = await api.getMessage(messageId);
  if (!msg?.id) throw new Error(tv('hedwig.v2.mail.notFound', 'That message is no longer there.'));
  return msg;
}

/** Build the reply upstream's composer would build (addresses, alias, quote, threading headers). */
export async function replyDraft(message) {
  let draft = null;
  const st = useStore.getState();
  await openReplyFromMessage(message, { accounts: st.accounts || [], openCompose: (d) => { draft = d; }, getMessageBody: api.getMessageBody });
  return draft ? addressOwnMessage(draft, message, st.accounts || []) : null;
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

// Replying to your own message (a Nudge on something you sent) goes to its recipients, not to you.
export function addressOwnMessage(draft, message, accounts) {
  const acct = accounts.find((a) => a.id === message.account_id);
  const mine = new Set([acct?.email_address, ...(acct?.aliases || []).map((a) => a.email)].filter(Boolean).map((e) => e.toLowerCase()));
  const target = draft.to?.[0]?.email?.toLowerCase();
  if (!target || !mine.has(target)) return draft;
  const to = parseList(message.to_addresses).filter((a) => a?.email && !mine.has(a.email.toLowerCase()));
  return to.length ? { ...draft, to, originalFrom: to } : draft;
}

// Bare addresses: /mail/send takes strings, and a display name with commas or quotes in it is
// not worth the risk of a mangled header on a one-line reply.
const recipients = (list) => (list || []).map((a) => (typeof a === 'string' ? a : a?.email)).filter(Boolean);

/**
 * Everything a short reply from the thread's reply bar needs, built the way upstream's composer
 * builds a reply (addresses, alias, quote, threading headers). The server adds the account
 * signature when the client sends none.
 */
export async function prepareReply(messageId, text) {
  const body = String(text || '').trim();
  if (!body) return null;
  if (isMockMode()) return { mock: true, to: ['anna.berg@northwind.example'], cc: [], subject: 'Re:', body };
  const message = await fullMessage(messageId);
  const d = await replyDraft(message);
  if (!d?.to?.length || !d.accountId) throw new Error(tv('hedwig.v2.reply.noRecipient', 'Hedwig could not work out who to reply to. Open the composer instead.'));
  return {
    accountId: d.accountId,
    ...(d.aliasId ? { aliasId: d.aliasId } : {}),
    to: recipients(d.to),
    cc: recipients(d.cc),
    bcc: [],
    subject: d.subject,
    body,
    bodyIsHtml: false,
    ...(d.quotedBody ? { quotedBody: d.quotedBody } : {}),
    inReplyTo: d.inReplyTo,
    references: d.references || undefined,
  };
}

/**
 * The send guard (POST /work/sendguard): warnings about a reply before it goes (a missing
 * attachment, a stranger on the thread, a large reply-all). Never blocks: an error or a missing
 * route is simply no warnings.
 */
export async function guardReply(payload, threadId) {
  if (!payload || useV2.getState().caps.work !== true) return [];
  try {
    const res = await v2Api.post('/work/sendguard', {
      ...(threadId ? { threadId } : {}), to: payload.to, cc: payload.cc, subject: payload.subject, body: payload.body,
      attachments: [], ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}), ...(payload.accountId ? { accountId: payload.accountId } : {}),
    });
    return (Array.isArray(res?.warnings) ? res.warnings : []).filter((w) => w && (w.text || w.message));
  } catch {
    return [];
  }
}

/** Send a prepared reply through upstream's send route; one idempotency key per press. */
export async function sendPrepared(payload) {
  if (!payload) return null;
  if (payload.mock) { notify('success', tv('hedwig.v2.reply.sent', 'Sent.')); return { ok: true }; }
  const key = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await api.post('/mail/send', payload, { 'X-Idempotency-Key': key });
  notify('success', tv('hedwig.v2.reply.sent', 'Sent.'));
  return result;
}

/** Prepare and send in one go (no send guard). */
export async function sendReply(messageId, text) {
  return sendPrepared(await prepareReply(messageId, text));
}

/** Open upstream's composer with a reply to this message, the body pre-filled. */
export async function openReplyComposer(messageId, text = '') {
  if (isMockMode()) { useStore.getState().openCompose?.({ body: text, subject: 'Re:' }); return; }
  const message = await fullMessage(messageId);
  const st = useStore.getState();
  await openReplyFromMessage(message, {
    accounts: st.accounts || [],
    openCompose: (d) => st.openCompose({ ...addressOwnMessage(d, message, st.accounts || []), body: text }),
    getMessageBody: api.getMessageBody,
  });
}

/** Nudge: a reply to the last message you sent, with a gentle opener. */
export function nudge(messageId, who) {
  return openReplyComposer(messageId, tv('hedwig.v2.brief.nudgeText', 'Hi {{who}}, just checking in on this.', { who: who || '' }).replace(/\s+,/, ','));
}
