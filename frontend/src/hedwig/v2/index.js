// Registers the v2 views (streams, Screener, thread, Brief, Hedwig today, lists and the rail) and
// their palette commands, and starts the per-session work: ui.* settings, stream counts, and the
// light/dark scheme. Imported by hedwig/views/index.js before the v1 views so the v2 commands
// win shared key sequences (g p is People the stream now; the v1 directory is still a view).
import { createElement } from 'react';
import { registerCommand, registerView, getView } from '../registry.js';
import { useHedwig } from '../store.js';
import { useStore } from '../../store/index.js';
import { useV2, watchSystemScheme, unwatchSystemScheme, watchDrafts } from './state.js';
import { showView, VIEW } from './nav.js';
import { SORT_EVENTS, REFRESH_DEBOUNCE_MS, isMockMode } from './client.js';
import StreamView from './StreamView.jsx';
import Screener from './Screener.jsx';
import Thread from './Thread.jsx';
import Brief from './Brief.jsx';
import Today from './Today.jsx';
import Rail from './Rail.jsx';
import ListView from './ListView.jsx';
import Ledger, { LEDGER_KINDS, ledgerTitle } from './Ledger.jsx';
import Waiting from './Waiting.jsx';
import Drafts from './Drafts.jsx';
import { mountUndoToasts, unmountUndoToasts } from './UndoToasts.jsx';
import { flushPending, resetActions } from './actions.js';
import { tv } from './i18n.js';

const stream = (name) => function StreamPane(p) {
  return createElement(StreamView, { ...p, props: { ...(p.props || {}), stream: name } });
};

export function v2Views() {
  return [
    { id: VIEW.rail, title: tv('hedwig.v2.view.rail', 'Hedwig rail'), icon: 'nav', group: 'mail', chrome: true, component: Rail,
      description: tv('hedwig.v2.view.railDesc', 'Streams with counts, lists, the Daily Brief and what Hedwig did today.') },
    { id: VIEW.people, title: tv('hedwig.v2.stream.people', 'People'), icon: 'people', group: 'mail', chrome: true, component: stream('people'),
      description: tv('hedwig.v2.view.peopleDesc', 'Mail from people, with what needs you on top and why.') },
    { id: VIEW.reading, title: tv('hedwig.v2.stream.reading', 'Reading'), icon: 'list', group: 'mail', chrome: true, component: stream('reading'),
      description: tv('hedwig.v2.view.readingDesc', 'Newsletters and things to read when there is time.') },
    { id: VIEW.records, title: tv('hedwig.v2.stream.records', 'Records'), icon: 'receipt', group: 'mail', chrome: true, component: stream('records'),
      description: tv('hedwig.v2.view.recordsDesc', 'Receipts, deliveries, bills and notifications, in bundles.') },
    { id: VIEW.screener, title: tv('hedwig.v2.rail.screener', 'Screener'), icon: 'filter', group: 'mail', chrome: true, component: Screener,
      description: tv('hedwig.v2.view.screenerDesc', 'New senders with a proposed stream; accept or pick another.') },
    { id: VIEW.thread, title: tv('hedwig.v2.view.thread', 'Conversation'), icon: 'thread', group: 'mail', chrome: true, component: Thread,
      hideBesideWide: true, hideTabBar: true, ownHeader: true,
      description: tv('hedwig.v2.view.threadDesc', 'The selected conversation with the story so far and a reply bar.') },
    { id: VIEW.brief, title: tv('hedwig.v2.rail.brief', 'Daily Brief'), icon: 'spark', group: 'insights', chrome: true, wide: true, component: Brief,
      description: tv('hedwig.v2.view.briefDesc', 'What needs you today, what you are waiting on, and today from your Records.') },
    { id: VIEW.today, title: tv('hedwig.v2.today.title', 'Hedwig today'), icon: 'sync', group: 'mail', chrome: true, component: Today,
      description: tv('hedwig.v2.view.todayDesc', 'Everything Hedwig decided on its own today, with undo.') },
    { id: VIEW.list, title: tv('hedwig.v2.rail.replyLater', 'Reply Later'), icon: 'inbox', group: 'mail', chrome: true, component: ListView,
      description: tv('hedwig.v2.view.listDesc', 'Reply Later, Set Aside and Snoozed.') },
    { id: VIEW.ledger, title: tv('hedwig.v2.view.ledger', 'Ledger'), icon: 'receipt', group: 'mail', chrome: true, wide: true, component: Ledger,
      description: tv('hedwig.v2.view.ledgerDesc', 'Purchases, subscriptions, travel and deliveries from your Records, with totals.') },
    { id: VIEW.waiting, title: tv('hedwig.v2.waiting.title', 'Waiting on'), icon: 'timeline', group: 'mail', chrome: true, component: Waiting,
      description: tv('hedwig.v2.view.waitingDesc', 'What you asked and have not heard back about, with Nudge.') },
    { id: VIEW.drafts, title: tv('hedwig.v2.drafts.title', 'Drafts'), icon: 'file', group: 'mail', chrome: true, component: Drafts,
      description: tv('hedwig.v2.view.draftsDesc', 'Saved drafts from every account; open one to keep writing.') },
  ];
}

