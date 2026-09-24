// Layout selection rules, kept pure so they are testable: which device class a width is, and
// which layout to show given the saved rows from GET /api/hedwig/layouts.
import { normalise, validTree, listPanes, findNode, LAYOUT_VERSION } from './model.js';
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
  return !hasHedwigViews(tree);
}

/** Whether a tree holds any of the v2 views (the rail, a stream, the reader…). */
export function hasHedwigViews(tree) {
  if (!tree || typeof tree !== 'object') return false;
  return listPanes(tree, false).some((p) => V2_VIEW.test(p.node.id));
}

/**
 * A saved row that is really the classic MailFlow shell in panes: the pre-v2 layout kept as
 * "Classic", or an upstream preset saved under its name (folders, the classic list and reader, no
 * Hedwig view). The View menu offers the classic shell itself instead of these.
 */
export function isClassicRow(row) {
  if (!row?.tree) return false;
  return row.name === CLASSIC_NAME || !hasHedwigViews(row.tree);
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
        // `classic` names the row it came from: on a tablet the old row may be the desktop's.
        return { name: streams.label, tree: buildTemplate(DEFAULT_TEMPLATE), templateId: DEFAULT_TEMPLATE, source: 'migrate', classic: { name: CLASSIC_NAME, tree, device: d, fromId: active.id ?? null, fromName: active.name ?? null } };
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

// Rows for the layout editor: this device's saved layouts, newest first.
export function savedLayoutsFor(rows, device) {
  return rowsFor(rows, device).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

// Rows for the View menu's "Saved" section: only layouts the user made (saved under a name of their
// own in the layout editor, or imported). The rows the shell keeps under a template's name (the
// active Streams, Triage…) and the classic-shell rows are left out.
export function customLayoutsFor(rows, device) {
  return savedLayoutsFor(rows, device).filter((r) => !getTemplate(String(r.name || '').toLowerCase()) && !isClassicRow(r));
}

/**
 * The "list slot" of a layout with the rail: the pane right after the rail, unless it is the
 * reader. In Research that is Ask, so a rail click on People or the Brief shows it there (as in
 * Streams) instead of in a drawer over the reader. Null when there is no rail or no such pane.
 */
export function listSlot(tree) {
  if (!tree) return null;
  const rail = listPanes(tree).find((p) => p.visible && p.node.id === 'hedwig.rail');
  if (!rail) return null;
  const hit = findNode(tree, rail.node.key);
  const next = hit?.parent?.type === 'split' ? hit.parent.children[hit.index + 1] : null;
  return next?.type === 'view' && next.id !== 'hedwig.thread' ? next.key : null;
}
