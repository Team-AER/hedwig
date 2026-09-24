// Hedwig design tokens and the --hw-* CSS variables every Hedwig component reads.
//
// Look (docs/hedwig/design/DESIGN-AUDIT-2026-09-24.md §e): a soft neutral ground with one faint
// cool light field, glass only for navigation (the rail, toolbars), opaque content sheets split by
// hairlines, the system type stack, one blue accent, orange only as the attention signal. The
// variables are --hw-paper, --hw-ink, --hw-muted, --hw-accent(-ink/-tint), --hw-on-accent,
// --hw-glass, --hw-bar, --hw-content, --hw-edge, --hw-line, --hw-line2, --hw-field, --hw-hover,
// --hw-select, --hw-attention(-ink), the light field (--hw-glow, --hw-glow-opacity) and the
// shadows. They carry an --hw- prefix because upstream already owns --accent and friends.
//
// The older names stay resolvable: --hw-tint is the hover fill, --hw-teal the accent (blue),
// --hw-amber the attention orange, and --hw-ground/--hw-surface/… keep serving the v1 views and
// plugin bundles (runtimeLoader hands them out as `tokens`). Every other theme gets tokens derived
// from its own palette, so a view still looks at home under Nord or Windows XP. Pure JS (no DOM,
// no JSX) so themes.js and node tests can import it.

export const V2_LIGHT = {
  paper: '#EEF0F3',
  ink: '#1D1D1F',
  muted: '#5E5E63',
  accent: '#007AFF',
  accentInk: '#0062CC',      // links and accent text: 5.8:1 on white
  accentTint: 'rgba(0,122,255,0.12)',
  onAccent: '#FFFFFF',       // glyphs and text on a solid accent fill
  glass: 'rgba(248,248,250,0.72)',
  glassSolid: '#F5F5F7',     // the glass under prefers-reduced-transparency
  bar: 'rgba(255,255,255,0.78)',
  content: '#FFFFFF',
  edge: 'rgba(255,255,255,0.6)',
  edgeOuter: 'rgba(0,0,0,0.12)',
  line: 'rgba(0,0,0,0.08)',
  line2: 'rgba(0,0,0,0.14)',
  field: 'rgba(0,0,0,0.045)',
  hover: 'rgba(0,0,0,0.04)',
  select: 'rgba(0,0,0,0.07)',
  attention: '#E0561A',
  attentionInk: '#A8420F',
  shadowColor: 'rgba(0,0,0,0.18)',
  glow: '#9DB4D6',           // the one cool light field, top left
  glowOpacity: 0.18,
};

export const V2_DARK = {
  paper: '#161618',
  ink: '#F5F5F7',
  // Spec §e says #A1A1A6; that is 4.3:1 on the rail's selected fill over the dark glass, so it is
  // lifted to the nearest grey that clears 4.5:1 there (tokens.test.js).
  muted: '#A8A8AD',
  accent: '#0A84FF',
  accentInk: '#4DA3FF',
  accentTint: 'rgba(10,132,255,0.22)',
  onAccent: '#FFFFFF',
  glass: 'rgba(40,40,44,0.70)',
  glassSolid: '#262628',
  bar: 'rgba(30,30,32,0.80)',
  content: '#1E1E20',
  edge: 'rgba(255,255,255,0.08)',
  edgeOuter: 'rgba(0,0,0,0.6)',
  line: 'rgba(255,255,255,0.09)',
  line2: 'rgba(255,255,255,0.16)',
  field: 'rgba(255,255,255,0.06)',
  hover: 'rgba(255,255,255,0.05)',
  select: 'rgba(255,255,255,0.10)',
  attention: '#FF7A40',
  attentionInk: '#FF9A66',
  shadowColor: 'rgba(0,0,0,0.5)',
  glow: '#2B3F5E',
  glowOpacity: 0.3,
};

export const DEFAULT_ACCENT = V2_LIGHT.accent;
// Accents that mean "no choice made": the old orange default is still what GET /settings reports
// for ui.accent (backend config default), so it must not override the blue.
export const LEGACY_DEFAULT_ACCENTS = ['#E0561A'];
export const DEFAULT_BLUR = 30;

