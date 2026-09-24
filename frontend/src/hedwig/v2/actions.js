// Optimistic actions with undo (Done, Delete, Junk, Flag, Read, Snooze, Reply Later, Set Aside,
// Move). An action changes the screen at once (the row leaves the list, the counts move, the
// reader goes on to the next row), shows one toast with Undo for UNDO_MS, and runs its call in
// the background. When the call fails the row and the selection come back and the same toast
// says so, with Try again.
//
// The actions that move mail between folders (Done, Delete, Junk, Move, Snooze) wait out the
// undo window before they are sent, the way upstream's own undo does (utils/undoableAction.js):
// upstream's bulk moves give each moved row a new id and there is no route that ends a snooze,
// so Undo simply cancels a call that has not gone yet. Closing the toast, a fourth toast pushing
// it off the stack, the page going away or the session ending sends it at once. If Undo arrives
// after the call went (a race with any of those), the inverse runs instead where one exists:
// Done and Move look the messages up again by Message-ID and move them back, Delete moves them
// back from Trash (the single delete route keeps the id), Junk is Not junk (markHam). Flag, Read,
// Reply Later and Set Aside are sent at once; their Undo is the inverse call.
import { create } from 'zustand';
import { api } from '../../utils/api.js';
import { useStore } from '../../store/index.js';
import { useShell } from '../shell/state.js';
import { useV2, rowKeys, sameRow } from './state.js';
import { isMockMode, announceSortChange } from './client.js';
import { openThread, VIEW } from './nav.js';
import { archiveThread, snooze as snoozeRoute, addToList, removeFromList, flagMessage } from './mail.js';
import { isDraftMessage } from './drafts.js';
import { isMissing } from './hooks.js';
import { tv, tvn } from './i18n.js';

export const UNDO_MS = 6000;
export const MAX_TOASTS = 3;
// After a move lands its rows stay hidden this long, so the reloads it set off catch up first
// and the row never flashes back; the flag and read overlays are dropped then too.
const SETTLE_MS = 15000;

/** The toasts on screen, newest first: { id, title, tone: 'ok' | 'error', canUndo, retry, detail }. */
export const useUndo = create(() => ({ toasts: [] }));

const defaultClock = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t), now: () => Date.now() };
let clock = defaultClock;
let seq = 0;
const entries = new Map();
const patchOwner = new Map(); // messageId → the entry whose flag / read overlay it carries

// ── Messages an action works on ────────────────────────────────────────────────
const TRASH_RE = /(^|[/.])(trash|bin|deleted( items| messages)?)$/i;

/** Whether a folder is the account's Trash (the server expunges what is deleted from there). */
export function isTrashFolder(folder, accountId) {
  if (!folder) return false;
  const st = useStore.getState();
  const account = (st.accounts || []).find((a) => a.id === accountId);
  if (account?.folder_mappings?.trash === folder) return true;
  const list = st.folders?.[accountId];
  const info = (Array.isArray(list) ? list : []).find((f) => f?.path === folder);
  if (info?.special_use === '\\Trash') return true;
  return TRASH_RE.test(folder);
}

const inInbox = (m) => m.folder === undefined || m.folder === null || m.folder === 'INBOX';

/** One thread message as the actions need it (reader messages and upstream rows alike). */
export function actionMessage(m) {
  const st = useStore.getState();
  const draftCtx = { accounts: st.accounts || [], folders: st.folders || {}, draftFolders: useV2.getState().draftFolders };
  return {
    id: m.id,
    folder: m.folder ?? m.raw?.folder,
    accountId: m.accountId ?? m.account_id ?? m.raw?.account_id,
    header: m.header ?? m.message_id ?? m.raw?.message_id ?? null,
    draft: isDraftMessage(m, draftCtx),
  };
}

// Delete and Junk act on the thread's inbox copies, or on the row's own message when none is in
// the inbox; never on a draft and never on anything already in Trash (that would be permanent).
function outOfInbox(msgs, item) {
  const ok = msgs.filter((m) => !m.draft && !isTrashFolder(m.folder, m.accountId));
  const inbox = ok.filter(inInbox);
  if (inbox.length) return inbox;
  const own = ok.find((m) => m.id === item.messageId);
  return own ? [own] : [];
}

