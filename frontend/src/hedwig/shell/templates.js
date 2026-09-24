// Layout templates. The three Hedwig layouts ('streams', the v2 default: rail · list · reader;
// 'triage': the People stream beside the reader and the person's context; 'research': Ask beside
// the reader) are what the View menu offers. Every one keeps the rail, so the way to the other
// places, the View menu and settings is always on screen.
// The upstream presets (focused, compact, comfortable, wide, vertical) are upstream's classic list
// densities as pane trees (nav · list · thread). They are not offered in the Hedwig shell any more
// (the classic shell keeps them in its own list menu), but they still build, so a layout row saved
// under one of their names, or upstream's own layout menu while such a row is on screen, loads.
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

export const CONTEXT_WIDTH = 280;
export const TRIAGE_LIST_WIDTH = 340;
export const ASK_WIDTH = 520;

export const TEMPLATES = [
  {
    id: 'streams',
    label: 'Streams',
    description: 'Rail · list · reader. The default.',
    note: 'rail · list · reader',
    build: () => split('row', [
      view('hedwig.rail'),
      view('hedwig.stream.people'),
      view('hedwig.thread'),
    ], [RAIL_WIDTH, STREAM_WIDTH, null]),
  },
  {
    id: 'triage',
    label: 'Triage',
    description: 'Needs you first, with the person’s context beside the reader.',
    note: 'rail · people · reader · context',
    build: () => split('row', [
      view('hedwig.rail'),
      view('hedwig.stream.people'),
      view('hedwig.thread'),
      view('hedwig.context', { follows: 'hedwig.thread' }),
    ], [RAIL_WIDTH, TRIAGE_LIST_WIDTH, null, CONTEXT_WIDTH]),
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Ask across all mail beside the reader.',
    note: 'rail · ask · reader',
    build: () => split('row', [
      view('hedwig.rail'),
      view('hedwig.ask'),
      view('hedwig.thread'),
    ], [RAIL_WIDTH, ASK_WIDTH, null]),
  },
  ...['focused', 'compact', 'comfortable', 'wide', 'vertical'].map((key) => ({
    id: key,
    label: key === 'vertical' ? 'Vertical' : LAYOUTS[key].label,
    note: LAYOUTS[key].direction === 'column' ? 'upstream · list above' : `upstream · ${LAYOUTS[key].listWidth}px list`,
    upstreamLayout: key,
    build: () => preset(key),
  })),
];

/** The layouts the View menu, the palette and the layout editor offer (no upstream presets). */
export const HEDWIG_TEMPLATES = TEMPLATES.filter((t) => !t.upstreamLayout);

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
