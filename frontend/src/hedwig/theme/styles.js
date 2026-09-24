// Shared styles for Hedwig chrome. Components use inline styles over --hw-* variables, as
// upstream does; the few things inline styles cannot express (hover, focus-visible, backdrop
// blur with its -webkit- twin, the "fill the pane" override for upstream components) live in
// one injected stylesheet. Type is the system stack; the optional Instrument set loads its Google
// Fonts link only while it is the effective set (fontFaces.js).
//
// Materials (DESIGN-AUDIT-2026-09-24 §e): glass for navigation (the rail), opaque content for
// everything that holds mail, a thin frosted bar for toolbars and phone bars. A sheet picks one
// with data-material; a bare .hw-sheet is glass, as before.

import { watchHedwigFonts } from './fontFaces.js';

const STYLE_ID = 'hedwig-shell-styles';

const CSS = `
/* Native controls (checkboxes, selects, scrollbars, date pickers) follow the Hedwig scheme
   instead of painting light boxes on the night palette. Mail bodies set their own. */
:root[data-mailflow-theme="hedwig"] { color-scheme: light; }
:root[data-mailflow-theme="hedwig-night"] { color-scheme: dark; }

/* Upstream components size themselves for the classic shell (fixed sidebar width, the
   --list-width variable, a 42% list height in vertical mode). Inside a pane they fill it. */
.hw-fill > * {
  flex: 1 1 auto !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: none !important;
  height: 100% !important;
  min-height: 0 !important;
}
/* ...and sit on the pane's sheet in its palette: the component's own root paints no slab and no
   edge border (the sheet has one), hovers take the hover fill, borders become hairlines. Popovers and dialogs inside keep their opaque --bg-secondary / --bg-elevated.
   .hw-upstream is the same palette for an upstream surface that keeps its own ground (the
   phone's folder drawer, which floats over the streams). */
.hw-fill, .hw-upstream {
  --bg-primary: var(--hw-surface);
  --bg-tertiary: var(--hw-field);
  --bg-hover: var(--hw-hover);
  --border: var(--hw-line2);
  --border-subtle: var(--hw-line);
  --text-primary: var(--hw-ink);
  --text-secondary: var(--hw-muted);
  --accent: var(--hw-accent);
  font-family: var(--hw-font-body);
  color: var(--hw-ink);
}
.hw-fill > * {
  background: transparent !important;
  border-right: 0 !important;
  border-bottom: 0 !important;
}
.hw-fill *, .hw-upstream * { scrollbar-width: thin; scrollbar-color: var(--hw-line2) transparent; }
.hw-view-host > * { flex: 1 1 auto; min-width: 0; min-height: 0; }

/* Sheets. The blur sits on a pseudo-element, not the sheet itself: backdrop-filter on an element
   makes it the containing block for every position:fixed descendant, and upstream components
   inside a pane (context menus, pickers) position themselves with position:fixed and are not
   portaled.
   The sheet must not form a stacking context either (no isolation, no z-index, no opacity), or
   such a menu's z-index only counts inside its own pane and the next pane paints over it. So the
   glass layer has no z-index: it is the first positioned box in the sheet, and the sheet's
   children are made positioned too (z-index auto, so still no stacking context) to paint above
   it in document order. :where() keeps that rule at zero specificity, so any child that sets
   its own position (inline or by class) keeps it.
   Glass (the default and data-material="glass"): the rail. A light inner edge plus a .5px dark
   hairline outside it, and the sheet shadow. */
.hw-sheet {
  border: 1px solid var(--hw-edge);
  box-shadow: 0 0 0 .5px var(--hw-edge-outer, rgba(0,0,0,.12)), var(--hw-shadow-sheet, 0 8px 24px -12px rgba(0,0,0,.18));
}
.hw-sheet::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: var(--hw-glass);
  -webkit-backdrop-filter: blur(var(--hw-blur, 30px)) saturate(1.8);
  backdrop-filter: blur(var(--hw-blur, 30px)) saturate(1.8);
}
:where(.hw-sheet > *) { position: relative; }
/* Content: opaque paper for the list, the reader and every other pane. No blur at all. */
.hw-sheet[data-material="content"] {
  border: 0;
  background: var(--hw-content);
  box-shadow: 0 0 0 .5px var(--hw-edge-outer, rgba(0,0,0,.12)), var(--hw-shadow-sheet, 0 8px 24px -12px rgba(0,0,0,.18));
}
.hw-sheet[data-material="content"]::before { content: none; }
/* Bar: the thin overlay glass for a toolbar the content scrolls under, and the phone's top and
   bottom bars. No edge and no shadow; the component draws its own hairline. */
.hw-sheet[data-material="bar"] { border: 0; box-shadow: none; }
.hw-sheet[data-material="bar"]::before {
  background: var(--hw-bar);
  -webkit-backdrop-filter: blur(calc(var(--hw-blur, 30px) * 2 / 3)) saturate(1.6);
  backdrop-filter: blur(calc(var(--hw-blur, 30px) * 2 / 3)) saturate(1.6);
}
/* Popovers and menus: content material with the popover shadow. */
.hw-sheet[data-material="content"][data-popover] { box-shadow: 0 0 0 .5px var(--hw-edge-outer, rgba(0,0,0,.12)), var(--hw-shadow-pop, 0 12px 32px -8px rgba(0,0,0,.28)); }

/* A 44×44 touch target around a small text control, without changing how it looks. */
.hw-hit { position: relative; }
.hw-hit::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: max(100%, 44px);
  height: max(100%, 44px);
  transform: translate(-50%, -50%);
}

/* The quiet "why" on a stream row that shows no reason line: there on hover and keyboard focus. */
.hw-row-why { opacity: 0; transition: opacity var(--motion-fast, 120ms) ease; }
.hw-row:hover .hw-row-why, .hw-row:focus-within .hw-row-why, .hw-row-why:focus-visible { opacity: 1; }
.hw-sheet-phone:not([data-material="bar"]) { box-shadow: 0 0 0 .5px var(--hw-edge-outer, rgba(0,0,0,.12)), var(--hw-shadow-pop, 0 12px 32px -8px rgba(0,0,0,.28)); }

.hw-btn { transition: background var(--motion-fast, 120ms) ease, border-color var(--motion-fast, 120ms) ease, color var(--motion-fast, 120ms) ease; }
.hw-btn:hover:not(:disabled) { background: var(--hw-hover) !important; }
.hw-btn:disabled { opacity: 0.5; cursor: default !important; }
.hw-btn-solid:hover:not(:disabled) { opacity: 0.88; }
.hw-btn-solid:disabled { opacity: 0.5; cursor: default !important; }
.hw-btn-quiet:hover:not(:disabled) { background: var(--hw-hover) !important; color: var(--hw-ink) !important; }
/* IconButton (primitives.jsx): 28×28, radius 6. Hover takes the hover fill; a toggled one the
   neutral selected fill with the glyph in the accent. */
.hw-icon-btn { transition: background var(--motion-fast, 120ms) ease, color var(--motion-fast, 120ms) ease; }
.hw-icon-btn:hover:not(:disabled):not([data-primary]) { background: var(--hw-hover); }
.hw-icon-btn[aria-pressed="true"]:not([data-primary]) { background: var(--hw-select); color: var(--hw-accent); }
.hw-icon-btn[data-primary]:hover:not(:disabled) { opacity: 0.9; }
.hw-icon-btn:disabled { opacity: 0.4; cursor: default !important; }
.hw-link { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--hw-line2); }
.hw-link:hover:not(:disabled) { color: var(--hw-accent-ink) !important; text-decoration-color: currentColor; }
.hw-link:disabled { opacity: 0.5; cursor: default !important; }
.hw-why-door { cursor: pointer; text-decoration: none; }
.hw-why-door:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: currentColor; text-decoration-thickness: 1px; }
.hw-row { transition: background var(--motion-fast, 120ms) ease; }
.hw-row:hover { background: var(--hw-hover); }
.hw-row[aria-selected="true"], .hw-row[data-selected="true"] { background: var(--hw-accent-tint); }
.hw-row:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
.hw-nav:hover { background: var(--hw-hover); }
.hw-nav[aria-current="page"], .hw-nav[data-selected="true"] { background: var(--hw-select); }
.hw-chip:hover:not(:disabled) { border-color: var(--hw-muted) !important; }
.hw-menu-item:hover, .hw-menu-item:focus-visible { background: var(--hw-hover); outline: none; }
.hw-menu-item[aria-disabled="true"] { opacity: 0.5; }
.hw-splitter > span:first-child { transition: background var(--motion-fast, 120ms) ease; }
.hw-splitter:hover > span:first-child, .hw-splitter:focus-visible > span:first-child, .hw-splitter[data-dragging="true"] > span:first-child { background: var(--hw-line2) !important; }
.hw-splitter:focus-visible { outline: none; }
.hw-pane:focus { outline: none; }
.hw-pane[data-flash="true"] { animation: hw-pane-flash 700ms var(--ease-standard, ease) 1; }
.hw-v2 button:focus-visible, .hw-v2 a:focus-visible, .hw-v2 input:focus-visible, .hw-v2 [tabindex]:focus-visible,
.hw-sheet button:focus-visible, .hw-sheet a:focus-visible {
  outline: 2px solid var(--hw-accent); outline-offset: 2px;
}
.hw-v2 input::placeholder { color: var(--hw-muted); opacity: 1; }
.hw-scroll { scrollbar-width: thin; scrollbar-color: var(--hw-line2) transparent; }
@keyframes hw-pane-flash {
  0% { box-shadow: inset 0 0 0 2px var(--hw-accent); }
  100% { box-shadow: inset 0 0 0 2px transparent; }
}
@keyframes hw-drawer-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes hw-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes hw-pop-in {
  from { transform: translateY(-4px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
/* "Regenerate summary": the sparkles turn slowly while the rewrite runs; the new text fades in. */
.hw-regen { transition: background var(--motion-fast, 120ms) ease; }
.hw-regen:hover:not([aria-busy="true"]) { background: var(--hw-hover); }
.hw-spin { display: inline-flex; animation: hw-spin 1.2s linear infinite; }
.hw-regen-new { animation: hw-fade-in 240ms var(--ease-standard, ease) 1; }
@keyframes hw-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .hw-pane[data-flash="true"] { animation: none; box-shadow: inset 0 0 0 2px var(--hw-accent); }
  .hw-spin { animation: none; opacity: 0.5; }
  .hw-regen-new { animation: none; }
}
/* Reduce transparency: glass becomes opaque (#F5F5F7 / #262628), bars take the content fill. */
@media (prefers-reduced-transparency: reduce) {
  .hw-sheet::before {
    background: var(--hw-glass-solid, var(--hw-content));
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .hw-sheet[data-material="bar"]::before { background: var(--hw-content); }
  .hw-glow { display: none; }
}
/* Increase contrast: hairlines at .20, muted text at 80% ink. The theme block is a plain :root
   rule, so these (carrying the theme attribute) win whatever the source order. */
@media (prefers-contrast: more) {
  :root[data-mailflow-theme="hedwig"] {
    --hw-line: rgba(0,0,0,0.20); --hw-line2: rgba(0,0,0,0.32); --hw-edge-outer: rgba(0,0,0,0.30);
    --hw-muted: color-mix(in srgb, var(--hw-ink) 80%, transparent);
  }
  :root[data-mailflow-theme="hedwig-night"] {
    --hw-line: rgba(255,255,255,0.20); --hw-line2: rgba(255,255,255,0.32);
    --hw-muted: color-mix(in srgb, var(--hw-ink) 80%, transparent);
  }
}
`;

