import { describe, it, expect, vi } from 'vitest';

// gtd/index.js imports routes/gtd.js, which imports index.js (which starts the server).
// Mock the router module so this test only exercises registration, not the whole app.
vi.mock('../routes/gtd.js', () => ({ default: function gtdRouter() {} }));

import { createPluginRegistry } from './registry.js';
import { loadBundledPlugins } from './loadPlugins.js';

describe('loadBundledPlugins', () => {
  it('leaves GTD out of Hedwig: no routes, no tick, nothing in the plugin list', () => {
    const r = createPluginRegistry();
    loadBundledPlugins(r);
    expect(r.get('gtd')).toBeFalsy();
  });

  it('registers the GTD plugin as Tier-1 mounted at /api/gtd when it is not hidden', () => {
    const r = createPluginRegistry();
    loadBundledPlugins(r, { hidden: new Set() });
    const gtd = r.get('gtd');
    expect(gtd).toBeTruthy();
    expect(gtd.tier).toBe(1);
    expect(gtd.router.base).toBe('/api/gtd');
    expect(typeof gtd.router.handler).toBe('function');
  });
});
