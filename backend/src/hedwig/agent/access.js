// Which tools a user may use right now: core tools, plus plugin tools of plugins the user activated
// and granted the tool's permission to (hedwig_plugin_grants).
import { query } from '../../services/db.js';
import { getActivatedPlugins } from '../../plugins/activation.js';
import { toolsFor } from './toolRegistry.js';

export async function userGrants(userId) {
  const { rows } = await query('SELECT plugin_id, permission FROM hedwig_plugin_grants WHERE user_id = $1', [userId]);
  return new Set(rows.map((r) => `${r.plugin_id}:${r.permission}`));
}

/** @param {string[]|null} [allowed] narrow to these names (automations); null or [] = no narrowing */
export async function userTools(userId, allowed = null) {
  const [grants, activePlugins] = await Promise.all([userGrants(userId), getActivatedPlugins(userId)]);
  return toolsFor({ grants, activePlugins, allowed });
}
