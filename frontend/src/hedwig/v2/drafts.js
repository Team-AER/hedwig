// Drafts for the v2 shell: find each account's Drafts folder the way upstream does (the folder
// mapping, else the \Drafts special-use folder), list what is in them across every account, tell
// a draft apart inside a thread, and reopen one in upstream's composer through the same helper
// the classic list uses (utils/composeFromMessage.js openDraftInComposer). Also the inline reply
// field's per-thread text ("reply drafts"), kept in memory and in localStorage.
import { api } from '../../utils/api.js';
import { draftsFolderFor, openDraftInComposer } from '../../utils/composeFromMessage.js';
import { useStore } from '../../store/index.js';
import { v2Api, isMockMode } from './client.js';

// Newest first, this many per account (a Drafts folder rarely holds more).
export const DRAFTS_PER_ACCOUNT = 100;

/**
 * Where drafts come from: upstream's routes, or the mock's stand-ins for them under the mock
 * (GET /mock/folders/:accountId, /mock/messages?accountId&folder, /mock/body/:id).
 */
export function draftSource() {
  if (isMockMode()) {
    return {
      getFolders: (accountId) => v2Api.get(`/mock/folders/${encodeURIComponent(accountId)}`),
      getMessages: ({ accountId, folder, limit }) => v2Api.get(`/mock/messages?${new URLSearchParams({ accountId, folder, limit: String(limit) })}`),
      getMessageBody: (id) => v2Api.get(`/mock/body/${encodeURIComponent(id)}`),
    };
  }
  return { getFolders: api.getFolders, getMessages: api.getMessages, getMessageBody: api.getMessageBody };
}

// Drafts paths found by fetching an account's folders (upstream's store had no list for it), so
// a refresh asks for the folders once per account, not every time.
const resolvedPaths = new Map();
export function resetDraftFolderCache() { resolvedPaths.clear(); }

const folderListOf = (d) => (Array.isArray(d) ? d : Array.isArray(d?.folders) ? d.folders : []);
const timeOf = (m) => { const t = Date.parse(m?.date || ''); return Number.isFinite(t) ? t : 0; };

/**
 * Every enabled account's drafts, merged newest first. `folders` is upstream's folders map
 * ({ [accountId]: [...] }); an account without a list there has its folders fetched. Returns
 * { items, folders: { [accountId]: draftsPath }, errors }: one failing account never hides
 * the others' drafts.
 */