// Avatar fills: eight muted hues, each ≥4.5:1 against white initials (tokens.test.js checks).
export const AVATAR_HUES = ['#B5483A', '#9A5410', '#5F7A1E', '#2E7D5B', '#1F7A8C', '#2F6DB5', '#5B5BB8', '#B03A6E'];

// Legacy token objects (the names themes.js and the v1 views know), computed from the palette.
// `surface` and `raised` are opaque so upstream components painted with them stay legible;
// `teal` is the accent (blue), `amber` the attention orange, borders are hairline greys.
export const HEDWIG_LIGHT = {
  ground: V2_LIGHT.paper,
  surface: V2_LIGHT.content,
  raised: '#F2F2F4',
  border: '#E3E4E8',
  ink: V2_LIGHT.ink,
  muted: V2_LIGHT.muted,
  faint: '#8A8A8F',
  tint: '#F0F1F3',
  teal: V2_LIGHT.accent,
  tealTint: '#E0EEFF',
  tealText: V2_LIGHT.accentInk,
  amber: V2_LIGHT.attention,
  amberTint: '#FBE3D6',
  amberText: V2_LIGHT.attentionInk,
  red: '#B3261E',
  redTint: '#F4DAD7',
  shadow: `0 1px 0 ${V2_LIGHT.line}`,
  overlayShadow: `0 12px 32px -8px rgba(0,0,0,0.28), 0 0 0 0.5px ${V2_LIGHT.edgeOuter}`,
};

export const HEDWIG_DARK = {
  ground: V2_DARK.paper,
  surface: V2_DARK.content,
  raised: '#2A2A2D',
  border: '#333336',
  ink: V2_DARK.ink,
  muted: V2_DARK.muted,
  faint: '#6E6E73',
  tint: '#29292C',
  teal: V2_DARK.accent,
  tealTint: '#12263F',
  tealText: V2_DARK.accentInk,
  amber: V2_DARK.attention,
  amberTint: '#3A2419',
  amberText: V2_DARK.attentionInk,
  red: '#F2867C',
  redTint: '#3A1E1B',
  shadow: `0 1px 0 ${V2_DARK.line}`,
  overlayShadow: `0 12px 32px -8px rgba(0,0,0,0.6), 0 0 0 0.5px ${V2_DARK.line2}`,
};

// Type: the system stack and nothing else (spec, Direction). Display and "why" are the body face:
// no serif in the UI, and mono only for tracking numbers, one-time codes and code. They defer to
// the active font set (fonts.js writes --font-*); the Hedwig themes default to the 'system' set.
export const FONT_STACKS = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", InterVariable, Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};
// Kept so an old import still resolves; there is no serif in the UI any more.
FONT_STACKS.serif = FONT_STACKS.sans;

const BODY_FONT = `var(--font-sans, ${FONT_STACKS.sans})`;
const FONT_VARS = {
  '--hw-font-display': BODY_FONT,
  '--hw-font-body': BODY_FONT,
  '--hw-font-mono': `var(--font-mono, ${FONT_STACKS.mono})`,
  '--hw-font-why': BODY_FONT,
};

export const SHEET_SHADOW = '0 1px 2px rgba(0,0,0,0.06), 0 8px 24px -12px rgba(0,0,0,0.18)';
export const POPOVER_SHADOW = '0 12px 32px -8px rgba(0,0,0,0.28)';

