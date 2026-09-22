// Mail capabilities behind the v2 facade. Reads are fixed, ownership-scoped queries (every one
// joins email_accounts on user_id) that return projected shapes — never `m.*` or an account row,
// which carry credentials, uids and raw headers a plugin has no business holding. Writes go through
// upstream's reviewed label/archive primitives (plugins/api.js), which need the live mail engine:
// in the worker process they are handed to the API process as a job.
import { query } from '../../services/db.js';
import { loadOwnedMessage, getOwnedAccount } from '../../services/mailAccess.js';
import { messageText, addressesOf } from '../text.js';
import { PluginInputError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCLUDED_FOLDERS = "m.folder !~* '(^|/)(spam|junk|trash|bin|deleted items)$'";

const LITE_COLUMNS = `
  m.id, m.account_id, a.name AS account_name, a.color AS account_color, m.folder, m.subject,
  m.from_name, m.from_email, m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments,
  m.thread_key, m.category, m.is_bulk, (m.list_unsubscribe IS NOT NULL) AS has_list_unsubscribe`;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function toLite(r) {
  return {
    id: r.id,
    account_id: r.account_id,
    account: { id: r.account_id, name: r.account_name ?? null, color: r.account_color ?? null },
    folder: r.folder,
    subject: r.subject,
    from_name: r.from_name,
    from_email: r.from_email,
    date: r.date,
    snippet: r.snippet,
    is_read: r.is_read,
    is_starred: r.is_starred,
    has_attachments: r.has_attachments,
    thread_key: r.thread_key,
    category: r.category ?? null,
    is_bulk: r.is_bulk ?? null,
    has_list_unsubscribe: Boolean(r.has_list_unsubscribe ?? r.list_unsubscribe),
  };
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

/** Full plugin view of one message. Bodies are included; the raw row never leaves this module. */
function toFull(row, account, { html = false } = {}) {
  const attachments = parseJson(row.attachments, []);
  return {
    ...toLite({ ...row, account_name: account?.name, account_color: account?.color }),
    message_id_header: row.message_id || null,
    in_reply_to: row.in_reply_to || null,
    references: row.thread_references || null,
    to: addressesOf(row.to_addresses),
    cc: addressesOf(row.cc_addresses),
    reply_to: addressesOf(row.reply_to),
    list_unsubscribe: row.list_unsubscribe || null,
    text: messageText(row, { maxChars: 20_000, stripQuotes: false }),
    html: html ? (row.body_html || null) : undefined,
    body_fetched: Boolean(row.body_text || row.body_html),
    attachments: (Array.isArray(attachments) ? attachments : []).map((a) => ({
      filename: a?.filename || null,
      contentType: a?.type || a?.contentType || null,
      size: Number(a?.size) || null,
    })),
  };
}

export async function listAccounts(userId) {
  const { rows } = await query(
    `SELECT id, name, email_address, color, sender_name FROM email_accounts
      WHERE user_id = $1 AND enabled IS NOT FALSE ORDER BY sort_order, created_at`,
    [userId],
  );
  const ids = rows.map((r) => r.id);
  const { rows: aliases } = ids.length
    ? await query('SELECT account_id, name, email FROM account_aliases WHERE account_id = ANY($1::uuid[])', [ids])
    : { rows: [] };
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: String(r.email_address || '').toLowerCase(),
    displayName: r.sender_name || r.name,
    color: r.color,
    aliases: aliases.filter((a) => a.account_id === r.id).map((a) => ({ email: String(a.email || '').toLowerCase(), name: a.name })),
  }));
}

/**
 * Search the user's mail. Plain filters, no raw SQL from the plugin.
 * @param {object} o { q, from, accountId, folder, category, triage, bulk, unread, after, before, limit }
 */