function v2Commands() {
  const go = (id, props) => () => showView(id, props);
  return [
    { id: 'hedwig.v2.people', title: tv('hedwig.v2.cmd.people', 'Go to People'), keys: 'g p', run: go(VIEW.people) },
    { id: 'hedwig.v2.reading', title: tv('hedwig.v2.cmd.reading', 'Go to Reading'), keys: 'g r', run: go(VIEW.reading) },
    { id: 'hedwig.v2.records', title: tv('hedwig.v2.cmd.records', 'Go to Records'), keys: 'g c', run: go(VIEW.records) },
    { id: 'hedwig.v2.screener', title: tv('hedwig.v2.cmd.screener', 'Go to the Screener'), keys: 'g w', run: go(VIEW.screener) },
    { id: 'hedwig.v2.brief', title: tv('hedwig.v2.cmd.brief', 'Open the Daily Brief'), keys: 'g b', run: go(VIEW.brief) },
    { id: 'hedwig.v2.today', title: tv('hedwig.v2.cmd.today', 'Review what Hedwig did today'), keys: 'g h', run: go(VIEW.today) },
    { id: 'hedwig.v2.replyLater', title: tv('hedwig.v2.cmd.replyLater', 'Open Reply Later'), when: () => useV2.getState().caps.work === true, run: go(VIEW.list, { list: 'replyLater' }) },
    { id: 'hedwig.v2.drafts', title: tv('hedwig.v2.cmd.drafts', 'Drafts'), keys: 'g d', run: go(VIEW.drafts) },
    { id: 'hedwig.v2.waiting', title: tv('hedwig.v2.cmd.waiting', 'Open Waiting on'), when: () => useV2.getState().caps.work === true, run: go(VIEW.waiting) },
    ...LEDGER_KINDS.map((kind) => ({ id: `hedwig.v2.ledger.${kind}`, title: tv('hedwig.v2.cmd.ledger', 'Ledger: {{name}}', { name: ledgerTitle(kind) }), run: go(VIEW.ledger, { kind }) })),
    { id: 'hedwig.v2.power', title: tv('hedwig.v2.cmd.power', 'Power mode: on or off'), run: () => useV2.getState().togglePower() },
    { id: 'hedwig.v2.scheme.auto', title: tv('hedwig.v2.cmd.schemeAuto', 'Colour scheme: follow the system'), run: () => useV2.getState().setScheme('auto') },
    { id: 'hedwig.v2.scheme.light', title: tv('hedwig.v2.cmd.schemeLight', 'Colour scheme: light'), run: () => useV2.getState().setScheme('light') },
    { id: 'hedwig.v2.scheme.dark', title: tv('hedwig.v2.cmd.schemeDark', 'Colour scheme: dark'), run: () => useV2.getState().setScheme('dark') },
    { id: 'hedwig.v2.compose', title: tv('hedwig.v2.cmd.compose', 'Write a new message'), run: () => { const st = useStore.getState(); st.openCompose?.({ accountId: st.selectedAccountId || undefined }); } },
    { id: 'hedwig.v2.folders', title: tv('hedwig.v2.cmd.folders', 'Folders and accounts'),
      run: () => { if (window.innerWidth < 768) useStore.getState().setMobileSidebarOpen?.(true); else useHedwig.getState().openView('core.nav'); } },
    { id: 'hedwig.v2.allMail', title: tv('hedwig.v2.cmd.allMail', 'All mail (the classic list)'), run: () => useHedwig.getState().openView('core.list') },
  ];
}

