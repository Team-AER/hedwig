// compose.createDraft: build a MIME draft and APPEND it to the account's Drafts folder. It creates a
// draft only; nothing in the plugin runtime can send. Mirrors routes/draft.js (identity, sanitizer,
// stable Message-ID, local Drafts row) without importing it, because that route module imports the
// application entry point. Needs the live mail engine, so it runs in the API process.
import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { query } from '../../services/db.js';
import { sanitizeComposeBody, sanitizeSignature } from '../../services/emailSanitizer.js';
import { getOwnedAccount, loadOwnedMessage } from '../../services/mailAccess.js';
import { PluginInputError } from './errors.js';
import { isUuid } from './mail.js';

const MAX_BODY = 200_000;

function headerValue(v) {
  return typeof v === 'string' ? v.replace(/[\r\n\0]/g, '').trim() : '';
}

function recipients(list, field) {
  if (list === undefined || list === null) return [];
  const arr = Array.isArray(list) ? list : [list];
  if (arr.length > 100) throw new PluginInputError(`${field}: at most 100 recipients`);
  return arr.map((a, i) => {
    if (typeof a !== 'string' || !a.trim() || /[\r\n\0]/.test(a) || a.length > 320) throw new PluginInputError(`${field}[${i}] is not a valid address`);
    const at = a.lastIndexOf('@');
    if (at < 1 || at === a.trim().length - 1) throw new PluginInputError(`${field}[${i}] is not a valid address`);
    return a.trim();
  });
}

function parseAddress(str) {
  const m = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: str.replace(/[<>]/g, '').trim().toLowerCase() };
}

function textToHtml(text) {
  return text.split('\n').map((l) => `<p style="margin:0">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;'}</p>`).join('');
}

async function resolveDraftsFolder(account) {
  if (account.folder_mappings?.drafts) return account.folder_mappings.drafts;
  const { rows } = await query("SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1", [account.id]);
  return rows[0]?.path || null;
}

/** Validate and normalise the plugin's input (shared by the in-process path and the queued job). */
export function normaliseDraftInput(input) {
  if (!input || typeof input !== 'object') throw new PluginInputError('createDraft needs { accountId, to, subject, body }');
  const body = input.body ?? '';
  if (typeof body !== 'string' || body.length > MAX_BODY) throw new PluginInputError(`body must be a string up to ${MAX_BODY} characters`);
  if (input.accountId !== undefined && !isUuid(input.accountId)) throw new PluginInputError('accountId must be a uuid');
  if (input.replyToMessageId !== undefined && !isUuid(input.replyToMessageId)) throw new PluginInputError('replyToMessageId must be a uuid');
  if (input.aliasId !== undefined && !isUuid(input.aliasId)) throw new PluginInputError('aliasId must be a uuid');
  return {
    accountId: input.accountId,
    aliasId: input.aliasId,
    replyToMessageId: input.replyToMessageId,
    to: recipients(input.to, 'to'),
    cc: recipients(input.cc, 'cc'),
    bcc: recipients(input.bcc, 'bcc'),
    subject: headerValue(input.subject || '').slice(0, 998),
    body,
    bodyIsHtml: input.bodyIsHtml === true,
  };
}

/** Create the draft now. `engine` is the API process's ImapManager. */
export async function createDraftNow(userId, rawInput, engine) {
  const input = normaliseDraftInput(rawInput);
  let original = null;
  if (input.replyToMessageId) {
    original = await loadOwnedMessage(userId, input.replyToMessageId);
    if (!original) throw new PluginInputError('replyToMessageId not found');
  }
  const accountId = input.accountId || original?.account_id;
  if (!accountId) throw new PluginInputError('accountId (or replyToMessageId) is required');
  const account = await getOwnedAccount(userId, accountId);
  if (!account) throw new PluginInputError('account not found');

  let fromName = account.sender_name || account.name;
  let fromEmail = account.email_address;
  let signature = account.signature;
  if (input.aliasId) {
    const { rows } = await query('SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2', [input.aliasId, account.id]);
    if (!rows[0]) throw new PluginInputError('alias not found');
    fromName = rows[0].name; fromEmail = rows[0].email;
    if (rows[0].signature !== null) signature = rows[0].signature;
  }
  const sig = signature ? sanitizeSignature(signature) : null;
  const sigText = sig ? sanitizeHtml(sig, { allowedTags: [], allowedAttributes: {} }).trim() : null;
  const bodyText = input.bodyIsHtml ? sanitizeHtml(input.body, { allowedTags: [], allowedAttributes: {} }) : input.body;
  const bodyHtml = (input.bodyIsHtml ? sanitizeComposeBody(input.body) : textToHtml(input.body))
    + (sig ? `<div data-mailflow-signature="1" style="margin-top:16px;color:#555;font-size:13px">${sig}</div>` : '');
  const textBody = sigText ? `${bodyText}\n\n-- \n${sigText}` : bodyText;

  let subject = input.subject;
  const headers = {};
  if (original) {
    if (!subject) subject = /^re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`.trim();
    if (original.message_id) {
      headers.inReplyTo = headerValue(original.message_id);
      headers.references = headerValue([original.thread_references, original.message_id].filter(Boolean).join(' ')).slice(0, 4000);
    }
  }

  const messageId = `<${randomBytes(16).toString('hex')}@${fromEmail.split('@')[1] || 'hedwig.local'}>`;
  const transport = nodemailer.createTransport({ streamTransport: true, newline: 'windows' });
  const info = await transport.sendMail({
    messageId,
    from: `${fromName} <${fromEmail}>`,
    to: input.to.join(', ') || undefined,
    cc: input.cc.join(', ') || undefined,
    bcc: input.bcc.join(', ') || undefined,
    subject,
    text: textBody,
    html: bodyHtml,
    ...headers,
  });
  const chunks = [];
  await new Promise((resolve, reject) => {
    info.message.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    info.message.on('end', resolve);
    info.message.on('error', reject);
  });

  const folder = await resolveDraftsFolder(account);
  if (!folder) throw new PluginInputError('no Drafts folder found for this account');
  const { uid } = await engine.appendToFolder(account, folder, Buffer.concat(chunks), ['\\Draft', '\\Seen']);
  if (uid != null) {
    await engine.upsertDraftMessageRecord(account, folder, uid, {
      messageId, subject, fromName, fromEmail,
      to: input.to.map(parseAddress), cc: input.cc.map(parseAddress),
      inReplyTo: headers.inReplyTo || null,
      snippet: textBody.replace(/\s+/g, ' ').trim().slice(0, 200),
      bodyHtml, bodyText: textBody,
    }).catch((err) => console.warn('[pluginsv2] draft row upsert failed:', err.message));
  }
  return { created: true, uid: uid ?? null, folder, accountId: account.id };
}
