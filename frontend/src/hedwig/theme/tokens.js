// Hedwig design tokens and the --hw-* CSS variables every Hedwig component reads.
//
// v2 look (docs/hedwig/design/*.dc.html): paper ground with two blurred light fields, glass
// sheets, hairlines, one accent. The v2 variables are --hw-paper, --hw-ink, --hw-muted,
// --hw-accent, --hw-accent-ink, --hw-accent-tint, --hw-glass, --hw-edge, --hw-line, --hw-line2,
// --hw-tint, --hw-on-accent, --hw-shadow-color, --hw-field-a/-b and --hw-blur. They carry an --hw- prefix
// because upstream already owns --accent and friends.
//
// The older names (--hw-ground, --hw-surface, --hw-teal, --hw-amber, …) stay for the v1 views
// and for plugin bundles (runtimeLoader hands them out as `tokens`); under the Hedwig themes they
// resolve to the v2 palette. Every other theme gets tokens derived from its own palette, so a
// view still looks at home under Nord or Windows XP. Pure JS (no DOM, no JSX) so themes.js and
// node tests can import it.

export const V2_LIGHT = {
  paper: '#F4F2EC',
  ink: '#17181A',
  muted: '#66696D',
  accent: '#E0561A',
  // Accent as text. #B24512 was 4.3:1 on the accent tint; #9E3B0E is 5.3:1 there (6.1:1 on paper).
  accentInk: '#9E3B0E',
  accentTint: 'rgba(224,86,26,0.12)',
  onAccent: '#FFFFFF',     // icons and text on a solid accent fill
  glass: 'rgba(255,255,255,0.52)',
  edge: 'rgba(255,255,255,0.72)',
  line: 'rgba(23,24,26,0.09)',
  line2: 'rgba(23,24,26,0.18)',
  tint: 'rgba(23,24,26,0.045)',
  shadowColor: 'rgba(23,24,26,0.5)',
  fieldA: 0.22,        // accent field opacity (top right)
  fieldB: 0.16,        // blue field opacity (bottom left)
  fieldBlue: '#3B5A8A',
};

export const V2_DARK = {
  paper: '#111214',
  ink: '#F2F0EA',
  muted: '#A3A6AA',
  accent: '#FF7A40',
  accentInk: '#FF9A66',
  accentTint: 'rgba(255,122,64,0.16)',
  onAccent: '#111214',     // white on #FF7A40 is 2.6:1; the paper is 7.2:1
  glass: 'rgba(32,33,37,0.55)',
  edge: 'rgba(255,255,255,0.10)',
  line: 'rgba(255,255,255,0.09)',
  line2: 'rgba(255,255,255,0.18)',
  tint: 'rgba(255,255,255,0.05)',
  shadowColor: 'rgba(0,0,0,0.8)',
  fieldA: 0.28,
  fieldB: 0.35,
  fieldBlue: '#3B5A8A',
};

export const DEFAULT_ACCENT = V2_LIGHT.accent;
export const DEFAULT_BLUR = 24;

// Legacy token objects (the names themes.js and the v1 views know), computed from the v2
// palette. `surface` and `raised` are opaque so upstream components painted with them stay
// legible; `teal` is the quiet second colour (the blue light field), `amber` is the accent.
export const HEDWIG_LIGHT = {
  ground: V2_LIGHT.paper,
  surface: '#FBFAF7',
  raised: '#ECE9E2',
  border: '#DCD9D2',
  ink: V2_LIGHT.ink,
  muted: V2_LIGHT.muted,
  faint: '#9A9CA0',
  tint: '#E9E6DF',
  teal: '#3B5A8A',
  tealTint: '#DEE4EE',
  tealText: '#2C4468',
  amber: V2_LIGHT.accent,
  amberTint: '#F8DECF',
  amberText: V2_LIGHT.accentInk,
  red: '#B3261E',
  redTint: '#F4DAD7',
  shadow: `0 1px 0 ${V2_LIGHT.line}`,
  overlayShadow: `0 30px 70px -40px ${V2_LIGHT.shadowColor}, 0 0 0 1px ${V2_LIGHT.line}`,
};

export const HEDWIG_DARK = {
  ground: V2_DARK.paper,
  surface: '#1A1B1E',
  raised: '#222327',
  border: '#34363B',
  ink: V2_DARK.ink,
  muted: V2_DARK.muted,
  faint: '#6E7176',
  tint: '#26272B',
  teal: '#7A9BD6',
  tealTint: '#1E2634',
  tealText: '#A9C0E8',
  amber: V2_DARK.accent,
  amberTint: '#3A2419',
  amberText: V2_DARK.accentInk,
  red: '#F2867C',
  redTint: '#3A1E1B',
  shadow: `0 1px 0 ${V2_DARK.line}`,
  overlayShadow: `0 30px 70px -40px ${V2_DARK.shadowColor}, 0 0 0 1px ${V2_DARK.line}`,
};

