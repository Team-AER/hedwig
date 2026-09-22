// Boots the Hedwig UI. Imported once from main.jsx, before first paint: registers the core pane
// views (upstream's sidebar, list, reading pane, contacts), the layout editor, every Hedwig view
// (views/index.js) and the shell's commands. Work that needs a signed-in user — Hedwig status
// and plugin bundles — starts from <HedwigRuntime/>, which MailApp mounts.
import { useEffect } from 'react';
import { registerView, getView } from './registry.js';
import { useHedwig } from './store.js';
import { useStore } from '../store/index.js';
import { registerCoreViews } from './shell/coreViews.jsx';
import LayoutEditor from './shell/LayoutEditor.jsx';
import './views/index.js';
import { installShellCommands } from './shell/commands.js';
import { useShell } from './shell/state.js';
import { ensureHedwigStyles } from './theme/styles.js';
import { initPluginRuntime } from '../plugins/runtimeLoader.js';

const PLUGIN_SETTLE_MS = 3000;

registerCoreViews();
if (!getView('hedwig.layouts')) {
  registerView({
    id: 'hedwig.layouts',
    title: 'Layouts',
    icon: 'layout',
    group: 'settings',
    component: LayoutEditor,
    description: 'Templates, the pane tree, density and saved layouts per device.',
  });
}
installShellCommands();
ensureHedwigStyles();

let sessionUser;
function startSession(userId) {
  if (sessionUser === userId) return;
  sessionUser = userId;
  useHedwig.getState().loadStatus();
  useShell.setState({ pluginsSettled: false });
  // Views from plugin bundles appear once their bundle loads; until then (or a few seconds, if a
  // bundle hangs) a pane waiting for one stays blank instead of saying "not available".
  const settle = () => useShell.setState({ pluginsSettled: true });
  const timer = setTimeout(settle, PLUGIN_SETTLE_MS);
  Promise.resolve()
    .then(() => initPluginRuntime())
    .catch((err) => console.warn('[hedwig] plugin runtime failed to start:', err?.message || err))
    .finally(() => { clearTimeout(timer); settle(); });
}

export function HedwigRuntime() {
  const userId = useStore((s) => s.user?.id);
  useEffect(() => { if (userId) startSession(userId); }, [userId]);
  return null;
}