function v2Vars(p, dark) {
  return {
    '--hw-paper': p.paper,
    '--hw-accent': p.accent,
    '--hw-accent-ink': p.accentInk,
    '--hw-accent-tint': p.accentTint,
    '--hw-on-accent': p.onAccent,
    '--hw-glass': p.glass,
    '--hw-glass-solid': p.glassSolid,
    '--hw-bar': p.bar,
    '--hw-content': p.content,
    '--hw-edge': p.edge,
    '--hw-edge-outer': p.edgeOuter,
    '--hw-line': p.line,
    '--hw-line2': p.line2,
    '--hw-field': p.field,
    '--hw-hover': p.hover,
    '--hw-select': p.select,
    '--hw-attention': p.attention,
    '--hw-attention-ink': p.attentionInk,
    '--hw-shadow-color': p.shadowColor,
    '--hw-shadow-sheet': dark ? '0 1px 2px rgba(0,0,0,0.3), 0 8px 24px -12px rgba(0,0,0,0.6)' : SHEET_SHADOW,
    '--hw-shadow-pop': dark ? '0 12px 32px -8px rgba(0,0,0,0.6)' : POPOVER_SHADOW,
    '--hw-glow': p.glow,
    '--hw-glow-opacity': String(p.glowOpacity),
    // The old two-field names: the accent field is gone, the blue one is the glow.
    '--hw-field-a': '0',
    '--hw-field-b': String(p.glowOpacity),
    '--hw-field-blue': p.glow,
    '--hw-blur': `${DEFAULT_BLUR}px`,
  };
}

