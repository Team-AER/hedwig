import { pickReplyAlias } from './replyAlias.js';
import { splitDraftSignature } from './draftSignature.js';

function parseAddressField(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name ? `${a.name} <${a.email}>` : a.email).filter(Boolean).join(', ');
  } catch { return ''; }
}

export async function openReplyFromMessage(message, { accounts, openCompose, getMessageBody, replyAll = false }) {
  const replyToArr = Array.isArray(message.reply_to)
    ? message.reply_to
    : (() => { try { return JSON.parse(message.reply_to || '[]'); } catch { return []; } })();
  const replyTarget = (replyToArr.length && replyToArr[0].email)
    ? replyToArr[0]
    : { name: message.from_name || '', email: message.from_email || '' };
  const sender = replyTarget.email ? [replyTarget] : [];

  const myAccount = accounts.find(a => a.id === message.account_id);
  const myEmail = myAccount?.email_address || '';
  const myAddresses = new Set([
    myEmail.toLowerCase(),
    ...(myAccount?.aliases || []).map(al => al.email.toLowerCase()),
  ]);

  // Delivered-To first, then the same To/Cc/From scan this used to do inline. Replying
  // from the list and from the reading pane must choose the same alias, and the pane's
  // version was the one that had been fixed.
  const replyAliasId = pickReplyAlias({
    aliases: myAccount?.aliases || [],
    deliveryAddresses: message.delivery_addresses,
    toAddresses: message.to_addresses,
    ccAddresses: message.cc_addresses,
    fromEmail: message.from_email,
  });

  const allRecipients = (() => {
    try {
      const toArr = Array.isArray(message.to_addresses)
        ? message.to_addresses
        : JSON.parse(message.to_addresses || '[]');
      const ccArr = Array.isArray(message.cc_addresses)
        ? message.cc_addresses
        : JSON.parse(message.cc_addresses || '[]');
      return [...toArr, ...ccArr].filter(
        t => t.email && !myAddresses.has(t.email.toLowerCase()) && t.email !== replyTarget.email
      );
    } catch { return []; }
  })();

  const referencesChain = [message.in_reply_to, message.message_id]
    .filter(Boolean).join(' ').trim() || null;
  const rawSubject = (message.subject || '').trim();

  const replyBody = await getMessageBody(message.id).catch(() => null);
  const replyDate = message.date ? new Date(message.date).toLocaleString() : '';
  const replySafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
  const replyFromStr = replySafeName
    ? `${replySafeName} <${message.from_email}>`
    : message.from_email || '';
  const quotedText = replyBody?.text
    ? `\n\n---\nOn ${replyDate}, ${replyFromStr} wrote:\n${replyBody.text.split('\n').map(l => '> ' + l).join('\n')}`
    : '';
  const quotedBodyHtml = replyBody?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${replyDate}, ${replyFromStr} wrote:</p>${replyBody.html}</div>`
    : null;

  openCompose({
    to: sender,
    cc: replyAll ? allRecipients : [],
    subject: rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:',
    body: '',
    quotedBody: quotedText,
    quotedBodyHtml,
    inReplyTo: message.message_id,
    references: referencesChain,
    accountId: message.account_id,
    aliasId: replyAliasId,
    isReply: true,
    isReplyAll: replyAll,
    originalFrom: sender,
    allRecipients,
    threadId: message.thread_id,
  });
}

export async function openForwardFromMessage(message, { openCompose, getMessageBody }) {
  const fwdBody = await getMessageBody(message.id).catch(() => null);
  const fwdDate = message.date ? new Date(message.date).toLocaleString() : '';
  const fwdSafeName = (message.from_name || '').replace(/[\r\n]+/g, ' ');
  const fwdFromStr = fwdSafeName
    ? `${fwdSafeName} <${message.from_email}>`
    : message.from_email || '';
  const safeSubject = (message.subject || '').replace(/[\r\n]+/g, ' ');
  const toStr = parseAddressField(message.to_addresses);
  const ccStr = parseAddressField(message.cc_addresses);

  const fwdText = `\n\n---------- Forwarded message ----------\nFrom: ${fwdFromStr}\nDate: ${fwdDate}\nSubject: ${safeSubject}${toStr ? `\nTo: ${toStr}` : ''}${ccStr ? `\nCc: ${ccStr}` : ''}\n\n${fwdBody?.text || ''}`;
  const fwdHtml = fwdBody?.html
    ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: ${fwdFromStr}<br>Date: ${fwdDate}<br>Subject: ${safeSubject}${toStr ? `<br>To: ${toStr}` : ''}${ccStr ? `<br>Cc: ${ccStr}` : ''}</p>${fwdBody.html}</div>`
    : null;

  openCompose({
    subject: message.subject?.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
    body: '',
    quotedBody: fwdText,
    quotedBodyHtml: fwdHtml,
    accountId: message.account_id,
    isForward: true,
    forwardedAttachments: (fwdBody?.attachments || []).map(att => ({
      messageId: message.id,
      part: att.part,
      filename: att.filename || 'attachment',
      type: att.type || 'application/octet-stream',
      size: att.size || 0,
    })),
  });
}

