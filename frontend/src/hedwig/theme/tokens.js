// Hedwig design tokens and the --hw-* CSS variables every Hedwig component reads.
//
// Hedwig views never read upstream theme variables directly. The two Hedwig themes set the
// tokens from the design canvas; every other theme gets tokens derived from its own palette, so
// a view looks at home under Nord or Windows XP as well as under Hedwig. Pure JS (no DOM, no
// JSX) so themes.js and node tests can import it.

export const HEDWIG_LIGHT = {
  ground: '#F3EEE4',
  surface: '#FFFDF9',
  raised: '#EFE8DB',
  border: '#E2DACB',
  ink: '#1B1A17',
  muted: '#6B665C',
  faint: '#9A948A',
  tint: '#E9E3D6',
  teal: '#1F6B66',
  tealTint: '#D7E8E5',
  tealText: '#155450',
  amber: '#B56E1A',
  amberTint: '#F5E3C8',
  amberText: '#7A4A0E',
  red: '#A8432E',
  redTint: '#F3DCD5',
  shadow: '0 1px 0 #E2DACB',
  overlayShadow: '0 12px 40px rgba(27,26,23,0.18), 0 0 0 1px #E2DACB',
};

export const HEDWIG_DARK = {
  ground: '#16140F',
  surface: '#1F1C16',
  raised: '#26221B',
  border: '#3A342A',
  ink: '#EFE8DB',
  muted: '#A39B8C',
  faint: '#6F685C',
  tint: '#2F2A21',
  teal: '#5FB3AB',
  tealTint: '#1E3432',
  tealText: '#8ACFC7',
  amber: '#E0A054',
  amberTint: '#3A2A14',
  amberText: '#F2C184',
  red: '#E07A62',
  redTint: '#3A1F18',
  shadow: '0 1px 0 #3A342A',
  overlayShadow: '0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px #3A342A',
};

// Font stacks. They defer to the active font set (fonts.js writes --font-*), so the 'hedwig'
// set gives Fraunces / IBM Plex and any other set the user picks is honoured.
const FONT_VARS = {
  '--hw-font-display': "var(--font-display, 'Fraunces', Georgia, serif)",
  '--hw-font-body': "var(--font-sans, 'IBM Plex Sans', system-ui, sans-serif)",
  '--hw-font-mono': "var(--font-mono, 'IBM Plex Mono', ui-monospace, monospace)",
};

function fromTokens(t) {
  return {
    '--hw-ground': t.ground,
    '--hw-surface': t.surface,
    '--hw-raised': t.raised,
    '--hw-border': t.border,
    '--hw-ink': t.ink,
    '--hw-muted': t.muted,
    '--hw-faint': t.faint,
    '--hw-tint': t.tint,
    '--hw-teal': t.teal,
    '--hw-teal-tint': t.tealTint,
    '--hw-teal-text': t.tealText,
    '--hw-amber': t.amber,
    '--hw-amber-tint': t.amberTint,
    '--hw-amber-text': t.amberText,
    '--hw-red': t.red,
    '--hw-red-tint': t.redTint,
    '--hw-shadow': t.shadow,
    '--hw-overlay-shadow': t.overlayShadow,
    ...FONT_VARS,
  };
}

// Derived from the upstream palette with CSS expressions rather than precomputed colours, so a
// custom-CSS override of --accent or --bg-secondary flows through to Hedwig views as well.
const DERIVED = {
  '--hw-ground': 'var(--bg-primary)',
  '--hw-surface': 'var(--bg-secondary)',
  '--hw-raised': 'var(--bg-tertiary)',
  '--hw-border': 'var(--border)',
  '--hw-ink': 'var(--text-primary)',
  '--hw-muted': 'var(--text-secondary)',
  '--hw-faint': 'var(--text-tertiary)',
  '--hw-tint': 'var(--bg-hover)',
  '--hw-teal': 'var(--accent)',
  '--hw-teal-tint': 'color-mix(in srgb, var(--accent) 18%, var(--bg-secondary))',
  '--hw-teal-text': 'color-mix(in srgb, var(--accent) 70%, var(--text-primary))',
  '--hw-amber': 'var(--amber)',
  '--hw-amber-tint': 'color-mix(in srgb, var(--amber) 20%, var(--bg-secondary))',
  '--hw-amber-text': 'color-mix(in srgb, var(--amber) 65%, var(--text-primary))',
  '--hw-red': 'var(--red)',
  '--hw-red-tint': 'color-mix(in srgb, var(--red) 18%, var(--bg-secondary))',
  '--hw-shadow': '0 1px 0 var(--border)',
  '--hw-overlay-shadow': 'var(--shadow-modal)',
  ...FONT_VARS,
};

export const HW_VAR_NAMES = Object.keys(DERIVED);

export function isHedwigTheme(themeName) {
  return themeName === 'hedwig' || themeName === 'hedwig-night';
}

// The --hw-* variables for a theme name. Unknown and upstream themes get the derived set.
export function hwVarsFor(themeName) {
  if (themeName === 'hedwig') return fromTokens(HEDWIG_LIGHT);
  if (themeName === 'hedwig-night') return fromTokens(HEDWIG_DARK);
  return { ...DERIVED };
}

// Upstream CSS variables for the two Hedwig themes, so upstream components (sidebar, list,
// reading pane, admin panel) sit in the same palette as the Hedwig views around them.
export function upstreamVarsFor(t, dark) {
  return {
    '--bg-primary': t.ground,
    '--bg-secondary': t.surface,
    '--bg-tertiary': t.raised,
    '--bg-elevated': t.surface,
    '--bg-hover': t.tint,
    '--border': t.border,
    '--border-subtle': dark ? '#2A261F' : '#EBE4D6',
    '--text-primary': t.ink,
    '--text-secondary': t.muted,
    '--text-tertiary': t.faint,
    '--accent': t.teal,
    '--accent-text': dark ? t.ground : t.surface,
    '--accent-dim': t.tealTint,
    '--accent-glow': dark ? 'rgba(95,179,171,0.15)' : 'rgba(31,107,102,0.12)',
    '--green': dark ? '#7FB77E' : '#3F7D4E',
    '--red': t.red,
    '--amber': t.amber,
  };
}
