// Tier-2 plugin import boundary (v3.0 plugin platform).
//
// A sandboxed plugin may import ONLY the plugin API (../api.js) and its own siblings inside its
// plugin directory. It may NOT reach into core (../../services, ../../utils, ../../middleware,
// ../../index, ../../routes) or platform internals (../registry.js, ../storage.js, …). This config
// enforces that for everything under src/plugins/<name>/ (the barrel src/plugins/api.js and the
// platform files src/plugins/*.js are intentionally NOT covered — they ARE the sanctioned core).
//
// Kept out of the main eslint.config.js (which CI runs with --max-warnings 0) while GTD is still
// being migrated onto the API: run it on demand to measure/track the remaining violations —
//   node ./node_modules/eslint/bin/eslint.js -c eslint.plugins-boundary.js src/plugins
// Once GTD imports only ../api.js + siblings, fold this into the CI config as an error.
import globals from 'globals';

export default [
  {
    files: ['src/plugins/*/**/*.js'],
    ignores: ['**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['../../**'],
            message: 'Plugin boundary: import core capabilities from the plugin API ("../api.js"), not core directly.',
          },
          {
            group: ['../*', '!../api.js'],
            message: 'Plugin boundary: from the plugin dir, only "../api.js" (the plugin API) may be imported.',
          },
        ],
      }],
    },
  },
  // Hedwig plugin runtime v2 first-party plugins (tier 1). Stricter than the block above: they get
  // everything through the `hedwig` facade passed to activate(), so they may import only their own
  // siblings — not even ../api.js, packages or node built-ins — and may not touch the process, the
  // global network APIs or eval. The same rules the runtime applies to tier-2 plugins at install
  // (src/hedwig/pluginsv2/boundary.js), enforced here in CI.
  {
    files: ['src/plugins/{receipts,digest,pensieve,sendguard}/**/*.js'],
    ignores: ['**/*.test.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: '^(?!\\./)',
            message: 'Plugin runtime v2: a first-party plugin imports only its own files ("./…"); everything else comes through the hedwig facade.',
          },
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'process', message: 'Plugin runtime v2: no process access; use hedwig.settings / hedwig.user.' },
        { name: 'fetch', message: 'Plugin runtime v2: use hedwig.net.fetch (granted hosts only).' },
        { name: 'require', message: 'Plugin runtime v2: import siblings instead.' },
        { name: 'globalThis', message: 'Plugin runtime v2: no global object access.' },
        { name: 'global', message: 'Plugin runtime v2: no global object access.' },
        { name: 'XMLHttpRequest', message: 'Plugin runtime v2: use hedwig.net.fetch.' },
        { name: 'WebSocket', message: 'Plugin runtime v2: use hedwig.net.fetch.' },
      ],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
];