const notYet = () => new Error(tv('hedwig.v2.notYet', 'Not available yet.'));
const nothingToMove = () => new Error(tv('hedwig.v2.act.nothing', 'Nothing in this conversation can be moved from here.'));

async function oneByOne(list, fn) {
  for (const m of list) await fn(m);
}

// The calls behind the actions. Tests replace them with setActionOps.
const defaultOps = {
  async threadMessages(item) {
    if (isMockMode()) return item.messageId ? [{ id: item.messageId, folder: 'INBOX' }] : [];
    const t = item.threadId ? await api.getThread(item.threadId).catch(() => null) : null;
    const rows = Array.isArray(t?.messages) && t.messages.length ? t.messages : (item.messageId ? [{ id: item.messageId }] : []);
    return rows;
  },
  archive: (msgs) => archiveThread(msgs, { quiet: true }),
  async trash(msgs) {
    if (!isMockMode()) await oneByOne(msgs, (m) => api.deleteMessage(m.id));
    announceSortChange({ deleted: msgs.map((m) => m.id) });
  },
  async junk(msgs) {
    if (!isMockMode()) await oneByOne(msgs, (m) => api.markSpam(m.id));
    announceSortChange({ spam: msgs.map((m) => m.id) });
  },
  async unjunk(msgs) {
    if (!isMockMode()) await oneByOne(msgs, (m) => api.markHam(m.id));
    announceSortChange({ ham: msgs.map((m) => m.id) });
  },
  async move(msgs, folder) {
    if (!isMockMode()) await api.bulkMove(msgs.map((m) => m.id), folder);
    announceSortChange({ moved: msgs.map((m) => m.id), folder });
  },
  // The single delete route keeps a message's id, so it moves back from Trash by id.
  async untrash(msgs) {
    if (!isMockMode()) {
      const byFolder = new Map();
      for (const m of msgs) byFolder.set(m.folder || 'INBOX', [...(byFolder.get(m.folder || 'INBOX') || []), m.id]);
      for (const [folder, ids] of byFolder) await api.bulkMove(ids, folder);
    }
    announceSortChange({ restored: msgs.map((m) => m.id) });
  },
  // A bulk move gives the moved rows new ids: find them again in the thread by Message-ID.
  async relocateBack(moved) {
    if (!isMockMode()) {
      for (const { item, msgs } of moved) {
        if (!msgs.length) continue;
        const t = await api.getThread(item.threadId || item.messageId);
        const rows = Array.isArray(t?.messages) ? t.messages : [];
        const byFolder = new Map();
        for (const m of msgs) {
          const row = m.header ? rows.find((r) => r.message_id === m.header) : rows.find((r) => r.id === m.id);
          if (!row) throw new Error(tv('hedwig.v2.act.lost', 'Hedwig could not find the message to put it back.'));
          const home = m.folder || 'INBOX';
          if (row.folder === home) continue;
          byFolder.set(home, [...(byFolder.get(home) || []), row.id]);
        }
        for (const [folder, ids] of byFolder) await api.bulkMove(ids, folder);
      }
    }
    announceSortChange({ restored: true });
  },
  async flag(ids, on) {
    await oneByOne(ids, (id) => flagMessage(id, on));
    announceSortChange({ flagged: ids, on });
  },
  async read(ids, read) {
    if (!isMockMode()) await api.bulkRead(ids, read);
    announceSortChange({ read: ids, on: read });
  },
  snooze: (item, until) => snoozeRoute(item.messageId, until, item.threadId || item.messageId, { quiet: true }),
  addToList: (list, threadId) => addToList(list, threadId, {}, { quiet: true }),
  removeFromList: (list, threadId) => removeFromList(list, threadId),
};
let ops = defaultOps;

/** Tests: replace some of the calls (the rest stay the real ones). */
export function setActionOps(partial) { ops = { ...defaultOps, ...partial }; }
/** Tests: a fake clock ({ set, clear, now }). */
export function setUndoClock(c) { clock = { ...defaultClock, ...c }; }

