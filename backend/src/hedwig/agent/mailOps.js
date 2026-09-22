// Mail changes behind the agent's mutating tools. These run only in the API process (they need the
// live mail engine) and only for an action the user approved. Each one re-loads the message through
// an ownership join, then follows the same guard / move / repoint / count protocol as the upstream
// routes in routes/mail.js and routes/draft.js. Nothing here sends mail or expunges anything.
import nodemailer from 'nodemailer';
import sanitizeHtml from 'sanitize-html';
import { randomBytes } from 'crypto';
import { query } from '../../services/db.js';
import { getMailEngine } from '../../plugins/mailEngine.js';
import { pluginRegistry } from '../../plugins/registry.js';
import { sanitizeSignature } from '../../services/emailSanitizer.js';
import { archiveInboxCopy } from '../../services/archiveInbox.js';
import {
  resolveArchiveFolder, isAllMailFolder, adjustFolderCounts, fanOutReadToSiblings, fanOutStarToSiblings,
} from '../../utils/mailUtils.js';
import { messageText, addressesOf } from '../text.js';

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
    this.status = 400;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SNOOZE_DAYS = 30;
// Destinations the agent may never move mail into: deleting is not something it can do.
const FORBIDDEN_SPECIAL_USE = new Set(['\\Trash', '\\Junk', '\\Drafts']);
const FORBIDDEN_NAME_RE = /(^|[/.])(trash|bin|deleted items|deleted messages|junk|junk e-?mail|spam|drafts)$/i;

export function mailEngine() {
  return getMailEngine();
}

export function engineAvailable() {
  try {
    getMailEngine();
    return true;
  } catch {
    return false;
  }
}

/** The message row, only when it belongs to `userId`. Throws ToolError otherwise. */
export async function loadOwnedMessage(userId, messageId) {
  if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) throw new ToolError('messageId must be a message id from a tool result');
  const { rows } = await query(
    `SELECT m.*, a.user_id FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = $1 AND a.user_id = $2 AND m.is_deleted = false`,
    [messageId, userId],
  );
  if (!rows.length) throw new ToolError('message not found');
  return rows[0];
}

export async function loadOwnedAccount(userId, accountId) {
  const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
  if (!rows.length) throw new ToolError('account not found');
  return rows[0];
}

const siblingsMaintained = (accountId) => pluginRegistry.hasActiveAsync('inboxIngest', { account: { id: accountId } }).catch(() => false);

// Mirrors notifyMailMutation in routes/mail.js: refresh counts and let label plugins react.
function notifyMutation(engine, rows, userId) {
  for (const accountId of new Set(rows.map((m) => m.account_id))) engine.scheduleCountRefresh?.(accountId);
  const byAccount = new Map();
  for (const m of rows) {
    if (!m.message_id) continue;
    if (!byAccount.has(m.account_id)) byAccount.set(m.account_id, { mids: new Set(), folders: new Set() });
    byAccount.get(m.account_id).mids.add(m.message_id);
    if (m.folder) byAccount.get(m.account_id).folders.add(m.folder);
  }
  for (const [accountId, { mids, folders }] of byAccount) {
    pluginRegistry.runHook('onMailMutation', {
      imapManager: engine.pluginFacade, accountId, userId, messageIds: [...mids], actedFolders: [...folders],
    }).catch((err) => console.warn('[hedwig] onMailMutation hook failed:', err.message));
  }
}

async function setFlag(userId, messageId, { column, changedColumn, imapFlag, value, fanOut }) {
  const engine = mailEngine();
  const m = await loadOwnedMessage(userId, messageId);
  const account = await loadOwnedAccount(userId, m.account_id);
  const changed = Boolean(m[column]) !== value;
  await query(`UPDATE messages SET ${column} = $1, ${changedColumn} = NOW() WHERE id = $2`, [value, m.id]);
  if (changed && column === 'is_read') adjustFolderCounts(m.account_id, m.folder, 0, value ? -1 : 1);
  if (m.message_id && await siblingsMaintained(m.account_id)) await fanOut(m.account_id, m.message_id, value);
  try {
    await engine.setFlag(account, m.uid, m.folder, imapFlag, value);
    engine._resolveFlagPush?.(m.account_id, m.id, imapFlag);
  } catch (err) {
    // Same recovery as the upstream flag routes: a durable retry so a later flag sync cannot
    // silently revert the change.
    console.error(`[hedwig] agent ${imapFlag} update failed:`, err.message);
    engine._enqueueFlagPush?.(m.account_id, m.id, imapFlag, value);
  }
  if (changed) engine.broadcast({ type: 'message_flags', accountId: m.account_id, changes: [{ id: m.id, [column]: value }] }, userId);
  notifyMutation(engine, [m], userId);
  return { messageId: m.id, subject: m.subject, [column]: value, changed };
}