export function ensureHedwigStyles() {
  if (typeof document === 'undefined') return;
  watchHedwigFonts();
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// Style fragments reused across the shell. No pills, no uppercase eyebrows, no italic: a label is
// 11px/600 muted sans in sentence case, titles are the body face at 600, buttons are 28px with a
// radius of 8 (6 for icon buttons), the primary one is the blue accent.
export const ui = {
  label: {
    fontFamily: 'var(--hw-font-body)', fontStyle: 'normal', fontSize: 11, fontWeight: 600,
    lineHeight: '14px', color: 'var(--hw-muted)',
  },
  why: {
    fontFamily: 'var(--hw-font-body)', fontStyle: 'normal', fontSize: 12, fontWeight: 400, lineHeight: 1.35,
  },
  mono: { fontFamily: 'var(--hw-font-mono)' },
  num: { fontFamily: 'var(--hw-font-body)', fontVariantNumeric: 'tabular-nums' },
  display: { fontFamily: 'var(--hw-font-body)', fontWeight: 600, letterSpacing: '-0.01em' },
  iconButton: {
    width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 0, borderRadius: 6, background: 'transparent',
    color: 'var(--hw-ink)', cursor: 'pointer', padding: 0, flexShrink: 0,
  },
  quietIconButton: {
    width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 0, borderRadius: 6, background: 'transparent', color: 'var(--hw-muted)',
    cursor: 'pointer', padding: 0, flexShrink: 0,
  },
  button: {
    height: 28, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 6,
    border: '1px solid var(--hw-line2)', borderRadius: 8, background: 'transparent',
    color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  primaryButton: {
    height: 28, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
    border: '1px solid transparent', borderRadius: 8, background: 'var(--hw-accent)', color: 'var(--hw-on-accent)',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  link: {
    padding: 0, border: 0, background: 'none', color: 'var(--hw-accent-ink)', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
  },
  chip: (active) => ({
    fontFamily: 'inherit', padding: '0 10px', height: 28, borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer',
    border: '1px solid transparent',
    background: active ? 'var(--hw-select)' : 'transparent',
    color: active ? 'var(--hw-ink)' : 'var(--hw-muted)',
  }),
  card: {
    borderRadius: 0, background: 'transparent', borderTop: '1px solid var(--hw-line)',
  },
  sheet: {
    background: 'var(--hw-content)', boxShadow: '0 0 0 .5px var(--hw-edge-outer)',
  },
};