export async function loadDrafts({ accounts = [], folders = {}, source = draftSource(), limit = DRAFTS_PER_ACCOUNT } = {}) {
  const map = {};
  const errors = [];
  const lists = await Promise.all((accounts || []).filter((a) => a?.id && a.enabled !== false).map(async (account) => {
    try {
      let path = draftsFolderFor(account, folders?.[account.id]) || resolvedPaths.get(account.id) || null;
      if (!path) path = draftsFolderFor(account, folderListOf(await source.getFolders(account.id)));
      if (!path) return [];
      resolvedPaths.set(account.id, path);
      map[account.id] = path;
      const d = await source.getMessages({ accountId: account.id, folder: path, limit });
      const rows = Array.isArray(d) ? d : Array.isArray(d?.messages) ? d.messages : [];
      return rows.map((m) => ({ ...m, account_id: m.account_id || account.id, folder: m.folder || path }));
    } catch (err) {
      errors.push(err);
      return [];
    }
  }));
  const items = lists.flat().sort((a, b) => timeOf(b) - timeOf(a));
  return { items, folders: map, errors };
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

/** The draft's first recipient as { name, email }, or null when it has none yet. */
export function draftRecipient(m) {
  const first = parseList(m?.to_addresses).find((a) => a && (a.address || a.email || a.name || typeof a === 'string'));
  if (!first) return null;
  if (typeof first === 'string') {
    const hit = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(first);
    return hit ? { name: hit[1].trim(), email: hit[2].trim() } : { name: '', email: first.trim() };
  }
  return { name: first.name || '', email: first.address || first.email || '' };
}

/** "Anna Berg", "anna@example.org", or '' for a draft with no recipient. */
export function draftRecipientName(m) {
  const r = draftRecipient(m);
  return r ? (r.name || r.email || '') : '';
}

function hasDraftFlag(m) {
  const flags = m?.flags ?? m?.raw?.flags;
  const list = Array.isArray(flags) ? flags : typeof flags === 'string' ? flags.split(/[\s,]+/) : [];
  return list.some((f) => String(f).toLowerCase() === '\\draft') || m?.is_draft === true || m?.raw?.is_draft === true;
}

/**
 * Whether a thread message is a saved draft: it carries the \Draft flag, or it sits in its
 * account's Drafts folder (resolved by loadDrafts into `draftFolders`, or from upstream's
 * folder mapping and folder list).
 */
export function isDraftMessage(m, { accounts = [], folders = {}, draftFolders = null } = {}) {
  if (!m) return false;
  if (hasDraftFlag(m)) return true;
  const folder = m.folder ?? m.raw?.folder;
  const accountId = m.accountId ?? m.account_id ?? m.raw?.account_id;
  if (!folder || !accountId) return false;
  if (draftFolders?.[accountId] && draftFolders[accountId] === folder) return true;
  const account = (accounts || []).find((a) => a.id === accountId);
  return Boolean(account) && draftsFolderFor(account, folders?.[accountId]) === folder;
}

/**
 * Reopen a draft in upstream's composer. `message` is an upstream row (a Drafts list item, or a
 * thread message's `raw`). Resolves with the composer payload; rejects when the body fails.
 */
export function openDraft(message) {
  const st = useStore.getState();
  const source = draftSource();
  return openDraftInComposer(message, {
    accounts: st.accounts || [],
    folders: st.folders || {},
    openCompose: (d) => useStore.getState().openCompose?.(d),
    getMessageBody: source.getMessageBody,
  });
}

// ── The inline reply field's text, per thread ──────────────────────────────────
export const REPLY_DRAFTS_KEY = 'hedwig_reply_drafts';
// Kept small: the newest this many threads survive a reload.
const REPLY_DRAFTS_MAX = 50;

let replyDrafts = null;

function readReplyDrafts() {
  if (replyDrafts) return replyDrafts;
  replyDrafts = {};
  try {
    const raw = JSON.parse(localStorage.getItem(REPLY_DRAFTS_KEY) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.text === 'string' && v.text.trim()) replyDrafts[k] = { text: v.text, at: Number(v.at) || 0 };
      }
    }
  } catch { /* storage unavailable or unreadable: memory only */ }
  return replyDrafts;
}

function writeReplyDrafts() {
  try {
    const keep = Object.entries(replyDrafts || {}).sort((a, b) => b[1].at - a[1].at).slice(0, REPLY_DRAFTS_MAX);
    replyDrafts = Object.fromEntries(keep);
    if (keep.length) localStorage.setItem(REPLY_DRAFTS_KEY, JSON.stringify(replyDrafts));
    else localStorage.removeItem(REPLY_DRAFTS_KEY);
  } catch { /* storage unavailable: memory only */ }
}

/** The reply text kept for a thread, or ''. */
export function getReplyDraft(threadKey) {
  if (!threadKey) return '';
  return readReplyDrafts()[threadKey]?.text || '';
}

/** Keep (or, for blank text, forget) the reply text for a thread. Returns true when kept. */
export function setReplyDraft(threadKey, text) {
  if (!threadKey) return false;
  const all = readReplyDrafts();
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) {
    if (!all[threadKey]) return false;
    delete all[threadKey];
    writeReplyDrafts();
    return false;
  }
  if (all[threadKey]?.text === value) return true;
  all[threadKey] = { text: value, at: Date.now() };
  writeReplyDrafts();
  return true;
}

export function clearReplyDraft(threadKey) { setReplyDraft(threadKey, ''); }

/** Tests: forget the in-memory copy so the next read comes from localStorage. */
export function resetReplyDraftCache() { replyDrafts = null; }
