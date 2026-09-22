// React bindings for the Hedwig registry: re-render when views or commands register, which
// happens after first paint when a plugin bundle loads.
import { useSyncExternalStore } from 'react';
import { subscribe, registryVersion, listViews } from '../registry.js';

export function useRegistryVersion() {
  return useSyncExternalStore(subscribe, registryVersion, registryVersion);
}

export const GROUP_LABELS = {
  mail: 'Mail',
  context: 'Context',
  insights: 'Insights',
  agent: 'Agent',
  settings: 'Settings',
  plugins: 'Plugins',
};
const GROUP_ORDER = Object.keys(GROUP_LABELS);

// Views a person can choose for a pane, grouped for menus. Hidden helper views are left out.
export function groupedViews() {
  const groups = new Map();
  for (const v of listViews()) {
    if (v.hidden) continue;
    const g = GROUP_LABELS[v.group] ? v.group : 'plugins';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(v);
  }
  return [...groups.entries()]
    .sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]))
    .map(([group, views]) => ({ group, label: GROUP_LABELS[group], views: views.sort((a, b) => String(a.title).localeCompare(String(b.title))) }));
}

export function viewTitle(view, id) {
  return view?.title || id;
}
