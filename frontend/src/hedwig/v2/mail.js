// Mail actions for the v2 views, on upstream's own routes: mark read, archive (Done), snooze,
// reply, and the reply composer for Nudge. Nothing here runs on its own; each is a click. Under
// the mock the mail routes are not called and the action just reports success.
import { api } from '../../utils/api.js';
import { useStore } from '../../store/index.js';
import { openReplyFromMessage, openForwardFromMessage } from '../../utils/composeFromMessage.js';
import { v2Api, isMockMode, announceSortChange } from './client.js';
import { useV2 } from './state.js';
import { tv, tvn } from './i18n.js';

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
export async function archiveThread(messages, { quiet = false } = {}) {
  const ids = (messages || []).filter((m) => m?.id && (m.folder === undefined || m.folder === 'INBOX')).map((m) => m.id);
  if (isMockMode()) { if (!quiet) notify('success', tv('hedwig.v2.thread.doneToast', 'Done. Archived.')); announceSortChange({ done: ids }); return; }
  if (!ids.length) return;
  await api.bulkArchive(ids);
  if (!quiet) notify('success', tv('hedwig.v2.thread.doneToast', 'Done. Archived.'));
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
export async function snooze(messageId, until, threadId, { quiet = false } = {}) {
  if (useV2.getState().caps.work === true) {
    await v2Api.post('/work/snooze', { ...(messageId ? { messageId } : { threadId }), until: until.toISOString() });
  } else if (!isMockMode()) {
    await api.snoozeMessage(messageId, until.toISOString());
  }
  if (!quiet) notify('success', tv('hedwig.v2.snooze.done', 'Snoozed until {{when}}.', { when: until.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }));
  announceSortChange({ snoozed: messageId });
}

// The work routes' list kinds (they also accept the camelCase names).
export const LIST_KIND = { replyLater: 'reply_later', setAside: 'set_aside', snoozed: 'snoozed' };
const kindOf = (list) => LIST_KIND[list] || list;

/** Reply Later / Set Aside: POST /work/lists/:kind { threadId }. */
export async function addToList(list, threadId, extra = {}, { quiet = false } = {}) {
  if (!threadId) return;
  const res = await v2Api.post(`/work/lists/${encodeURIComponent(kindOf(list))}`, { threadId, ...extra });
  if (res?.counts) useV2.getState().applyListCounts(res.counts);
  if (!quiet) notify('success', list === 'replyLater'
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

/**
 * Open upstream's composer with a reply to this message, the body pre-filled. `hints` (a nudge's
 * { to, subject }) replace the addresses and subject upstream would pick when they are given.
 */
export async function openReplyComposer(messageId, text = '', hints = {}) {
  const to = (hints.to || []).filter((a) => a?.email);
  const apply = (d) => ({ ...d, ...(to.length ? { to, originalFrom: to } : {}), ...(hints.subject ? { subject: hints.subject } : {}), body: text });
  if (isMockMode()) { useStore.getState().openCompose?.(apply({ subject: 'Re:' })); return; }
  const message = await fullMessage(messageId);
  const st = useStore.getState();
  await openReplyFromMessage(message, {
    accounts: st.accounts || [],
    openCompose: (d) => st.openCompose(apply(addressOwnMessage(d, message, st.accounts || []))),
    getMessageBody: api.getMessageBody,
  });
}

/** Nudge without a draft: a reply to the last message you sent, with a gentle opener. */
export function nudge(messageId, who) {
  return openReplyComposer(messageId, tv('hedwig.v2.brief.nudgeText', 'Hi {{who}}, just checking in on this.', { who: who || '' }).replace(/\s+,/, ','));
}

/**
 * Nudge a thread you are waiting on: POST /work/waiting/:threadId/nudge drafts the follow-up in
 * your voice (returned, never sent) and the composer opens with it and the reply hints. Without
 * the work routes, or when drafting is off or fails, the composer opens with the plain opener.
 * "You have not written in this thread" (409) is an answer, not a failure, and is passed on.
 */
export async function nudgeThread(w) {
  const who = String(w?.who || '').split(' ')[0];
  const caps = useV2.getState().caps.work;
  const work = caps === null ? await useV2.getState().probeWork() : caps;
  if (w?.threadId && work === true) {
    let res = null;
    try {
      res = await v2Api.post(`/work/waiting/${encodeURIComponent(w.threadId)}/nudge`, {});
    } catch (err) {
      if (err?.status === 409) throw err;
      if (err?.status !== 404 && err?.status !== 403) notify('info', tv('hedwig.v2.waiting.nudgePlain', 'Hedwig could not draft this nudge, so here is a plain one.'), err?.message);
    }
    const draft = typeof res?.draft === 'string' ? res.draft.trim() : '';
    const target = res?.reply?.inReplyToMessageId || w.messageId;
    if (draft && target) {
      await openReplyComposer(target, draft, { to: res.reply?.to, subject: res.reply?.subject });
      return 'drafted';
    }
  }
  if (!w?.messageId) return null;
  await nudge(w.messageId, who);
  return 'plain';
}

/**
 * "Remind me if no reply in N days" after a reply went out: POST /work/waiting { threadId, days }.
 * The reply is already sent, so a failure here is reported on its own and never as a send failure.
 */
export async function watchForReply(threadId, days) {
  if (!threadId || useV2.getState().caps.work !== true) return false;
  try {
    await v2Api.post('/work/waiting', { threadId, days });
    notify('success', tvn(days, ['hedwig.v2.waiting.watchOne', 'Hedwig will remind you if there is no reply by tomorrow.'], ['hedwig.v2.waiting.watchMany', 'Hedwig will remind you if there is no reply in {{n}} days.']));
    return true;
  } catch (err) {
    notify('error', tv('hedwig.v2.waiting.watchFailed', 'Sent, but the reminder could not be set.'), err?.message);
    return false;
  }
}

/** A per-user setting from GET /settings (the fields useV2 keeps), or the fallback. */
export function settingValue(key, fallback) {
  const f = (useV2.getState().settingsFields || []).find((x) => x?.key === key);
  return f && f.value !== undefined && f.value !== null ? f.value : fallback;
}

// ── Reader toolbar actions (upstream's own routes; the mock only reports success) ──

/** Reply all in upstream's composer (Cc edits and all), the body pre-filled when given. */
export async function openReplyAllComposer(messageId, text = '') {
  if (isMockMode()) { useStore.getState().openCompose?.({ subject: 'Re:', body: text, isReplyAll: true }); return; }
  const message = await fullMessage(messageId);
  const st = useStore.getState();
  await openReplyFromMessage(message, {
    accounts: st.accounts || [],
    replyAll: true,
    openCompose: (d) => st.openCompose({ ...d, ...(text ? { body: text } : {}) }),
    getMessageBody: api.getMessageBody,
  });
}

/** Forward in upstream's composer. */
export async function openForwardComposer(messageId) {
  if (isMockMode()) { useStore.getState().openCompose?.({ subject: 'Fwd:' }); return; }
  const message = await fullMessage(messageId);
  await openForwardFromMessage(message, { openCompose: useStore.getState().openCompose, getMessageBody: api.getMessageBody });
}

/** The account's folders for Move ([{ path, name, special_use }]). */
export async function folderList(accountId) {
  if (isMockMode() || !accountId) return [{ path: 'Archive', name: 'Archive' }, { path: 'Receipts', name: 'Receipts' }];
  const data = await api.getFolders(accountId);
  return Array.isArray(data) ? data : (data?.folders || []);
}

/** Move messages to a folder (upstream's bulk move). */
export async function moveMessages(ids, folder, label) {
  const list = (ids || []).filter(Boolean);
  if (!list.length || !folder) return;
  if (!isMockMode()) await api.bulkMove(list, folder);
  notify('success', tv('hedwig.v2.thread.moved', 'Moved to {{folder}}.', { folder: label || folder }));
  announceSortChange({ moved: list, folder });
}

/** Flag (star) one message on or off. */
export async function flagMessage(id, on) {
  if (!id) return;
  if (!isMockMode()) await api.markStarred(id, Boolean(on));
}

/** Mark messages unread again. */
export async function markUnread(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  if (!isMockMode()) await api.bulkRead(list, false);
  notify('success', tv('hedwig.v2.thread.markedUnread', 'Marked as unread.'));
  announceSortChange({ unread: list });
}

/** Report spam: upstream moves it to the account's spam folder. */
export async function reportSpam(id) {
  if (!id) return;
  if (!isMockMode()) await api.markSpam(id);
  notify('success', tv('hedwig.v2.thread.spamDone', 'Reported as spam.'));
  announceSortChange({ spam: id });
}

/** Unsubscribe through the message's List-Unsubscribe (upstream's route). */
export async function unsubscribe(id) {
  if (!id) return null;
  const res = isMockMode() ? { type: 'one-click' } : await api.unsubscribeMessage(id);
  if (!['one-click', 'url', 'mailto'].includes(res?.type)) throw new Error(tv('hedwig.v2.thread.unsubscribeNone', 'This message has no way to unsubscribe.'));
  // A web or mailto unsubscribe finishes in the sender's own page or a new mail.
  const target = res.type === 'url' ? res.url : res.type === 'mailto' ? res.mailto : null;
  if (target && /^(https?:|mailto:)/i.test(target)) window.open(target, '_blank', 'noopener,noreferrer');
  notify('success', tv('hedwig.v2.thread.unsubscribed', 'Unsubscribe requested.'));
  return res;
}

/** Block a sender (upstream's block list). */
export async function blockSender(email) {
  if (!email) return;
  if (!isMockMode()) await api.addToBlockList(email);
  notify('success', tv('hedwig.v2.thread.blocked', 'Blocked {{email}}.', { email }));
  announceSortChange({ blocked: email });
}