export function markRead(userId, { messageId, read = true }) {
  return setFlag(userId, messageId, { column: 'is_read', changedColumn: 'read_changed_at', imapFlag: '\\Seen', value: Boolean(read), fanOut: fanOutReadToSiblings });
}

export function starMessage(userId, { messageId, starred = true }) {
  return setFlag(userId, messageId, { column: 'is_starred', changedColumn: 'star_changed_at', imapFlag: '\\Flagged', value: Boolean(starred), fanOut: fanOutStarToSiblings });
}

async function repoint(sql, params, fallbackDelete) {
  try {
    return (await query(sql, params)).rowCount > 0;
  } catch (err) {
    // The destination row already exists (IDLE synced it first): drop the source row instead.
    if (err.code !== '23505') throw err;
    return (await query(fallbackDelete.sql, fallbackDelete.params)).rowCount > 0;
  }
}

/**
 * Move one message copy to `dest` with the upstream guard protocol (see services/archiveInbox.js):
 * the source uid is guarded for the whole move; without UIDPLUS the destination keeps the stale uid
 * and is guarded until the next sync learns the real one.
 */
async function relocate(engine, account, m, dest) {
  const allMail = await isAllMailFolder(account.id, dest);
  const deleteSource = { sql: 'DELETE FROM messages WHERE id = $1 AND folder = $2', params: [m.id, m.folder] };
  engine._guardMoveUid(account.id, m.folder, m.uid);
  let destGuardHeld = false;
  try {
    const newUid = await engine.moveMessage(account, m.uid, m.folder, dest);
    let applied;
    if (allMail) {
      applied = (await query(deleteSource.sql, deleteSource.params)).rowCount > 0;
    } else if (newUid != null) {
      applied = await repoint('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3 AND folder = $4', [dest, newUid, m.id, m.folder], deleteSource);
    } else {
      engine._guardMoveUid(account.id, dest, m.uid);
      destGuardHeld = true;
      applied = await repoint('UPDATE messages SET folder = $1 WHERE id = $2 AND folder = $3', [dest, m.id, m.folder], deleteSource);
      if (applied) setTimeout(() => engine._unguardMoveUid(account.id, dest, m.uid), 10_000);
      else engine._unguardMoveUid(account.id, dest, m.uid);
      destGuardHeld = false;
    }
    if (applied) {
      adjustFolderCounts(account.id, m.folder, -1, m.is_read ? 0 : -1);
      if (!allMail) adjustFolderCounts(account.id, dest, 1, m.is_read ? 0 : 1);
    }
    return applied;
  } finally {
    engine._unguardMoveUid(account.id, m.folder, m.uid);
    if (destGuardHeld) engine._unguardMoveUid(account.id, dest, m.uid);
  }
}

export function validFolderName(name) {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
}

/** Check a move destination without touching mail (used when the action is proposed and again when it runs). */
export async function checkMoveTarget(userId, { messageId, folder }) {
  if (!validFolderName(folder)) throw new ToolError('folder must be a folder path from the account');
  const m = await loadOwnedMessage(userId, messageId);
  const { rows } = await query('SELECT path, special_use FROM folders WHERE account_id = $1 AND path = $2', [m.account_id, folder]);
  if (!rows.length) throw new ToolError(`folder "${folder}" does not exist in this message's account`);
  if (FORBIDDEN_SPECIAL_USE.has(rows[0].special_use) || FORBIDDEN_NAME_RE.test(folder)) {
    throw new ToolError('the agent cannot move mail to Trash, Junk or Drafts');
  }
  return m;
}