// ── Drafts ────────────────────────────────────────────────────────────────────
// One implementation of "reopen a saved draft in the composer", shared by the classic list
// (MessageList, when the Drafts folder is open) and Hedwig's Drafts view and thread reader.

/** The account's Drafts folder path: the folder mapping first, else the \\Drafts special-use folder. */
export function draftsFolderFor(account, folderList) {
  if (account?.folder_mappings?.drafts) return account.folder_mappings.drafts;
  const hit = (Array.isArray(folderList) ? folderList : []).find(f => f?.special_use === '\\Drafts');
  return hit?.path || null;
}

/** True when `folder` is the Drafts folder of `accountId` (the classic list's isDraftsFolder). */
export function isDraftsFolder(accountId, folder, { accounts = [], folders = {} } = {}) {
  if (!accountId || !folder) return false;
  const account = (accounts || []).find(a => a.id === accountId);
  if (!account) return false;
  if (account.folder_mappings?.drafts && account.folder_mappings.drafts === folder) return true;
  const folderInfo = (folders?.[accountId] || []).find(f => f.path === folder);
  return folderInfo?.special_use === '\\Drafts';
}

/** An address list (array or its JSON text) as the composer's "Name <addr>" strings. */
export function formatAddressArray(raw) {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr || '[]'); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map(a => {
    if (typeof a === 'string') return a;
    const addr = a?.address || a?.email || '';
    return (a?.name && addr) ? `${a.name} <${addr}>` : (addr || a?.name || '');
  }).filter(Boolean);
}

/**
 * Open a saved draft (an upstream message row: id, uid, folder, account_id, to/cc, subject) in
 * the composer for editing. The composer replaces the stored copy on save (draftUid/draftFolder)
 * and deletes it on send. Throws when the body cannot be loaded; the caller decides what then.
 */
export async function openDraftInComposer(message, { openCompose, getMessageBody }) {
  const bodyData = await getMessageBody(message.id);
  // A saved draft is one document: body, signature, then any quoted text. Handing all of
  // it over as the body left the signature inline AND had compose render a fresh one, so
  // every save/reopen cycle added another copy (#432). Lift the signature back out, or
  // suppress compose's own when it is present but cannot be lifted safely.
  const raw = bodyData?.html || bodyData?.text || '';
  const { body, signature, inline } = bodyData?.html
    ? splitDraftSignature(raw)
    : { body: raw, signature: null, inline: false };
  const payload = {
    accountId: message.account_id ?? message.accountId,
    draftUid: message.uid,
    draftFolder: message.folder,
    to: formatAddressArray(message.to_addresses),
    cc: formatAddressArray(message.cc_addresses),
    subject: message.subject || '',
    body,
    bodyIsHtml: !!bodyData?.html,
    ...(signature !== null ? { signature } : inline ? { signature: '' } : {}),
  };
  openCompose(payload);
  return payload;
}
