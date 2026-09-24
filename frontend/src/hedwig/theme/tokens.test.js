// Run with: node --test src/hedwig/theme/tokens.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hwVarsFor, HW_VAR_NAMES, HEDWIG_LIGHT, HEDWIG_DARK, V2_LIGHT, V2_DARK, AVATAR_HUES, FONT_STACKS,
  isHedwigTheme, userVarsCss, contrastRatio,
} from './tokens.js';
import { THEMES, getInitialTheme } from '../../themes.js';
import { FONT_SETS, effectiveFontSet } from '../../fonts.js';

// The variables Hedwig views are promised (docs/hedwig/ARCHITECTURE.md, shell brief, and the
// redesign contract docs/hedwig/design/REDESIGN-BUILD-2026-09-24.md).
const CONTRACT = [
  '--hw-ground', '--hw-surface', '--hw-raised', '--hw-border', '--hw-ink', '--hw-muted',
  '--hw-teal', '--hw-teal-tint', '--hw-teal-text', '--hw-amber', '--hw-amber-tint', '--hw-amber-text',
  '--hw-red', '--hw-font-display', '--hw-font-body', '--hw-font-mono',
  // v2 (docs/hedwig/V2-BUILD.md §Frontend)
  '--hw-paper', '--hw-accent', '--hw-accent-ink', '--hw-accent-tint', '--hw-glass', '--hw-edge',
  '--hw-line', '--hw-line2', '--hw-tint', '--hw-blur', '--hw-font-why',
  // redesign (Foundation contract)
  '--hw-content', '--hw-bar', '--hw-field', '--hw-hover', '--hw-select', '--hw-attention', '--hw-attention-ink',
];

