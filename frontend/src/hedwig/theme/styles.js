// Shared styles for Hedwig chrome. Components use inline styles over --hw-* variables, as
// upstream does; the few things inline styles cannot express (hover, focus-visible, backdrop
// blur with its -webkit- twin, the "fill the pane" override for upstream components) live in
// one injected stylesheet. The fonts arrive through one Google Fonts link (fontFaces.js).

import { ensureHedwigFonts } from './fontFaces.js';

const STYLE_ID = 'hedwig-shell-styles';

const CSS = `
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
.hw-view-host > * { flex: 1 1 auto; min-width: 0; min-height: 0; }

/* Glass sheet: the one container in the v2 design. The blur sits on a pseudo-element, not the
   sheet itself: backdrop-filter on an element makes it the containing block for every
   position:fixed descendant, and upstream components inside a pane (context menus, pickers)
   position themselves with position:fixed and are not portaled.
   The sheet must not form a stacking context either (no isolation, no z-index, no opacity), or
   such a menu's z-index only counts inside its own pane and the next pane paints over it. So the
   glass layer has no z-index: it is the first positioned box in the sheet, and the sheet's
   children are made positioned too (z-index auto, so still no stacking context) to paint above
   it in document order. :where() keeps that rule at zero specificity, so any child that sets
   its own position (inline or by class) keeps it. */
.hw-sheet {
  border: 1px solid var(--hw-edge);
  box-shadow: 0 30px 70px -40px var(--hw-shadow-color);
}
.hw-sheet::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: var(--hw-glass);
  -webkit-backdrop-filter: blur(var(--hw-blur, 24px)) saturate(1.4);
  backdrop-filter: blur(var(--hw-blur, 24px)) saturate(1.4);
}
:where(.hw-sheet > *) { position: relative; }

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
.hw-sheet-phone { box-shadow: 0 20px 50px -30px var(--hw-shadow-color); }

.hw-btn { transition: background var(--motion-fast, 120ms) ease, border-color var(--motion-fast, 120ms) ease, color var(--motion-fast, 120ms) ease; }
.hw-btn:hover:not(:disabled) { background: var(--hw-tint) !important; }
.hw-btn:disabled { opacity: 0.5; cursor: default !important; }
.hw-btn-solid:hover:not(:disabled) { opacity: 0.88; }
.hw-btn-solid:disabled { opacity: 0.5; cursor: default !important; }
.hw-btn-quiet:hover:not(:disabled) { background: var(--hw-tint) !important; color: var(--hw-ink) !important; }
.hw-link { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--hw-line2); }
.hw-link:hover:not(:disabled) { color: var(--hw-accent-ink) !important; text-decoration-color: currentColor; }
.hw-link:disabled { opacity: 0.5; cursor: default !important; }
.hw-why-door { cursor: pointer; text-decoration: none; }
.hw-why-door:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: currentColor; text-decoration-thickness: 1px; }
.hw-row { transition: background var(--motion-fast, 120ms) ease; }
.hw-row:hover { background: var(--hw-tint); }
.hw-nav:hover { background: var(--hw-tint); }
.hw-chip:hover:not(:disabled) { border-color: var(--hw-muted) !important; }
.hw-menu-item:hover, .hw-menu-item:focus-visible { background: var(--hw-tint); outline: none; }
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
@media (prefers-reduced-motion: reduce) {
  .hw-pane[data-flash="true"] { animation: none; box-shadow: inset 0 0 0 2px var(--hw-accent); }
}
`;

export function ensureHedwigStyles() {
  if (typeof document === 'undefined') return;
  ensureHedwigFonts();
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// Style fragments reused across the shell. No pills and no uppercase eyebrows: a label is the
// italic serif in the muted ink, buttons are 9px-radius outlines, the primary one is solid ink.
export const ui = {
  label: {
    fontFamily: 'var(--hw-font-why)', fontStyle: 'italic', fontSize: 16, fontWeight: 400,
    lineHeight: 1.25, color: 'var(--hw-muted)',
  },
  why: {
    fontFamily: 'var(--hw-font-why)', fontStyle: 'italic', fontSize: 16, fontWeight: 400, lineHeight: 1.25,
  },
  mono: { fontFamily: 'var(--hw-font-mono)' },
  display: { fontFamily: 'var(--hw-font-display)', fontWeight: 400, letterSpacing: '-0.015em' },
  iconButton: {
    width: 36, height: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--hw-line2)', borderRadius: 9, background: 'transparent',
    color: 'var(--hw-ink)', cursor: 'pointer', padding: 0, flexShrink: 0,
  },
  quietIconButton: {
    width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 0, borderRadius: 6, background: 'transparent', color: 'var(--hw-muted)',
    cursor: 'pointer', padding: 0, flexShrink: 0,
  },
  button: {
    height: 36, padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: 8,
    border: '1px solid var(--hw-line2)', borderRadius: 9, background: 'transparent',
    color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  primaryButton: {
    height: 36, padding: '0 14px', display: 'inline-flex', alignItems: 'center', gap: 8,
    border: '1px solid transparent', borderRadius: 9, background: 'var(--hw-ink)', color: 'var(--hw-paper)',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  link: {
    padding: 0, border: 0, background: 'none', color: 'inherit', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
  },
  chip: (active) => ({
    fontFamily: 'inherit', padding: '0 12px', height: 32, borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: 'pointer',
    border: '1px solid transparent',
    background: active ? 'var(--hw-ink)' : 'transparent',
    color: active ? 'var(--hw-paper)' : 'var(--hw-muted)',
  }),
  card: {
    borderRadius: 0, background: 'transparent', borderTop: '1px solid var(--hw-line)',
  },
  sheet: {
    background: 'var(--hw-glass)', border: '1px solid var(--hw-edge)',
  },
};
