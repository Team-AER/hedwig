// Moving between v2 views. On desktop the rail swaps the view in the list pane and a stream row
// fills the thread pane; on a phone both push onto the tab's stack. Views never touch the shell
// directly for anything else.
import { useHedwig } from '../store.js';
import { useShell } from '../shell/state.js';
import * as M from '../shell/model.js';
import { useV2 } from './state.js';

export const VIEW = {
  rail: 'hedwig.rail',
  people: 'hedwig.stream.people',
  reading: 'hedwig.stream.reading',
  records: 'hedwig.stream.records',
  screener: 'hedwig.screener',
  thread: 'hedwig.thread',
  brief: 'hedwig.brief',
  today: 'hedwig.today',
  list: 'hedwig.list',
};

// Views that live in the "list" pane of the streams layout; the rail swaps between them.
export const MAIN_VIEWS = [VIEW.people, VIEW.reading, VIEW.records, VIEW.screener, VIEW.brief, VIEW.today, VIEW.list];

const isPhone = () => typeof window !== 'undefined' && window.innerWidth < 768;

/** The pane key hosting one of the main views, or null. */
export function mainPaneKey(tree = useShell.getState().tree) {
  if (!tree) return null;
  for (const p of M.listPanes(tree, false)) {
    if (p.node.type === 'view' && MAIN_VIEWS.includes(p.node.id)) return p.node.key;
  }
  return null;
}

/** The main view on screen (for the rail's current item). */
export function currentMainView(tree) {
  if (!tree) return null;
  for (const p of M.listPanes(tree, false)) {
    if (p.node.type === 'view' && MAIN_VIEWS.includes(p.node.id)) return { id: p.node.id, props: p.node.props || {} };
  }
  return null;
}

export function showView(viewId, props) {
  if (isPhone()) { useHedwig.getState().openView(viewId, props || {}); return; }
  const shell = useShell.getState();
  const key = mainPaneKey(shell.tree);
  if (key) {
    shell.replaceView(key, viewId, props && Object.keys(props).length ? props : undefined);
    return;
  }
  useHedwig.getState().openView(viewId, props || {});
}

/** Open a stream item's thread: the thread pane on desktop, a pushed screen on a phone. */
export function openThread(item) {
  if (!item) return;
  useV2.getState().select(item);
  if (isPhone()) { useHedwig.getState().openView(VIEW.thread, { item }); return; }
  const tree = useShell.getState().tree;
  if (!tree || !M.panesHosting(tree, VIEW.thread).length) useHedwig.getState().openView(VIEW.thread, { item });
}