function fromTokens(t, p, dark) {
  return {
    '--hw-ground': t.ground,
    '--hw-surface': t.surface,
    '--hw-raised': t.raised,
    '--hw-border': t.border,
    '--hw-ink': t.ink,
    '--hw-muted': t.muted,
    '--hw-faint': t.faint,
    '--hw-tint': p.hover,
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
    ...v2Vars(p, dark),
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
  '--hw-paper': 'var(--bg-primary)',
  '--hw-accent': 'var(--accent)',
  '--hw-accent-ink': 'color-mix(in srgb, var(--accent) 75%, var(--text-primary))',
  '--hw-accent-tint': 'color-mix(in srgb, var(--accent) 14%, transparent)',
  '--hw-on-accent': 'var(--accent-text, #FFFFFF)',
  '--hw-glass': 'color-mix(in srgb, var(--bg-secondary) 78%, transparent)',
  '--hw-glass-solid': 'var(--bg-secondary)',
  '--hw-bar': 'color-mix(in srgb, var(--bg-secondary) 85%, transparent)',
  '--hw-content': 'var(--bg-secondary)',
  '--hw-edge': 'var(--border-subtle, var(--border))',
  '--hw-edge-outer': 'color-mix(in srgb, var(--text-primary) 12%, transparent)',
  '--hw-line': 'color-mix(in srgb, var(--text-primary) 9%, transparent)',
  '--hw-line2': 'color-mix(in srgb, var(--text-primary) 18%, transparent)',
  '--hw-field': 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
  '--hw-hover': 'var(--bg-hover)',
  '--hw-select': 'color-mix(in srgb, var(--text-primary) 9%, transparent)',
  '--hw-attention': 'var(--amber)',
  '--hw-attention-ink': 'color-mix(in srgb, var(--amber) 65%, var(--text-primary))',
  '--hw-shadow-color': 'rgba(0,0,0,0.45)',
  '--hw-shadow-sheet': SHEET_SHADOW,
  '--hw-shadow-pop': 'var(--shadow-modal, ' + POPOVER_SHADOW + ')',
  '--hw-glow': 'var(--accent)',
  '--hw-glow-opacity': '0.12',
  '--hw-field-a': '0',
  '--hw-field-b': '0.12',
  '--hw-field-blue': 'var(--accent)',
  '--hw-blur': `${DEFAULT_BLUR}px`,
  ...FONT_VARS,
};

export const HW_VAR_NAMES = Object.keys(DERIVED);

export function isHedwigTheme(themeName) {
  return themeName === 'hedwig' || themeName === 'hedwig-night';
}

export function isDarkHedwig(themeName) {
  return themeName === 'hedwig-night';
}

// The --hw-* variables for a theme name. Unknown and upstream themes get the derived set.
export function hwVarsFor(themeName) {
  if (themeName === 'hedwig') return fromTokens(HEDWIG_LIGHT, V2_LIGHT, false);
  if (themeName === 'hedwig-night') return fromTokens(HEDWIG_DARK, V2_DARK, true);
  return { ...DERIVED };
}

// Upstream CSS variables for the two Hedwig themes, so upstream components (sidebar, list,
// reading pane, palette, admin panel) sit in the same palette as the Hedwig views around them:
// the blue accent, opaque content surfaces, borders as light hairline greys.
export function upstreamVarsFor(t, dark) {
  const p = dark ? V2_DARK : V2_LIGHT;
  return {
    '--bg-primary': t.ground,
    '--bg-secondary': t.surface,
    '--bg-tertiary': t.raised,
    '--bg-elevated': t.surface,
    '--bg-hover': t.tint,
    '--border': t.border,
    '--border-subtle': dark ? '#2A2A2D' : '#ECEDF0',
    '--text-primary': t.ink,
    '--text-secondary': t.muted,
    '--text-tertiary': t.faint,
    '--accent': p.accent,
    '--accent-text': p.onAccent,
    '--accent-dim': p.accentTint,
    '--accent-glow': p.accentTint,
    '--green': dark ? '#7FB77E' : '#3F7D4E',
    '--red': t.red,
    '--amber': dark ? '#E0A054' : '#B56E1A',
  };
}

// ── Per-user tweaks (ui.accent, ui.blur) ─────────────────────────────────────

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normaliseHex(value) {
  const s = String(value || '').trim();
  if (!HEX.test(s)) return null;
  if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase();
  return s.toUpperCase();
}

export function clampBlur(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BLUR;
  return Math.max(0, Math.min(48, Math.round(n)));
}

function luminance(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio of two #RRGGBB colours. */
export function contrastRatio(a, b) {
  const [x, y] = [luminance(normaliseHex(a)), luminance(normaliseHex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Dark glyphs for a very light custom accent (a yellow): near-black, not the dark paper.
const ON_ACCENT_DARK = '#111214';

/** White or near-black on a solid accent fill, whichever reads better. */
export function onAccentFor(hex) {
  const h = normaliseHex(hex);
  if (!h) return V2_LIGHT.onAccent;
  return contrastRatio(h, '#FFFFFF') >= contrastRatio(h, ON_ACCENT_DARK) ? '#FFFFFF' : ON_ACCENT_DARK;
}

/** True when an accent value means "no choice made" (the default, or the old orange default). */
export function isDefaultAccent(hex) {
  const h = normaliseHex(hex);
  return !h || h === DEFAULT_ACCENT || LEGACY_DEFAULT_ACCENTS.includes(h);
}

/**
 * CSS text overriding the accent and blur for the signed-in user. The selectors carry the
 * theme attribute so they win over the theme's plain `:root` block whatever the source order.
 * An accent equal to the default (or the old orange default the server still reports) leaves
 * each theme's own blue alone (the dark theme uses a lighter one), so only a real choice is
 * applied to both.
 *
 * Any valid hex is accepted. The spec (§e) asks that ui.accent tint within the blue family: the
 * picker in HedwigSettings is where that is enforced by the swatches it offers; a hex typed by
 * hand is honoured as given, and its ink and tint are derived from it.
 */
export function userVarsCss({ accent, blur } = {}) {
  const lines = [];
  const b = clampBlur(blur ?? DEFAULT_BLUR);
  lines.push(`:root[data-mailflow-theme] { --hw-blur: ${b}px; }`);
  const hex = normaliseHex(accent);
  if (hex && !isDefaultAccent(hex)) {
    lines.push(`:root[data-mailflow-theme] { --hw-accent: ${hex}; --hw-accent-ink: color-mix(in srgb, ${hex} 70%, #000); --hw-accent-tint: color-mix(in srgb, ${hex} 12%, transparent); --hw-on-accent: ${onAccentFor(hex)}; }`);
    lines.push(`:root[data-mailflow-theme="hedwig-night"] { --hw-accent-ink: color-mix(in srgb, ${hex} 70%, #fff); --hw-accent-tint: color-mix(in srgb, ${hex} 22%, transparent); }`);
  }
  return lines.join('\n');
}
