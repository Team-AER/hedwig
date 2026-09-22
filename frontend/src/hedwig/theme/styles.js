// Shared styles for Hedwig chrome. Components use inline styles over --hw-* variables, as
// upstream does; the few things inline styles cannot express (hover, focus-visible, the
// "fill the pane" override for upstream components) live in one injected stylesheet.

import { HEDWIG_FONT_FACES } from './fontFaces.js';

const STYLE_ID = 'hedwig-shell-styles';

const CSS = HEDWIG_FONT_FACES + `
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
.hw-btn { transition: background var(--motion-fast, 120ms) ease, border-color var(--motion-fast, 120ms) ease, color var(--motion-fast, 120ms) ease; }
.hw-btn:hover:not(:disabled) { background: var(--hw-tint) !important; }
.hw-btn:disabled { opacity: 0.5; cursor: default !important; }
.hw-btn-quiet:hover:not(:disabled) { background: var(--hw-tint) !important; color: var(--hw-ink) !important; }
.hw-row:hover { background: var(--hw-tint); }
.hw-chip:hover:not(:disabled) { border-color: var(--hw-muted) !important; }
.hw-menu-item:hover, .hw-menu-item:focus-visible { background: var(--hw-tint); outline: none; }
.hw-menu-item[aria-disabled="true"] { opacity: 0.5; }
.hw-splitter { transition: background var(--motion-fast, 120ms) ease; }
.hw-splitter:hover > span, .hw-splitter:focus-visible > span, .hw-splitter[data-dragging="true"] > span { background: var(--hw-teal) !important; }
.hw-splitter:focus-visible { outline: none; }
.hw-pane:focus { outline: none; }
.hw-pane[data-flash="true"] { animation: hw-pane-flash 700ms var(--ease-standard, ease) 1; }
@keyframes hw-pane-flash {
  0% { box-shadow: inset 0 0 0 2px var(--hw-teal); }
  100% { box-shadow: inset 0 0 0 2px transparent; }
}
@keyframes hw-drawer-in {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes hw-pop-in {
  from { transform: translateY(-4px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .hw-pane[data-flash="true"] { animation: none; box-shadow: inset 0 0 0 2px var(--hw-teal); }
}
`;

export function ensureHedwigStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// Style fragments reused across the shell.
export const ui = {
  label: {
    fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
    color: 'var(--hw-muted)',
  },
  mono: { fontFamily: 'var(--hw-font-mono)' },
  display: { fontFamily: 'var(--hw-font-display)', fontWeight: 600, letterSpacing: '-0.01em' },
  iconButton: {
    width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--hw-border)', borderRadius: 8, background: 'var(--hw-surface)',
    color: 'var(--hw-ink)', cursor: 'pointer', padding: 0, flexShrink: 0,
  },
  quietIconButton: {
    width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 0, borderRadius: 6, background: 'transparent', color: 'var(--hw-muted)',
    cursor: 'pointer', padding: 0, flexShrink: 0,
  },
  button: {
    height: 32, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
    border: '1px solid var(--hw-border)', borderRadius: 8, background: 'var(--hw-surface)',
    color: 'var(--hw-ink)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  primaryButton: {
    height: 32, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
    border: 0, borderRadius: 8, background: 'var(--hw-ink)', color: 'var(--hw-surface)',
    fontFamily: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  chip: (active) => ({
    fontFamily: 'inherit', padding: '3px 9px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
    border: active ? '1px solid var(--hw-ink)' : '1px solid var(--hw-border)',
    background: active ? 'var(--hw-ink)' : 'transparent',
    color: active ? 'var(--hw-surface)' : 'var(--hw-ink)',
    lineHeight: 1.5,
  }),
  card: {
    borderRadius: 10, background: 'var(--hw-surface)', border: '1px solid var(--hw-border)',
  },
};