export async function search(userId, o = {}) {
  const params = [userId];
  const where = ['a.user_id = $1', 'm.is_deleted = false', EXCLUDED_FOLDERS];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
  if (o.q) {
    if (typeof o.q !== 'string' || o.q.length > 200) throw new PluginInputError('q must be a string up to 200 characters');
    add("(m.subject ILIKE $? ESCAPE '\\' OR m.from_email ILIKE $? ESCAPE '\\' OR m.from_name ILIKE $? ESCAPE '\\' OR m.snippet ILIKE $? ESCAPE '\\')", `%${escapeLike(o.q)}%`);
  }
  if (o.from) add("m.from_email ILIKE $? ESCAPE '\\'", `%${escapeLike(String(o.from).slice(0, 200))}%`);
  if (o.accountId) {
    if (!isUuid(o.accountId)) throw new PluginInputError('accountId must be a uuid');
    add('m.account_id = $?', o.accountId);
  }
  if (o.folder) add('m.folder = $?', String(o.folder).slice(0, 300));
  if (o.category) add('m.category = $?', String(o.category).slice(0, 50));
  if (o.bulk === true) where.push('(m.is_bulk = true OR m.list_unsubscribe IS NOT NULL)');
  if (o.unread === true) where.push('m.is_read = false');
  if (o.hasAttachments === true) where.push('m.has_attachments = true');
  if (o.triage) {
    add(`EXISTS (SELECT 1 FROM hedwig_triage t WHERE t.message_id = m.id AND t.user_id = $1
                  AND COALESCE(t.override_category, t.category) = $?)`, String(o.triage).slice(0, 40));
  }
  for (const [key, op] of [['after', '>='], ['before', '<']]) {
    if (o[key] === undefined || o[key] === null) continue;
    const d = new Date(o[key]);
    if (Number.isNaN(d.getTime())) throw new PluginInputError(`${key} must be a date`);
    add(`m.date ${op} $?`, d.toISOString());
  }
  const limit = Math.max(1, Math.min(200, Number(o.limit) || 50));
  params.push(limit);
  const { rows } = await query(
    `SELECT ${LITE_COLUMNS}
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.date DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toLite);
}

async function ownedMessageAndAccount(userId, messageId) {
  if (!isUuid(messageId)) return { row: null, account: null };
  const row = await loadOwnedMessage(userId, messageId);
  if (!row) return { row: null, account: null };
  const account = await getOwnedAccount(userId, row.account_id);
  return { row, account };
}

export async function getMessage(userId, messageId, opts = {}) {
  const { row, account } = await ownedMessageAndAccount(userId, messageId);
  return row ? toFull(row, account, opts) : null;
}

export async function getThread(userId, messageId) {
  const { row } = await ownedMessageAndAccount(userId, messageId);
  if (!row) return [];
  if (!row.thread_key) return [toLite(row)];
  const { rows } = await query(
    `SELECT ${LITE_COLUMNS}
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.account_id = $2 AND m.thread_key = $3 AND m.is_deleted = false
      ORDER BY m.date ASC NULLS FIRST LIMIT 200`,
    [userId, row.account_id, row.thread_key],
  );
  return rows.map(toLite);
}

/** The user's message with this RFC Message-ID (newest copy), as a full view, or null. */
export async function findByMessageId(userId, header, opts = {}) {
  if (typeof header !== 'string' || !header || header.length > 998) return null;
  const { rows } = await query(
    `SELECT m.id FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.message_id = $2 AND m.is_deleted = false
      ORDER BY (m.folder = 'INBOX') DESC, m.date DESC NULLS LAST LIMIT 1`,
    [userId, header.trim()],
  );
  return rows[0] ? getMessage(userId, rows[0].id, opts) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────
let engineAvailable = () => false;
/** Set by the API process so writes run in-process there and are queued from the worker. */
export function setEngineAvailability(fn) { engineAvailable = fn; }
export function mailEngineAvailable() { return engineAvailable(); }

function checkFolder(folder) {
  if (typeof folder !== 'string' || !folder.trim() || folder.length > 300 || /[\0\r\n]/.test(folder)) {
    throw new PluginInputError('label folder must be a non-empty folder path');
  }
}

/** Apply a label (copy into a label folder). Runs in the API process. */
export async function applyLabelNow(userId, messageId, labelFolder) {
  checkFolder(labelFolder);
  const { row, account } = await ownedMessageAndAccount(userId, messageId);
  if (!row || !account) throw new PluginInputError('message not found');
  const api = await import('../../plugins/api.js');
  const res = await api.applyLabel(account, row, labelFolder);
  return { applied: Boolean(res?.applied), reason: res?.reason || null };
}

/** Archive the INBOX copy of a message. Runs in the API process. */
export async function archiveNow(userId, messageId) {
  const { row, account } = await ownedMessageAndAccount(userId, messageId);
  if (!row || !account) throw new PluginInputError('message not found');
  let inboxCopy = row.folder === 'INBOX' ? row : null;
  if (!inboxCopy && row.message_id) {
    const { rows } = await query(
      "SELECT id, uid, folder FROM messages WHERE account_id = $1 AND folder = 'INBOX' AND message_id = $2 AND is_deleted = false LIMIT 1",
      [account.id, row.message_id],
    );
    inboxCopy = rows[0] || null;
  }
  if (!inboxCopy) return { archived: false, reason: 'not-in-inbox' };
  const api = await import('../../plugins/api.js');
  const res = await api.archiveInboxCopy(account, inboxCopy);
  return { archived: Boolean(res?.archived), reason: res?.noArchiveFolder ? 'no-archive-folder' : null };
}
