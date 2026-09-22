// Which tools a user may use right now: core tools, plus plugin tools of plugins the user activated
// and granted the tool's permission to. Activation and grants come from the plugin runtime, which
// maps public plugin ids (aer.receipts) to upstream activation keys (aer-receipts).
import { query } from '../../services/db.js';
import { toolsFor } from './toolRegistry.js';

export async function userGrants(userId) {
  const { rows } = await query('SELECT plugin_id, permission FROM hedwig_plugin_grants WHERE user_id = $1', [userId]);
  return new Set(rows.map((r) => `${r.plugin_id}:${r.permission}`));
}

async function pluginAccess(userId) {
  try {
    const { pluginAccessFor } = await import('../pluginsv2/index.js');
    return await pluginAccessFor(userId);
  } catch {
    // Plugin runtime unavailable: core tools only.
    return { grants: new Set(), activePlugins: new Set() };
  }
}

/** @param {string[]|null} [allowed] narrow to these names (automations); null or [] = no narrowing */
export async function userTools(userId, allowed = null) {
  const { grants, activePlugins } = await pluginAccess(userId);
  return toolsFor({ grants, activePlugins, allowed });
}