let registered = false;
export function registerV2() {
  if (registered) return;
  registered = true;
  for (const v of v2Views()) if (!getView(v.id)) registerView(v);
  for (const c of v2Commands()) registerCommand({ group: 'Hedwig', ...c });
}

// ── Session ────────────────────────────────────────────────────────────────
const COUNTS_EVERY_MS = 60_000;
let countsTimer = null;
let countsListener = null;
let countsDebounce = null;
let themeUnsub = null;
let draftsUnwatch = null;
let running = false;

/**
 * Whether the v2 background work (ui.* settings, counts every minute, the scheme watch) should run:
 * only in the Hedwig shell, with Hedwig up and enabled for this user and sorting not switched off.
 * The mock answers everything, so under the mock only the shell mode matters.
 */
export function v2SessionAllowed({ userId, shellMode, status }) {
  if (!userId || shellMode !== 'hedwig') return false;
  if (isMockMode()) return true;
  return Boolean(status?.ready && status?.enabled !== false && status?.features?.sort !== false);
}

export function isV2SessionRunning() { return running; }

export function startV2Session() {
  if (running) return;
  running = true;
  const v2 = useV2.getState();
  // The undo toasts for Done, Delete, Junk and the rest (actions.js), shared by every pane.
  mountUndoToasts();
  v2.loadPrefs();
  v2.probeWork().finally(() => { if (running) useV2.getState().refreshCounts(); });
  clearInterval(countsTimer);
  countsTimer = setInterval(() => {
    if (document.hidden) return;
    useV2.getState().refreshCounts({ poll: true });
    // The Tier 2 note follows the model runtime (a degraded primary recovers after its cooldown).
    if (!isMockMode()) useHedwig.getState().refreshStatus?.();
  }, COUNTS_EVERY_MS);
  // The one place a sort change refreshes the counts; views only announce the change.
  countsListener = () => { clearTimeout(countsDebounce); countsDebounce = setTimeout(() => useV2.getState().refreshCounts(), REFRESH_DEBOUNCE_MS); };
  for (const n of SORT_EVENTS) window.addEventListener(n, countsListener);
  // Drafts: the rail's count now, then again on mail events and whenever the composer closes.
  draftsUnwatch?.();
  draftsUnwatch = watchDrafts();
  v2.refreshDrafts();
  watchSystemScheme();
  // Picking Hedwig or Hedwig Night in upstream's Appearance settings is a manual choice too:
  // the scheme follows it instead of flipping it back.
  themeUnsub = useStore.subscribe((s, prev) => {
    if (s.theme === prev.theme || (s.theme !== 'hedwig' && s.theme !== 'hedwig-night')) return;
    const { scheme } = useV2.getState();
    const want = s.theme === 'hedwig-night' ? 'dark' : 'light';
    if (scheme && scheme !== 'auto' && scheme !== want) useV2.getState().setScheme(want);
  });
}

/** Stop everything startV2Session started and forget the signed-in user's v2 state. */
export function stopV2Session() {
  if (!running) return;
  running = false;
  clearInterval(countsTimer);
  countsTimer = null;
  clearTimeout(countsDebounce);
  if (countsListener) for (const n of SORT_EVENTS) window.removeEventListener(n, countsListener);
  countsListener = null;
  draftsUnwatch?.();
  draftsUnwatch = null;
  unwatchSystemScheme();
  themeUnsub?.();
  themeUnsub = null;
  // Actions still inside their undo window go now: the owner asked for them.
  flushPending().catch(() => {}).finally(() => resetActions());
  unmountUndoToasts();
  useV2.getState().reset();
}