export async function moveMessage(userId, { messageId, folder }) {
  const engine = mailEngine();
  const m = await checkMoveTarget(userId, { messageId, folder });
  if (m.folder === folder) return { messageId: m.id, folder, moved: false, note: 'already in that folder' };
  const account = await loadOwnedAccount(userId, m.account_id);
  const moved = await relocate(engine, account, m, folder);
  if (moved) engine.broadcast({ type: 'folder_updated', folder, accountId: account.id }, userId);
  notifyMutation(engine, [m], userId);
  return { messageId: m.id, subject: m.subject, from: m.folder, to: folder, moved };
}

export async function archiveMessage(userId, { messageId }) {
  const engine = mailEngine();
  const m = await loadOwnedMessage(userId, messageId);
  const account = await loadOwnedAccount(userId, m.account_id);
  const archive = await resolveArchiveFolder(account.id, account.folder_mappings);
  if (!archive) throw new ToolError('this account has no Archive folder configured');
  if (m.folder === archive) return { messageId: m.id, archived: false, note: 'already archived' };
  let archived;
  if (m.folder === 'INBOX') {
    ({ archived } = await archiveInboxCopy(engine, account, m));
    // archiveInboxCopy assumes its caller already marked the thread read; ours may be unread.
    if (archived && !m.is_read) {
      adjustFolderCounts(account.id, 'INBOX', 0, -1);
      if (!(await isAllMailFolder(account.id, archive))) adjustFolderCounts(account.id, archive, 0, 1);
    }
  } else {
    archived = await relocate(engine, account, m, archive);
  }
  if (archived) engine.broadcast({ type: 'folder_updated', folder: archive, accountId: account.id }, userId);
  notifyMutation(engine, [m], userId);
  return { messageId: m.id, subject: m.subject, archived, folder: archive };
}

export function checkSnoozeUntil(until, now = Date.now()) {
  const t = Date.parse(until);
  if (!Number.isFinite(t)) throw new ToolError('until must be an ISO 8601 date-time');
  if (t <= now) throw new ToolError('until must be in the future');
  if (t > now + MAX_SNOOZE_DAYS * 86400_000) throw new ToolError(`until must be within ${MAX_SNOOZE_DAYS} days`);
  return new Date(t);
}

async function snoozeConversation(m) {
  // gatherSnoozeConversation lives in routes/mail.js, which only the API process loads; this
  // function only runs there, so the dynamic import resolves to the already-loaded module.
  try {
    const { gatherSnoozeConversation } = await import('../../routes/mail.js');
    return await gatherSnoozeConversation(m);
  } catch (err) {
    console.warn('[hedwig] snooze: conversation lookup failed, snoozing the message alone:', err.message);
    return [m];
  }
}

