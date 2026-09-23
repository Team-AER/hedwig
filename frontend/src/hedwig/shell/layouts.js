// Layout selection rules, kept pure so they are testable: which device class a width is, and
// which layout to show given the saved rows from GET /api/hedwig/layouts.
import { normalise, validTree, listPanes, LAYOUT_VERSION } from './model.js';
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

// The name a pre-v2 layout is kept under when its owner is moved to the streams template.
export const CLASSIC_NAME = 'Classic';
const V2_VIEW = /^hedwig\.(rail|stream\.|screener$|thread$|brief$|today$|list$|ledger$|waiting$)/;

/**
 * A layout saved before v2: no version stamp and none of the v2 views (so it shows the upstream
 * folder sidebar and list rather than the rail and streams). Any tree the v2 shell has shown
 * carries the stamp, so a layout the user picks afterwards (Classic included) is never moved again.
 */
export function isPreV2Layout(tree) {
  if (!tree || typeof tree !== 'object') return false;
  if (Number.isInteger(tree.version) && tree.version >= LAYOUT_VERSION) return false;
  return !listPanes(tree, false).some((p) => V2_VIEW.test(p.node.id));
}

// { name, tree, templateId, source, classic? } for the layout to show.
//   1. the active saved layout for this device
//   2. on a tablet, the active desktop layout
//   3. the template named by status.ui.defaultTemplate
// An active layout from before v2 is not shown: the user lands on the streams template once, and
// `classic` carries the old tree so the shell can keep it in the layout menu as "Classic".
export function pickLayout(rows, device, defaultTemplate) {
  const candidates = device === 'tablet' ? [device, 'desktop'] : [device];
  for (const d of candidates) {
    const active = rowsFor(rows, d).find((r) => r.is_active);
    const tree = active && normalise(active.tree);
    if (tree && validTree(tree)) {
      if (isPreV2Layout(tree)) {
        const streams = getTemplate(DEFAULT_TEMPLATE);
        return { name: streams.label, tree: buildTemplate(DEFAULT_TEMPLATE), templateId: DEFAULT_TEMPLATE, source: 'migrate', classic: { name: CLASSIC_NAME, tree } };
      }
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
