// Shell commands for the palette and the keymap: the Hedwig layouts (the upstream presets live in
// the classic shell), opening each registered view, pane focus and splitting, export, and the
// classic-shell toggle.
import { registerCommand, listViews, subscribe } from '../registry.js';
import { useHedwig } from '../store.js';
import { useShell } from './state.js';
import { HEDWIG_TEMPLATES } from './templates.js';
import { exportCurrentLayout } from './layoutFile.js';

// Default key sequences for "Open …" commands. The views register their own commands for the
// main views (g n, g a, g p, …) and those win on a duplicate sequence; these fill the gaps.
// Insights is 'g s' (here and in the views' own command): 'g i' is upstream's "go to inbox".
export const VIEW_KEYS = {
  'hedwig.insights': 'g s',
  'hedwig.layouts': 'g l',
  'hedwig.timeline': 'g t',
  'core.list': 'g m',
};

const isPhone = () => typeof window !== 'undefined' && window.innerWidth < 768;
const hedwigShell = () => useHedwig.getState().shellMode === 'hedwig';
const paneShell = () => hedwigShell() && !isPhone();

function registerShellCommands() {
  for (const t of HEDWIG_TEMPLATES) {
    registerCommand({
      id: `shell.layout.${t.id}`,
      title: `Layout: ${t.label}`,
      group: 'Layout',
      icon: 'layout',
      hint: t.description,
      when: paneShell,
      run: () => useShell.getState().applyTemplate(t.id),
    });
  }
  registerCommand({ id: 'shell.arrange', title: 'Arrange panes (show pane headers)', group: 'Layout', icon: 'arrange', when: paneShell, run: () => useShell.getState().toggleArrange() });
  registerCommand({ id: 'shell.export', title: 'Export layout as JSON', group: 'Layout', icon: 'export', when: paneShell, run: exportCurrentLayout });
  registerCommand({ id: 'shell.pane.splitRight', title: 'Split pane right', group: 'Layout', icon: 'split-right', keys: 'mod+\\', when: paneShell, run: () => useShell.getState().splitFocused('row') });
  registerCommand({ id: 'shell.pane.splitDown', title: 'Split pane down', group: 'Layout', icon: 'split-down', keys: 'mod+|', when: paneShell, run: () => useShell.getState().splitFocused('column') });
  registerCommand({ id: 'shell.pane.next', title: 'Focus next pane', group: 'Layout', icon: 'chevron-right', keys: 'g ]', when: paneShell, run: () => useShell.getState().focusNeighbour(1) });
  registerCommand({ id: 'shell.pane.prev', title: 'Focus previous pane', group: 'Layout', icon: 'chevron-left', keys: 'g [', when: paneShell, run: () => useShell.getState().focusNeighbour(-1) });
  registerCommand({
    id: 'shell.pane.close',
    title: 'Close focused pane',
    group: 'Layout',
    icon: 'close',
    when: () => paneShell() && Boolean(useShell.getState().focused),
    run: () => { const k = useShell.getState().focused; if (k) useShell.getState().closePane(k); },
  });
  registerCommand({
    id: 'shell.pane.popout',
    title: 'Pop focused pane out to a window',
    group: 'Layout',
    icon: 'popout',
    when: () => paneShell() && Boolean(useShell.getState().focused),
    run: () => { const k = useShell.getState().focused; if (k) useShell.getState().popOut(k); },
  });
  registerCommand({ id: 'shell.classic', title: 'Switch to the classic MailFlow shell', group: 'Layout', icon: 'classic', when: hedwigShell, run: () => useHedwig.getState().setShellMode('classic') });
  registerCommand({ id: 'shell.hedwig', title: 'Switch to the Hedwig layout', group: 'Layout', icon: 'owl', when: () => !hedwigShell(), run: () => useHedwig.getState().setShellMode('hedwig') });
}

// One "Open …" command per registered view, kept in step with the registry as plugins load.
const openCommands = new Map();
function syncOpenCommands() {
  const present = new Set();
  for (const v of listViews()) {
    if (v.hidden) continue;
    present.add(v.id);
    if (openCommands.has(v.id)) continue;
    openCommands.set(v.id, registerCommand({
      id: `shell.open.${v.id}`,
      title: `Open ${v.title || v.id}`,
      group: 'Open view',
      icon: v.icon || 'grid',
      viewId: v.id,
      keys: VIEW_KEYS[v.id],
      when: hedwigShell,
      run: () => useHedwig.getState().openView(v.id),
    }));
  }
  for (const [id, unregister] of openCommands) {
    if (!present.has(id)) { openCommands.delete(id); unregister(); }
  }
}

let installed = false;
export function installShellCommands() {
  if (installed) return;
  installed = true;
  registerShellCommands();
  syncOpenCommands();
  let syncing = false;
  subscribe(() => {
    if (syncing) return;
    syncing = true;
    try { syncOpenCommands(); } finally { syncing = false; }
  });
}
