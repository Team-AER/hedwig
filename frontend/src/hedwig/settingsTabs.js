// Hedwig's settings pages live in the Settings dialog's sidebar (AdminPanel, group "Hedwig"), next to
// the mail settings, instead of in a pane of their own. Every way of opening one (the rail's Settings,
// the command palette, links inside Hedwig) goes through useHedwig.openView, which sends these view
// ids to the dialog (store.js). Pure so node --test can pin it.

export const HEDWIG_SETTINGS_TABS = [
  { id: 'hedwig-personal', viewId: 'hedwig.settings.personal', labelKey: 'hedwig.settingsTabs.personal', icon: 'user' },
  { id: 'hedwig-triage', viewId: 'hedwig.settings.triage', labelKey: 'hedwig.settingsTabs.triage', icon: 'filter' },
  { id: 'hedwig-plugins', viewId: 'hedwig.settings.plugins', labelKey: 'hedwig.settingsTabs.plugins', icon: 'plug' },
  { id: 'hedwig-routing', viewId: 'hedwig.settings.routing', labelKey: 'hedwig.settingsTabs.routing', icon: 'sparkles', adminOnly: true },
  { id: 'hedwig-pipeline', viewId: 'hedwig.settings.models', labelKey: 'hedwig.settingsTabs.pipeline', icon: 'bolt', adminOnly: true },
];

/** The dialog tab for a Hedwig settings view id, or null for any other view. */
export function settingsTabFor(viewId) {
  return HEDWIG_SETTINGS_TABS.find((t) => t.viewId === viewId)?.id || null;
}

/** The view id a dialog tab shows, or null when the tab is not one of Hedwig's. */
export function settingsViewFor(tabId) {
  return HEDWIG_SETTINGS_TABS.find((t) => t.id === tabId)?.viewId || null;
}