/** Mirrors POST /api/mail/messages/:id/snooze. */
export async function snoozeMessage(userId, { messageId, until }) {
  const engine = mailEngine();
  const untilDate = checkSnoozeUntil(until);
  const m = await loadOwnedMessage(userId, messageId);
  if (!m.message_id) throw new ToolError('this message has no Message-ID header and cannot be snoozed');
  const snoozedFolder = 'Snoozed';
  if (m.folder === snoozedFolder) throw new ToolError('the message is already snoozed');
  const existing = await query('SELECT id FROM snoozed_messages WHERE account_id = $1 AND message_id_header = $2', [m.account_id, m.message_id]);
  if (existing.rows.length) throw new ToolError('the message is already snoozed');
  const account = await loadOwnedAccount(userId, m.account_id);
  const convo = await snoozeConversation(m);
  await engine.ensureFolder(account, snoozedFolder);
  let count = 0;
  for (const tm of convo) {
    engine._guardMoveUid(tm.account_id, tm.folder, tm.uid);
    try {
      let snoozedUid;
      try {
        snoozedUid = await engine.moveMessage(account, tm.uid, tm.folder, snoozedFolder);
      } catch (err) {
        if (tm.id === m.id) throw err;
        console.error(`[hedwig] snooze move failed for sibling ${tm.id}:`, err.message);
        continue;
      }
      if (snoozedUid != null) {
        await query('UPDATE messages SET folder = $1, uid = $2 WHERE id = $3', [snoozedFolder, snoozedUid, tm.id]);
      } else {
        engine._guardMoveUid(tm.account_id, snoozedFolder, tm.uid);
        await query('UPDATE messages SET folder = $1 WHERE id = $2', [snoozedFolder, tm.id]);
        setTimeout(() => engine._unguardMoveUid(tm.account_id, snoozedFolder, tm.uid), 10_000);
      }
      await query(
        `INSERT INTO snoozed_messages (user_id, account_id, message_id_header, original_folder, snooze_until, snoozed_folder)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, tm.account_id, tm.message_id, tm.folder, untilDate.toISOString(), snoozedFolder],
      );
      adjustFolderCounts(tm.account_id, tm.folder, -1, tm.is_read ? 0 : -1);
      adjustFolderCounts(tm.account_id, snoozedFolder, 1, tm.is_read ? 0 : 1);
      count++;
    } finally {
      engine._unguardMoveUid(tm.account_id, tm.folder, tm.uid);
    }
  }
  notifyMutation(engine, convo, userId);
  return { messageId: m.id, subject: m.subject, snoozed_until: untilDate.toISOString(), messages: count };
}

// ── Reply drafts ────────────────────────────────────────────────────────────────

const stripHeader = (v) => String(v || '').replace(/[\r\n\0]/g, ' ').trim();
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Same paragraph rendering as routes/draft.js textToHtml, so the composer reopens it identically.
function textToHtml(text) {
  return text.split('\n').map((l) => `<p style="margin:0">${escapeHtml(l) || '&nbsp;'}</p>`).join('');
}

// Same resolution as routes/draft.js resolveDraftsFolder.
async function resolveDraftsFolder(account) {
  const mapped = account.folder_mappings?.drafts;
  if (mapped) return mapped;
  const { rows } = await query("SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1", [account.id]);
  return rows[0]?.path || null;
}

async function ownAddresses(userId) {
  const { rows } = await query(
    `SELECT lower(email_address) AS e FROM email_accounts WHERE user_id = $1
     UNION SELECT lower(al.email) FROM account_aliases al JOIN email_accounts a ON a.id = al.account_id WHERE a.user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.e));
}

/** Recipients for a reply to `m`: pure, exported for tests. */
export function replyRecipients(m, own, { replyAll = false } = {}) {
  const from = addressesOf([{ address: m.from_email, name: m.from_name }]);
  const replyTo = addressesOf(m.reply_to);
  const toList = addressesOf(m.to_addresses);
  const ccList = addressesOf(m.cc_addresses);
  const outgoing = own.has(String(m.from_email || '').toLowerCase());
  let to = outgoing ? toList : (replyTo.length ? replyTo : from);
  let cc = replyAll ? [...(outgoing ? [] : toList), ...ccList] : [];
  const seen = new Set();
  const keep = (a) => {
    if (own.has(a.email) || seen.has(a.email)) return false;
    seen.add(a.email);
    return true;
  };
  to = to.filter(keep);
  cc = cc.filter(keep);
  return { to, cc };
}

export function replySubject(subject) {
  const s = stripHeader(subject);
  return /^re:/i.test(s) ? s : `Re: ${s || '(no subject)'}`;
}

async function pickIdentity(userId, account, m) {
  const delivered = new Set([...addressesOf(m.to_addresses), ...addressesOf(m.cc_addresses)].map((a) => a.email));
  const { rows } = await query('SELECT name, email, signature FROM account_aliases WHERE account_id = $1', [account.id]);
  const alias = rows.find((a) => delivered.has(String(a.email || '').toLowerCase()));
  if (alias) return { name: alias.name || account.sender_name || account.name, email: alias.email, signature: alias.signature ?? account.signature };
  return { name: account.sender_name || account.name, email: account.email_address, signature: account.signature };
}

export async function checkDraftReply(userId, { messageId }) {
  const m = await loadOwnedMessage(userId, messageId);
  const account = await loadOwnedAccount(userId, m.account_id);
  if (!(await resolveDraftsFolder(account))) throw new ToolError('this account has no Drafts folder');
  return m;
}

/**
 * Save a reply to `messageId` as a draft in the account's Drafts folder, the way routes/draft.js
 * saves one: nodemailer builds the MIME, the draft is APPENDed with \Draft \Seen, and a local row is
 * written so the composer can open it at once. The draft is never sent.
 */
export async function draftReply(userId, { messageId, body, replyAll = false }) {
  const engine = mailEngine();
  const m = await loadOwnedMessage(userId, messageId);
  const account = await loadOwnedAccount(userId, m.account_id);
  const draftsFolder = await resolveDraftsFolder(account);
  if (!draftsFolder) throw new ToolError('this account has no Drafts folder');
  const own = await ownAddresses(userId);
  const { to, cc } = replyRecipients(m, own, { replyAll });
  if (!to.length && !cc.length) throw new ToolError('could not work out who to reply to');
  const identity = await pickIdentity(userId, account, m);
  const subject = replySubject(m.subject);

  const signature = identity.signature ? sanitizeSignature(identity.signature) : null;
  const sigText = signature ? sanitizeHtml(signature, { allowedTags: [], allowedAttributes: {} }).trim() : null;
  const replyText = String(body || '').replace(/\r\n?/g, '\n').trim();
  const quoted = messageText(m, { maxChars: 4000, stripQuotes: true });
  const when = m.date ? new Date(m.date).toUTCString() : 'an earlier date';
  const attribution = `On ${when}, ${m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email} wrote:`;
  const quotedText = quoted ? `\n\n${attribution}\n${quoted.split('\n').map((l) => `> ${l}`).join('\n')}` : '';
  const textBody = `${replyText}${sigText ? `\n\n-- \n${sigText}` : ''}${quotedText}`;
  const html = textToHtml(replyText)
    // data-mailflow-signature lets the composer lift the signature back out (see routes/draft.js).
    + (signature ? `<div data-mailflow-signature="1" style="margin-top:16px;color:#555;font-size:13px">${signature}</div>` : '')
    + (quoted ? `<p style="margin:16px 0 0">${escapeHtml(attribution)}</p><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${textToHtml(quoted)}</blockquote>` : '');

  const draftMessageId = `<${randomBytes(16).toString('hex')}@${identity.email.split('@')[1] || 'mailflow.local'}>`;
  const references = [m.thread_references, m.message_id].filter(Boolean).join(' ').trim() || undefined;
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
  const info = await transport.sendMail({
    messageId: draftMessageId,
    from: { name: stripHeader(identity.name), address: identity.email },
    to: to.map((a) => ({ name: stripHeader(a.name || ''), address: a.email })),
    cc: cc.length ? cc.map((a) => ({ name: stripHeader(a.name || ''), address: a.email })) : undefined,
    subject,
    inReplyTo: m.message_id || undefined,
    references,
    text: textBody,
    html,
  });
  const chunks = [];
  await new Promise((resolve, reject) => {
    info.message.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    info.message.on('end', resolve);
    info.message.on('error', reject);
  });

  const { uid } = await engine.appendToFolder(account, draftsFolder, Buffer.concat(chunks), ['\\Draft', '\\Seen']);
  if (uid != null) {
    try {
      await engine.upsertDraftMessageRecord(account, draftsFolder, uid, {
        messageId: draftMessageId,
        subject,
        fromName: identity.name,
        fromEmail: identity.email,
        to: to.map((a) => ({ name: a.name || '', email: a.email })),
        cc: cc.map((a) => ({ name: a.name || '', email: a.email })),
        inReplyTo: m.message_id || null,
        snippet: textBody.replace(/\s+/g, ' ').trim().slice(0, 200),
        bodyHtml: html,
        bodyText: textBody,
      });
    } catch (err) {
      // Non-fatal, as upstream: the draft is safely on the server and the next sync lists it.
      console.error(`[hedwig] draft reply: local row for uid=${uid} failed:`, err.message);
    }
  }
  engine.broadcast({ type: 'folder_updated', folder: draftsFolder, accountId: account.id }, userId);
  return { messageId: m.id, draft: { folder: draftsFolder, uid, subject, to: to.map((a) => a.email), cc: cc.map((a) => a.email) } };
}
