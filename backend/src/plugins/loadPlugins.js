import { pluginRegistry } from './registry.js';
import { gtdPlugin } from './gtd/index.js';

// Plugins bundled upstream that Hedwig leaves out. GTD keeps its states as label folders on the
// mail server; Hedwig organises mail without changing the mailbox other clients see, and keeps
// these states itself (Reply Later, Set Aside, Delegated, Reference, Waiting on: work/lists.js).
// Left unregistered, GTD has no routes, no tick, and no entry in the plugin list.
export const HEDWIG_HIDDEN_PLUGINS = new Set(['gtd']);

// Register the bundled (Tier-1, in-repo) plugins into the registry. Called once at boot,
// before routes are mounted. The order here is the order plugin routers mount in index.js.
export function loadBundledPlugins(registry = pluginRegistry, { hidden = HEDWIG_HIDDEN_PLUGINS } = {}) {
  for (const plugin of [gtdPlugin]) {
    if (!hidden.has(plugin.id)) registry.register(plugin);
  }
  return registry;
}