// Type. Instrument Serif for titles and every reason Hedwig gives (in italic), Instrument Sans
// for body, DM Mono for times and counts, each with a system fallback. They defer to the active
// font set (fonts.js writes --font-*), so the 'hedwig' set gives the Instrument pair and any
// other set the user picks is honoured.
export const FONT_STACKS = {
  serif: "'Instrument Serif', Georgia, 'Times New Roman', serif",
  sans: "'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

const FONT_VARS = {
  '--hw-font-display': `var(--font-display, ${FONT_STACKS.serif})`,
  '--hw-font-body': `var(--font-sans, ${FONT_STACKS.sans})`,
  '--hw-font-mono': `var(--font-mono, ${FONT_STACKS.mono})`,
  // Reasons are always the serif, whatever the font set: they are Hedwig's voice.
  '--hw-font-why': FONT_STACKS.serif,
};

function v2Vars(p) {
  return {
    '--hw-paper': p.paper,
    '--hw-accent': p.accent,
    '--hw-accent-ink': p.accentInk,
    '--hw-accent-tint': p.accentTint,
    '--hw-on-accent': p.onAccent,
    '--hw-glass': p.glass,
    '--hw-edge': p.edge,
    '--hw-line': p.line,
    '--hw-line2': p.line2,
    '--hw-shadow-color': p.shadowColor,
    '--hw-field-a': String(p.fieldA),
    '--hw-field-b': String(p.fieldB),
    '--hw-field-blue': p.fieldBlue,
    '--hw-blur': `${DEFAULT_BLUR}px`,
  };
}

function fromTokens(t, p) {
  return {
    '--hw-ground': t.ground,
    '--hw-surface': t.surface,
    '--hw-raised': t.raised,
    '--hw-border': t.border,
    '--hw-ink': t.ink,
    '--hw-muted': t.muted,
    '--hw-faint': t.faint,
    '--hw-tint': p.tint,
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
    ...v2Vars(p),
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
  '--hw-edge': 'var(--border-subtle, var(--border))',
  '--hw-line': 'color-mix(in srgb, var(--text-primary) 9%, transparent)',
  '--hw-line2': 'color-mix(in srgb, var(--text-primary) 18%, transparent)',
  '--hw-shadow-color': 'rgba(0,0,0,0.45)',
  '--hw-field-a': '0.18',
  '--hw-field-b': '0.14',
  '--hw-field-blue': '#3B5A8A',
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
  if (themeName === 'hedwig') return fromTokens(HEDWIG_LIGHT, V2_LIGHT);
  if (themeName === 'hedwig-night') return fromTokens(HEDWIG_DARK, V2_DARK);
  return { ...DERIVED };
}

// Upstream CSS variables for the two Hedwig themes, so upstream components (sidebar, list,
// reading pane, palette, admin panel) sit in the same palette as the Hedwig views around them.
export function upstreamVarsFor(t, dark) {
  const p = dark ? V2_DARK : V2_LIGHT;
  return {
    '--bg-primary': t.ground,
    '--bg-secondary': t.surface,
    '--bg-tertiary': t.raised,
    '--bg-elevated': t.surface,
    '--bg-hover': t.tint,
    '--border': t.border,
    '--border-subtle': dark ? '#26272B' : '#E6E3DC',
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

/**
 * CSS text overriding the accent and blur for the signed-in user. The selectors carry the
 * theme attribute so they win over the theme's plain `:root` block whatever the source order.
 * An accent equal to the default leaves each theme's own accent alone (the dark theme uses a
 * lighter orange), so only a real choice is applied to both.
 */
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

/** White or the dark paper on a solid accent fill, whichever reads better. */
export function onAccentFor(hex) {
  const h = normaliseHex(hex);
  if (!h) return V2_LIGHT.onAccent;
  return contrastRatio(h, '#FFFFFF') >= contrastRatio(h, V2_DARK.paper) ? '#FFFFFF' : V2_DARK.paper;
}

export function userVarsCss({ accent, blur } = {}) {
  const lines = [];
  const b = clampBlur(blur ?? DEFAULT_BLUR);
  lines.push(`:root[data-mailflow-theme] { --hw-blur: ${b}px; }`);
  const hex = normaliseHex(accent);
  if (hex && hex !== DEFAULT_ACCENT) {
    lines.push(`:root[data-mailflow-theme] { --hw-accent: ${hex}; --hw-accent-ink: color-mix(in srgb, ${hex} 70%, #000); --hw-accent-tint: color-mix(in srgb, ${hex} 12%, transparent); --hw-on-accent: ${onAccentFor(hex)}; }`);
    lines.push(`:root[data-mailflow-theme="hedwig-night"] { --hw-accent-ink: color-mix(in srgb, ${hex} 70%, #fff); --hw-accent-tint: color-mix(in srgb, ${hex} 16%, transparent); }`);
  }
  return lines.join('\n');
}
