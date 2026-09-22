// Layout selection rules, kept pure so they are testable: which device class a width is, and
// which layout to show given the saved rows from GET /api/hedwig/layouts.
import { normalise, validTree } from './model.js';
import { buildTemplate, getTemplate, DEFAULT_TEMPLATE } from './templates.js';

export const PHONE_MAX = 768;
export const TABLET_MAX = 1100;

export function deviceClass(width) {
  if (width < PHONE_MAX) return 'phone';
  if (width < TABLET_MAX) return 'tablet';
  return 'desktop';
}

// Saved rows usable on this device: its own, then desktop's as a fallback for tablets.
function rowsFor(rows, device) {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((r) => r && r.device === device);
}

// { name, tree, templateId, source } for the layout to show.
//   1. the active saved layout for this device
//   2. on a tablet, the active desktop layout
//   3. the template named by status.ui.defaultTemplate
export function pickLayout(rows, device, defaultTemplate) {
  const candidates = device === 'tablet' ? [device, 'desktop'] : [device];
  for (const d of candidates) {
    const active = rowsFor(rows, d).find((r) => r.is_active);
    const tree = active && normalise(active.tree);
    if (tree && validTree(tree)) {
      return { name: active.name, tree, templateId: templateIdForName(active.name), source: 'saved' };
    }
  }
  const id = getTemplate(defaultTemplate) ? defaultTemplate : DEFAULT_TEMPLATE;
  return { name: getTemplate(id).label, tree: buildTemplate(id), templateId: id, source: 'template' };
}

// A layout saved under a template's label ("Triage") is that template, customised.
export function templateIdForName(name) {
  const t = getTemplate(String(name || '').toLowerCase());
  return t ? t.id : null;
}

// Rows for the layout switcher: this device's saved layouts, newest first.
export function savedLayoutsFor(rows, device) {
  return rowsFor(rows, device).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
