// Run with: node --test src/hedwig/theme/tokens.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hwVarsFor, HW_VAR_NAMES, HEDWIG_LIGHT, HEDWIG_DARK, isHedwigTheme } from './tokens.js';
import { THEMES, getInitialTheme } from '../../themes.js';
import { FONT_SETS, effectiveFontSet } from '../../fonts.js';

// The variables Hedwig views are promised (docs/hedwig/ARCHITECTURE.md, shell brief).
const CONTRACT = [
  '--hw-ground', '--hw-surface', '--hw-raised', '--hw-border', '--hw-ink', '--hw-muted',
  '--hw-teal', '--hw-teal-tint', '--hw-teal-text', '--hw-amber', '--hw-amber-tint', '--hw-amber-text',
  '--hw-red', '--hw-font-display', '--hw-font-body', '--hw-font-mono',
];

describe('Hedwig CSS variables', () => {
  it('every theme gets the full --hw-* contract', () => {
    for (const name of Object.keys(THEMES)) {
      const vars = hwVarsFor(name);
      for (const v of CONTRACT) assert.ok(vars[v], `${name} is missing ${v}`);
      assert.deepEqual(Object.keys(vars).sort(), [...HW_VAR_NAMES].sort(), `${name} has a different --hw-* set`);
    }
  });

  it('the Hedwig themes use the design tokens exactly', () => {
    assert.equal(hwVarsFor('hedwig')['--hw-ground'], '#F3EEE4');
    assert.equal(hwVarsFor('hedwig')['--hw-amber-text'], '#7A4A0E');
    assert.equal(hwVarsFor('hedwig-night')['--hw-teal'], '#5FB3AB');
    assert.equal(THEMES.hedwig.vars['--bg-primary'], HEDWIG_LIGHT.ground);
    assert.equal(THEMES['hedwig-night'].vars['--text-primary'], HEDWIG_DARK.ink);
  });

  it('other themes derive from their own palette rather than Hedwig colours', () => {
    const vars = hwVarsFor('nord');
    assert.equal(vars['--hw-ground'], 'var(--bg-primary)');
    assert.match(vars['--hw-amber-tint'], /var\(--amber\)/);
    assert.equal(isHedwigTheme('nord'), false);
    assert.equal(isHedwigTheme('hedwig-night'), true);
  });
});

describe('Hedwig defaults', () => {
  it('a first visit gets a Hedwig theme', () => {
    assert.ok(isHedwigTheme(getInitialTheme()));
  });

  it('Hedwig themes pair with the Hedwig type unless the user chose another set', () => {
    assert.ok(FONT_SETS.hedwig);
    assert.match(FONT_SETS.hedwig.vars['--font-display'], /Fraunces/);
    assert.match(FONT_SETS.hedwig.vars['--font-sans'], /IBM Plex Sans/);
    assert.equal(effectiveFontSet('hedwig', 'default'), 'hedwig');
    assert.equal(effectiveFontSet('hedwig-night', undefined), 'hedwig');
    assert.equal(effectiveFontSet('hedwig', 'editorial'), 'editorial');
    assert.equal(effectiveFontSet('dark', 'default'), 'default');
    assert.equal(effectiveFontSet('winxp', 'default'), 'winxp');
  });
});
