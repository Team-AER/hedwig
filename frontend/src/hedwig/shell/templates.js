// Layout templates. 'streams' (the v2 default: rail · People · thread), 'triage' and 'research'
// are Hedwig's; the rest reproduce upstream's
// presets from frontend/src/layouts.js as pane trees (nav · list · thread), so a MailFlow user
// finds the arrangement they know. Each preset template names its upstream preset so applying
// it also sets upstream's `layout` (row padding, list density, the list's own layout menu).
import { LAYOUTS } from '../../layouts.js';
import { view, split, normalise } from './model.js';

export const NAV_WIDTH = 220;
export const RAIL_WIDTH = 224;
export const STREAM_WIDTH = 470;

function preset(key) {
  const p = LAYOUTS[key];
  const list = view('core.list');
  const thread = view('core.thread');
  const body = p.direction === 'column'
    ? split('column', [list, thread], [null, null])
    : null;
  return body
    ? split('row', [view('core.nav'), body], [NAV_WIDTH, null])
    : split('row', [view('core.nav'), list, thread], [NAV_WIDTH, p.listWidth, null]);
}

export const TEMPLATES = [
  {
    id: 'streams',
    label: 'Streams',
    note: 'rail · people · thread',
    build: () => split('row', [
      view('hedwig.rail'),
      view('hedwig.stream.people'),
      view('hedwig.thread'),
    ], [RAIL_WIDTH, STREAM_WIDTH, null]),
  },
  {
    id: 'triage',
    label: 'Triage',
    note: 'needs you · thread · context',
    build: () => split('row', [
      view('core.nav'),
      view('hedwig.needs'),
      view('core.thread'),
      view('hedwig.context', { follows: 'core.thread' }),
    ], [NAV_WIDTH, 420, null, 320]),
  },
  {
    id: 'research',
    label: 'Research',
    note: 'ask · timeline',
    build: () => split('row', [view('hedwig.ask'), view('hedwig.timeline')], [640, null]),
  },
  ...['focused', 'compact', 'comfortable', 'wide', 'vertical'].map((key) => ({
    id: key,
    label: key === 'vertical' ? 'Vertical' : LAYOUTS[key].label,
    note: LAYOUTS[key].direction === 'column' ? 'upstream · list above' : `upstream · ${LAYOUTS[key].listWidth}px list`,
    upstreamLayout: key,
    build: () => preset(key),
  })),
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);
export const DEFAULT_TEMPLATE = 'streams';

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

// A fresh, normalised tree for a template id (falls back to the default template).
export function buildTemplate(id) {
  const t = getTemplate(id) || getTemplate(DEFAULT_TEMPLATE);
  return normalise(t.build());
}
