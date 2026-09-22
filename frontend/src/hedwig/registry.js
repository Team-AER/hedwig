// Hedwig UI registry: views (things a pane can host) and commands (things the palette and keymap
// run). Core Hedwig views and plugin bundles register through the same calls, so a plugin view is
// indistinguishable from a core one. The registry is observable so the shell re-renders when a
// plugin bundle loads after first paint.
//
// View contract:
//   registerView({
//     id: 'hedwig.needs',            // unique; plugin views are '<pluginId>.<name>'
//     title: 'Needs you',
//     icon?: string,                 // name from hedwig/icons.jsx, or a React element
//     group?: 'mail'|'context'|'insights'|'agent'|'settings'|'plugins',
//     component: ({ paneId, props }) => JSX,
//     requires?: 'triage'|'context'|'insights'|'agent',   // hidden when that feature is off
//     pluginId?: string,
//     description?: string,
//   })
//
// Command contract:
//   registerCommand({
//     id: 'hedwig.ask',
//     title: 'Ask across all mail',
//     group?: 'Hedwig',
//     keys?: 'g a',                  // default binding, space-separated sequence
//     when?: () => boolean,
//     run: () => void,
//     pluginId?: string,
//   })
const views = new Map();
const commands = new Map();
const listeners = new Set();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l(version);
}

export function registerView(view) {
  if (!view?.id || !view.component) throw new Error('registerView needs id and component');
  views.set(view.id, { group: 'plugins', ...view });
  emit();
  return () => { views.delete(view.id); emit(); };
}

export function registerCommand(cmd) {
  if (!cmd?.id || typeof cmd.run !== 'function') throw new Error('registerCommand needs id and run');
  commands.set(cmd.id, { group: 'Hedwig', ...cmd });
  emit();
  return () => { commands.delete(cmd.id); emit(); };
}

export function getView(id) { return views.get(id) || null; }
export function listViews() { return [...views.values()]; }
export function listCommands() { return [...commands.values()].filter((c) => !c.when || safeWhen(c)); }
export function runCommand(id) {
  const c = commands.get(id);
  if (c && (!c.when || safeWhen(c))) { c.run(); return true; }
  return false;
}

function safeWhen(c) {
  try { return Boolean(c.when()); } catch { return false; }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registryVersion() { return version; }