async function resolveMessages(e, item) {
  const given = e.spec.messages && e.items.length === 1 ? e.spec.messages : await ops.threadMessages(item);
  return (given || []).filter((m) => m?.id).map(actionMessage).filter((m) => !m.draft);
}

async function eachItem(e, pick) {
  const out = [];
  for (const item of e.items) {
    const msgs = pick(await resolveMessages(e, item), item);
    out.push({ item, msgs });
  }
  return out;
}

// ── What each action is ────────────────────────────────────────────────────────
function whenLabel(until) {
  const d = until instanceof Date ? until : new Date(until);
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function planFor(spec, items) {
  const n = items.length;
  const threadOf = (i) => i.threadId || i.messageId;
  const messageIds = () => [...new Set([...(spec.messageIds || []), ...items.map((i) => i.messageId)].filter(Boolean))];
  switch (spec.kind) {
    case 'done':
      return {
        removes: true,
        deferred: true,
        title: n > 1 ? tvn(n, ['hedwig.v2.act.doneOne', 'Done'], ['hedwig.v2.act.doneMany', 'Done: {{n}} conversations']) : tv('hedwig.v2.act.done', 'Done'),
        failTitle: tv('hedwig.v2.act.doneFailed', 'Could not archive.'),
        async commit(e) {
          const moved = await eachItem(e, (msgs) => msgs.filter(inInbox));
          await ops.archive(moved.flatMap((x) => x.msgs));
          return moved;
        },
        inverse: (e) => ops.relocateBack(e.resolved || []),
      };
    case 'delete':
      return {
        removes: true,
        deferred: true,
        title: tv('hedwig.v2.act.deleted', 'Deleted'),
        failTitle: tv('hedwig.v2.act.deleteFailed', 'Could not delete.'),
        async commit(e) {
          const moved = await eachItem(e, outOfInbox);
          const msgs = moved.flatMap((x) => x.msgs);
          if (!msgs.length) throw nothingToMove();
          await ops.trash(msgs);
          return moved;
        },
        inverse: (e) => ops.untrash((e.resolved || []).flatMap((x) => x.msgs)),
      };
    case 'junk':
      return {
        removes: true,
        deferred: true,
        title: tv('hedwig.v2.act.junk', 'Marked as junk'),
        failTitle: tv('hedwig.v2.act.junkFailed', 'Could not mark it as junk.'),
        async commit(e) {
          const moved = await eachItem(e, outOfInbox);
          const msgs = moved.flatMap((x) => x.msgs);
          if (!msgs.length) throw nothingToMove();
          await ops.junk(msgs);
          return moved;
        },
        inverse: (e) => ops.unjunk((e.resolved || []).flatMap((x) => x.msgs)),
      };
    case 'move':
      if (!spec.folder) return null;
      return {
        removes: true,
        deferred: true,
        title: tv('hedwig.v2.act.moved', 'Moved to {{folder}}', { folder: spec.label || spec.folder }),
        failTitle: tv('hedwig.v2.act.moveFailed', 'Could not move it.'),
        async commit(e) {
          const moved = await eachItem(e, (msgs) => msgs.filter((m) => m.folder !== spec.folder && !isTrashFolder(m.folder, m.accountId)));
          const msgs = moved.flatMap((x) => x.msgs);
          if (!msgs.length) throw nothingToMove();
          await ops.move(msgs, spec.folder);
          return moved;
        },
        inverse: (e) => ops.relocateBack(e.resolved || []),
      };
    case 'snooze': {
      if (!spec.until) return null;
      const until = spec.until instanceof Date ? spec.until : new Date(spec.until);
      return {
        removes: true,
        deferred: true,
        snooze: true,
        title: tv('hedwig.v2.act.snoozed', 'Snoozed until {{when}}', { when: spec.untilLabel || whenLabel(until) }),
        failTitle: tv('hedwig.v2.act.snoozeFailed', 'Could not snooze it.'),
        async commit(e) { for (const item of e.items) await ops.snooze(item, until); },
        inverse: null, // no route ends a snooze; Undo cancels it before it is sent
      };
    }
    case 'flag': {
      const on = spec.on !== false;
      return {
        patch: { flagged: on, starred: on, is_starred: on },
        title: on ? tv('hedwig.v2.act.flagged', 'Flagged') : tv('hedwig.v2.act.unflagged', 'Flag removed'),
        failTitle: on ? tv('hedwig.v2.act.flagFailed', 'Could not flag it.') : tv('hedwig.v2.act.unflagFailed', 'Could not remove the flag.'),
        ids: messageIds,
        commit: () => ops.flag(spec.messageIds?.length ? spec.messageIds : messageIds(), on),
        inverse: () => ops.flag(spec.messageIds?.length ? spec.messageIds : messageIds(), !on),
      };
    }
    case 'read': {
      const read = spec.read !== false;
      return {
        patch: { unread: !read },
        title: read
          ? (n > 1 ? tvn(n, ['hedwig.v2.act.readOne', 'Marked as read'], ['hedwig.v2.act.readMany', 'Marked {{n}} as read']) : tv('hedwig.v2.act.read', 'Marked as read'))
          : tv('hedwig.v2.act.unread', 'Marked as unread'),
        failTitle: read ? tv('hedwig.v2.act.readFailed', 'Could not mark it read.') : tv('hedwig.v2.act.unreadFailed', 'Could not mark it unread.'),
        ids: messageIds,
        commit: () => ops.read(messageIds(), read),
        inverse: () => ops.read(messageIds(), !read),
      };
    }
    case 'replyLater':
    case 'setAside': {
      const list = spec.kind;
      return {
        listCount: list,
        title: list === 'replyLater' ? tv('hedwig.v2.act.replyLater', 'Added to Reply Later') : tv('hedwig.v2.act.setAside', 'Set aside'),
        failTitle: list === 'replyLater' ? tv('hedwig.v2.act.replyLaterFailed', 'Could not add it to Reply Later.') : tv('hedwig.v2.act.setAsideFailed', 'Could not set it aside.'),
        async commit(e) { for (const item of e.items) await ops.addToList(list, threadOf(item)); },
        async inverse(e) { for (const item of e.items) await ops.removeFromList(list, threadOf(item)); },
      };
    }
    default:
      return null;
  }
}

// ── Local changes ──────────────────────────────────────────────────────────────
/**
 * The row to show after `acted` leave the list: the next one below, else the one above, else
 * none. `order` is the list as it shows (liveRows), in display order. Pure.
 */
export function nextRow(order, acted) {
  const list = order || [];
  const gone = (it) => (acted || []).some((a) => sameRow(a, it));
  const idx = list.findIndex(gone);
  if (idx < 0) return null;
  for (let i = idx + 1; i < list.length; i++) if (!gone(list[i])) return list[i];
  for (let i = idx - 1; i >= 0; i--) if (!gone(list[i])) return list[i];
  return null;
}

// The reader follows the selection; an overlay reader (beside a wide view) follows too.
function reselect(item) {
  const overlay = useShell.getState().overlay;
  if (overlay?.id === VIEW.thread) {
    if (item) openThread(item);
    else useShell.setState({ overlay: null });
  }
  useV2.getState().select(item || null);
}

function bump(e, key, delta) {
  const v2 = useV2.getState();
  if (typeof v2.counts[key] !== 'number') return;
  v2.bumpCount(key, delta);
  e.local.counts.push([key, delta]);
}

function apply(e, { advance = true } = {}) {
  if (e.applied) return;
  e.applied = true;
  e.local = { counts: [] };
  const { plan, items, spec } = e;
  const v2 = useV2.getState();
  if (plan.removes) {
    const sel = v2.selected;
    if (advance && spec.advance !== false && sel && items.some((i) => sameRow(i, sel))) {
      const next = nextRow(v2.order?.items || [], items);
      e.local.advanced = { prev: sel, next };
      reselect(next);
    }
    e.local.hidden = items.flatMap(rowKeys);
    useV2.getState().hideRows(e.local.hidden);
    for (const item of items) {
      const stream = item.stream || spec.stream;
      if (stream === 'people' && item.needsYou) bump(e, 'people', -1);
      if ((stream === 'reading' || stream === 'records') && item.unread) bump(e, stream, -1);
    }
    if (plan.snooze) bump(e, 'snoozed', 1);
  }
  if (plan.patch) {
    const ids = plan.ids();
    e.local.patchBefore = useV2.getState().patchRows(ids, plan.patch);
    for (const id of ids) patchOwner.set(id, e.id);
  }
  if (plan.listCount) bump(e, plan.listCount, 1);
}

function unhide(e) {
  if (!e.local?.hidden) return;
  useV2.getState().showRows(e.local.hidden);
  e.local.hidden = null;
}

function revert(e) {
  if (!e.applied) return;
  e.applied = false;
  const v2 = useV2.getState();
  unhide(e);
  if (e.local.patchBefore) {
    const mine = Object.fromEntries(Object.entries(e.local.patchBefore).filter(([id]) => patchOwner.get(id) === e.id));
    v2.restorePatches(mine);
    for (const id of Object.keys(mine)) patchOwner.delete(id);
  }
  for (const [key, delta] of e.local.counts) useV2.getState().bumpCount(key, -delta);
  // Back to the conversation the action took away, unless the reader has moved on since.
  const adv = e.local.advanced;
  if (adv) {
    const cur = useV2.getState().selected;
    if (!cur || sameRow(cur, adv.next)) reselect(adv.prev);
  }
}

// Once a call has landed: the hidden rows and the overlays go after the reloads caught up.
function settleLater(e) {
  clock.set(() => {
    if (e.undone) return;
    unhide(e);
    if (e.local?.patchBefore) {
      const mine = Object.keys(e.local.patchBefore).filter((id) => patchOwner.get(id) === e.id);
      useV2.getState().restorePatches(Object.fromEntries(mine.map((id) => [id, null])));
      for (const id of mine) patchOwner.delete(id);
    }
  }, SETTLE_MS);
}

// ── Toasts ─────────────────────────────────────────────────────────────────────
function putToast(toast) {
  const rest = useUndo.getState().toasts.filter((t) => t.id !== toast.id);
  const toasts = [toast, ...rest];
  useUndo.setState({ toasts: toasts.slice(0, MAX_TOASTS) });
  // A toast pushed off the stack can no longer be undone: its call goes now.
  for (const t of toasts.slice(MAX_TOASTS)) {
    const e = entries.get(t.id);
    if (!e) continue;
    clock.clear(e.timer);
    e.timer = null;
    if (e.status === 'pending') commit(e);
  }
}

function dropToast(id) {
  useUndo.setState({ toasts: useUndo.getState().toasts.filter((t) => t.id !== id) });
}

const canUndo = (e) => Boolean(e) && !e.undone && (e.status === 'pending' || ((e.status === 'running' || e.status === 'done') && Boolean(e.plan.inverse)));

function startTimer(e, ms = UNDO_MS) {
  clock.clear(e.timer);
  e.deadline = clock.now() + ms;
  e.timer = clock.set(() => expire(e), ms);
}

function expire(e) {
  e.timer = null;
  if (e.status === 'failed') return;
  dropToast(e.id);
  if (e.status === 'pending') commit(e);
}

function errorText(err) {
  if (isMissing(err)) return notYet().message;
  return err?.message || String(err || '');
}

// ── Running ────────────────────────────────────────────────────────────────────
function commit(e) {
  if (e.status !== 'pending') return e.commitPromise;
  e.status = 'running';
  e.commitPromise = (async () => {
    try {
      e.resolved = await e.plan.commit(e);
      e.status = 'done';
      settleLater(e);
    } catch (err) {
      e.status = 'failed';
      e.error = err;
      if (e.undone) return;
      revert(e);
      clock.clear(e.timer);
      e.timer = null;
      putToast({ id: e.id, title: e.plan.failTitle, tone: 'error', canUndo: false, retry: true, detail: errorText(err) });
    }
  })();
  return e.commitPromise;
}

/**
 * Do something to one or more stream items, at once on screen, with Undo.
 * spec: { kind: 'done' | 'delete' | 'junk' | 'flag' | 'read' | 'snooze' | 'replyLater' | 'setAside' | 'move',
 *   items: stream items, stream?, messages? (the reader's thread messages, drafts included or not),
 *   messageIds? (flag / read), on? (flag), read? (read), until?, untilLabel? (snooze),
 *   folder?, label? (move), advance? (false: leave the selection alone, as on a phone), immediate?,
 *   title?, failTitle? (the toast's words instead of the action's own) }
 * Returns the action's id (for undo), or null when there is nothing to do.
 */
export function performAction(spec) {
  const items = (spec?.items || []).filter(Boolean);
  if (!items.length) return null;
  const plan = planFor(spec, items);
  if (!plan) return null;
  if (spec.title) plan.title = spec.title;
  if (spec.failTitle) plan.failTitle = spec.failTitle;
  const e = { id: `act-${++seq}`, spec, plan, items, status: 'pending', applied: false, undone: false, local: { counts: [] }, timer: null };
  entries.set(e.id, e);
  apply(e);
  putToast({ id: e.id, title: plan.title, tone: 'ok', canUndo: true, retry: false });
  startTimer(e);
  if (!plan.deferred || spec.immediate) commit(e);
  return e.id;
}

/** Undo one action (the newest undoable one when no id is given). True when it was undone. */
export function undo(id) {
  const target = id ?? useUndo.getState().toasts.find((t) => canUndo(entries.get(t.id)))?.id;
  const e = entries.get(target);
  if (!canUndo(e)) return false;
  e.undone = true;
  clock.clear(e.timer);
  e.timer = null;
  dropToast(e.id);
  revert(e);
  if (e.status === 'pending') { entries.delete(e.id); return true; }
  (async () => {
    try { await e.commitPromise; } catch { /* reported by commit */ }
    if (e.status === 'failed') { entries.delete(e.id); return; }
    try {
      await e.plan.inverse(e);
      entries.delete(e.id);
    } catch (err) {
      // The action stands on the server: show it that way again.
      apply(e, { advance: false });
      putToast({ id: e.id, title: tv('hedwig.v2.act.undoFailed', 'Could not undo.'), tone: 'error', canUndo: false, retry: false, detail: errorText(err) });
    }
  })();
  return true;
}

/** Z / ⌘Z: undo the newest action that can still be undone. */
export function undoLast() { return undo(); }

/** Try a failed action again, sent at once this time. */
export function retry(id) {
  const e = entries.get(id);
  if (!e || e.status !== 'failed') return null;
  dropToast(id);
  entries.delete(id);
  return performAction({ ...e.spec, advance: false, immediate: true });
}

/** Close a toast. A call still waiting for the undo window goes now. */
export function dismiss(id) {
  const e = entries.get(id);
  dropToast(id);
  if (!e) return;
  clock.clear(e.timer);
  e.timer = null;
  if (e.status === 'pending') commit(e);
  else if (e.status === 'failed') entries.delete(id);
}

/** Hover or focus on a toast holds its timer; leaving starts it again with the time that was left. */
export function holdToast(id) {
  const e = entries.get(id);
  if (!e?.timer) return;
  clock.clear(e.timer);
  e.timer = null;
  e.remaining = Math.max(0, (e.deadline || 0) - clock.now());
}
export function releaseToast(id) {
  const e = entries.get(id);
  if (!e || e.timer || e.remaining == null || e.status === 'failed') return;
  if (!useUndo.getState().toasts.some((t) => t.id === id)) return;
  const ms = Math.max(1000, e.remaining);
  e.remaining = null;
  startTimer(e, ms);
}

/** Send every call still waiting for its undo window (the page is going away, sign-out). */
export function flushPending() {
  const waits = [];
  for (const e of entries.values()) {
    if (e.status !== 'pending') continue;
    clock.clear(e.timer);
    e.timer = null;
    dropToast(e.id);
    waits.push(commit(e));
  }
  return Promise.all(waits);
}

/** Tests and sign-out: forget every action and toast (after flushPending when they should go). */
export function resetActions() {
  for (const e of entries.values()) clock.clear(e.timer);
  entries.clear();
  patchOwner.clear();
  useUndo.setState({ toasts: [] });
  ops = defaultOps;
  clock = defaultClock;
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { flushPending(); });