describe('Hedwig CSS variables', () => {
  it('every theme gets the full --hw-* contract', () => {
    for (const name of Object.keys(THEMES)) {
      const vars = hwVarsFor(name);
      for (const v of CONTRACT) assert.ok(vars[v], `${name} is missing ${v}`);
      assert.deepEqual(Object.keys(vars).sort(), [...HW_VAR_NAMES].sort(), `${name} has a different --hw-* set`);
    }
  });

  it('the Hedwig themes use the redesign palette exactly (spec §e)', () => {
    const light = hwVarsFor('hedwig');
    assert.equal(light['--hw-paper'], '#EEF0F3');
    assert.equal(light['--hw-ground'], '#EEF0F3');
    assert.equal(light['--hw-content'], '#FFFFFF');
    assert.equal(light['--hw-glass'], 'rgba(248,248,250,0.72)');
    assert.equal(light['--hw-bar'], 'rgba(255,255,255,0.78)');
    assert.equal(light['--hw-line'], 'rgba(0,0,0,0.08)');
    assert.equal(light['--hw-field'], 'rgba(0,0,0,0.045)');
    assert.equal(light['--hw-hover'], 'rgba(0,0,0,0.04)');
    assert.equal(light['--hw-select'], 'rgba(0,0,0,0.07)');
    assert.equal(light['--hw-ink'], '#1D1D1F');
    assert.equal(light['--hw-muted'], '#5E5E63');
    assert.equal(light['--hw-accent'], '#007AFF');
    assert.equal(light['--hw-accent-ink'], '#0062CC');
    assert.equal(light['--hw-accent-tint'], 'rgba(0,122,255,0.12)');
    assert.equal(light['--hw-attention'], '#E0561A');
    assert.equal(light['--hw-attention-ink'], '#A8420F');
    const dark = hwVarsFor('hedwig-night');
    assert.equal(dark['--hw-paper'], '#161618');
    assert.equal(dark['--hw-content'], '#1E1E20');
    assert.equal(dark['--hw-glass'], 'rgba(40,40,44,0.70)');
    assert.equal(dark['--hw-accent'], '#0A84FF');
    assert.equal(dark['--hw-accent-ink'], '#4DA3FF');
    assert.equal(dark['--hw-attention-ink'], '#FF9A66');
    assert.equal(THEMES.hedwig.vars['--bg-primary'], HEDWIG_LIGHT.ground);
    assert.equal(THEMES['hedwig-night'].vars['--text-primary'], HEDWIG_DARK.ink);
    assert.equal(THEMES.hedwig.vars['--accent'], '#007AFF', 'upstream components take the blue too');
  });

  it('old names still resolve: tint is the hover fill, teal the accent, amber the attention orange', () => {
    for (const name of ['hedwig', 'hedwig-night']) {
      const v = hwVarsFor(name);
      assert.equal(v['--hw-tint'], v['--hw-hover']);
      assert.equal(v['--hw-teal'], v['--hw-accent']);
      assert.equal(v['--hw-amber'], v['--hw-attention']);
    }
  });

  it('other themes derive from their own palette rather than Hedwig colours', () => {
    const vars = hwVarsFor('nord');
    assert.equal(vars['--hw-ground'], 'var(--bg-primary)');
    assert.match(vars['--hw-amber-tint'], /var\(--amber\)/);
    assert.equal(vars['--hw-content'], 'var(--bg-secondary)');
    assert.equal(isHedwigTheme('nord'), false);
    assert.equal(isHedwigTheme('hedwig-night'), true);
  });

  it('type is the system stack: display and why are the body face, no serif anywhere', () => {
    assert.match(FONT_STACKS.sans, /^-apple-system, BlinkMacSystemFont/);
    for (const name of ['hedwig', 'hedwig-night', 'nord']) {
      const v = hwVarsFor(name);
      assert.equal(v['--hw-font-display'], v['--hw-font-body']);
      assert.equal(v['--hw-font-why'], v['--hw-font-body']);
      assert.doesNotMatch(Object.values(v).join(' '), /Instrument|Georgia|(^|[ ,])serif\b/);
    }
  });

  it('the old orange default the server still reports does not override the blue', () => {
    assert.doesNotMatch(userVarsCss({ accent: '#E0561A' }), /--hw-accent:/);
    assert.doesNotMatch(userVarsCss({ accent: '#007AFF' }), /--hw-accent:/);
    assert.match(userVarsCss({ accent: '#3366CC' }), /--hw-accent: #3366CC/);
  });
});

describe('Hedwig defaults', () => {
  it('a first visit gets a Hedwig theme', () => {
    assert.ok(isHedwigTheme(getInitialTheme()));
  });

  it('Hedwig themes pair with the system type unless the user chose another set', () => {
    assert.ok(FONT_SETS.system);
    assert.match(FONT_SETS.system.vars['--font-sans'], /^-apple-system/);
    assert.equal(FONT_SETS.system.vars['--font-display'], FONT_SETS.system.vars['--font-sans']);
    assert.match(FONT_SETS.system.vars['--font-mono'], /^ui-monospace/);
    // The Instrument set stays pickable.
    assert.match(FONT_SETS.hedwig.vars['--font-sans'], /Instrument Sans/);
    assert.equal(effectiveFontSet('hedwig', 'default'), 'system');
    assert.equal(effectiveFontSet('hedwig-night', undefined), 'system');
    assert.equal(effectiveFontSet('hedwig', 'hedwig'), 'hedwig');
    assert.equal(effectiveFontSet('hedwig', 'editorial'), 'editorial');
    assert.equal(effectiveFontSet('dark', 'default'), 'default');
    assert.equal(effectiveFontSet('winxp', 'default'), 'winxp');
  });
});

// ── Contrast, measured on the composited surfaces (spec §e) ────────────────────────────────
// Browsers blend in sRGB: out = a·fg + (1 − a)·bg per channel. Each surface is built bottom-up.
function parse(c) {
  const s = String(c).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m) throw new Error(`cannot parse colour ${c}`);
  const [r, g, b, a = 1] = m[1].split(',').map((x) => Number(x.trim()));
  return { r, g, b, a };
}
function over(fg, bg, alpha) {
  const f = parse(fg);
  const b = parse(bg);
  const a = (alpha ?? 1) * f.a;
  const ch = (k) => Math.round(f[k] * a + b[k] * (1 - a));
  return `#${['r', 'g', 'b'].map((k) => ch(k).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
const stack = (...layers) => layers.reduce((bg, [fg, alpha]) => over(fg, bg, alpha));

function surfaces(p) {
  const ground = p.paper;
  const field = over(p.glow, p.paper, p.glowOpacity); // the light field at full strength (worst case)
  const glassOnField = over(p.glass, field);
  const glassOnPaper = over(p.glass, ground);
  return {
    content: p.content,
    'glass on the field': glassOnField,
    'glass on the paper': glassOnPaper,
    'rail selected (select on glass)': stack(glassOnField, [p.select]),
    'rail hover (hover on glass)': stack(glassOnField, [p.hover]),
    'row hover (hover on content)': stack(p.content, [p.hover]),
    'row selected (accent tint on content)': stack(p.content, [p.accentTint]),
    'field on content (search, summary)': stack(p.content, [p.field]),
    'bar on content': stack(p.content, [p.bar]),
  };
}

for (const [theme, p] of [['light', V2_LIGHT], ['dark', V2_DARK]]) {
  describe(`contrast, ${theme} theme`, () => {
    const all = surfaces(p);
    it('ink and muted text are ≥4.5:1 on every surface, glass composited over the paper and the field', () => {
      for (const [where, bg] of Object.entries(all)) {
        for (const [name, fg] of [['ink', p.ink], ['muted', p.muted]]) {
          const r = contrastRatio(fg, bg);
          assert.ok(r >= 4.5, `${name} on ${where} (${bg}) is ${r.toFixed(2)}:1`);
        }
      }
    });

    it('accent-ink and attention-ink text are ≥4.5:1 where they appear', () => {
      const where = ['content', 'row hover (hover on content)', 'row selected (accent tint on content)', 'field on content (search, summary)', 'glass on the field'];
      for (const w of where) {
        for (const [name, fg] of [['accent-ink', p.accentInk], ['attention-ink', p.attentionInk]]) {
          const r = contrastRatio(fg, all[w]);
          assert.ok(r >= 4.5, `${name} on ${w} is ${r.toFixed(2)}:1`);
        }
      }
    });

    it('glyphs and dots (accent, attention) are ≥3:1', () => {
      // Rail glyphs are accent, on the glass and on the selected fill.
      for (const w of ['content', 'glass on the field', 'rail selected (select on glass)', 'rail hover (hover on glass)']) {
        const r = contrastRatio(p.accent, all[w]);
        assert.ok(r >= 3, `accent on ${w} is ${r.toFixed(2)}:1`);
      }
      // The unread dot and the flag are attention, on list rows (the dot stays on a selected row).
      for (const w of ['content', 'row hover (hover on content)', 'row selected (accent tint on content)', 'glass on the field']) {
        const r = contrastRatio(p.attention, all[w]);
        assert.ok(r >= 3, `attention on ${w} is ${r.toFixed(2)}:1`);
      }
      assert.ok(contrastRatio(p.onAccent, p.accent) >= 3, 'the on-accent glyph on a solid accent');
    });
  });
}

describe('avatar hues', () => {
  it('eight hues, each ≥4.5:1 against the white initials', () => {
    assert.equal(AVATAR_HUES.length, 8);
    assert.equal(new Set(AVATAR_HUES).size, 8);
    for (const hue of AVATAR_HUES) assert.ok(contrastRatio('#FFFFFF', hue) >= 4.5, `${hue}: ${contrastRatio('#FFFFFF', hue).toFixed(2)}:1`);
  });
});
