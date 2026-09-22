// Per-user plugin access: activation (upstream's users.preferences.enabledPlugins, keyed by the
// upstream-mapped id) and grants (hedwig_plugin_grants, keyed by the public v2 id). Every capability
// call checks both at call time. One query answers both; a 5 s cache keeps hot hooks cheap while
// making a revoke or deactivate take effect almost at once in every process.
import { query } from '../../services/db.js';
import { invalidateActivationCache, setPluginActivated } from '../../plugins/activation.js';
import { PermissionError, PluginInputError } from './errors.js';
import { upstreamIdFor } from './manifest.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_MS = 5_000;
const cache = new Map(); // `${userId}|${pluginId}` -> { value: { active, grants }, expiry }

export function isUserId(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function invalidateAccess(userId, pluginId) {
  if (!userId) { cache.clear(); return; }
  if (pluginId) cache.delete(`${userId}|${pluginId}`);
  else for (const k of cache.keys()) if (k.startsWith(`${userId}|`)) cache.delete(k);
}

/** { active: boolean, grants: Set<string> } for one user and plugin. Never throws. */
export async function getAccess(userId, pluginId) {
  if (!isUserId(userId)) return { active: false, grants: new Set() };
  const key = `${userId}|${pluginId}`;
  const hit = cache.get(key);
  if (hit && hit.expiry > Date.now()) return hit.value;
  let value = { active: false, grants: new Set() };
  try {
    const { rows } = await query(
      `SELECT COALESCE(u.preferences->'enabledPlugins', '[]'::jsonb) ? $2 AS active,
              COALESCE((SELECT array_agg(g.permission) FROM hedwig_plugin_grants g
                         WHERE g.user_id = u.id AND g.plugin_id = $3), '{}') AS grants
         FROM users u WHERE u.id = $1`,
      [userId, upstreamIdFor(pluginId), pluginId],
    );
    if (rows[0]) value = { active: rows[0].active === true, grants: new Set(rows[0].grants || []) };
  } catch {
    // A read blip fails closed (nothing active) rather than throwing into a hook site.
  }
  cache.set(key, { value, expiry: Date.now() + TTL_MS });
  return value;
}

/**
 * Throw PermissionError unless the user activated the plugin, the manifest declares the permission
 * and the user granted it. `permission` null means "activation only".
 */
export async function assertAllowed(plugin, userId, permission) {
  if (!isUserId(userId)) throw new PermissionError(plugin.id, permission || 'access', 'needs the acting userId as its first argument');
  if (permission && !plugin.manifest.permissions.some((p) => p.name === permission)) {
    throw new PermissionError(plugin.id, permission, 'is not declared in the manifest');
  }
  const acc = await getAccess(userId, plugin.id);
  if (!acc.active) throw new PermissionError(plugin.id, permission || 'access', 'denied: the plugin is not activated for this user');
  if (permission && !acc.grants.has(permission)) throw new PermissionError(plugin.id, permission, 'was not granted by this user');
  return acc;
}

/** Validate a requested grant list against the manifest. Returns the clean list. */
export function checkGrants(manifest, grants, { requireAll = true } = {}) {
  if (!Array.isArray(grants) || grants.some((g) => typeof g !== 'string')) throw new PluginInputError('grants must be an array of permission names');
  const declared = new Map(manifest.permissions.map((p) => [p.name, p]));
  const unknown = grants.filter((g) => !declared.has(g));
  if (unknown.length) throw new PluginInputError(`not declared by ${manifest.id}: ${unknown.join(', ')}`);
  if (requireAll) {
    const missing = manifest.permissions.filter((p) => !p.optional && !grants.includes(p.name)).map((p) => p.name);
    if (missing.length) throw new PluginInputError(`required permissions not granted: ${missing.join(', ')} (disable the plugin instead of revoking a required permission)`);
  }
  return [...new Set(grants)];
}

/** Replace a user's grants for a plugin in one statement (atomic). */
export async function setGrants(userId, pluginId, grants) {
  await query(
    `WITH del AS (
       DELETE FROM hedwig_plugin_grants
        WHERE user_id = $1 AND plugin_id = $2 AND NOT (permission = ANY($3::text[])))
     INSERT INTO hedwig_plugin_grants (user_id, plugin_id, permission)
     SELECT $1, $2, p FROM unnest($3::text[]) AS p
     ON CONFLICT DO NOTHING`,
    [userId, pluginId, grants],
  );
  invalidateAccess(userId, pluginId);
}

export async function setActivated(userId, pluginId, activated) {
  await setPluginActivated(userId, upstreamIdFor(pluginId), activated);
  invalidateActivationCache(userId);
  invalidateAccess(userId, pluginId);
}

/** Users who activated a plugin and granted `permission` (for schedule fan-out). */
export async function usersWith(pluginId, permission) {
  const { rows } = await query(
    `SELECT u.id FROM users u
       JOIN hedwig_plugin_grants g ON g.user_id = u.id AND g.plugin_id = $1 AND g.permission = $3
      WHERE COALESCE(u.preferences->'enabledPlugins', '[]'::jsonb) ? $2`,
    [pluginId, upstreamIdFor(pluginId), permission],
  );
  return rows.map((r) => r.id);
}

/**
 * Activation and grants for every plugin, shaped for agent/toolRegistry.toolsFor():
 * { activePlugins: Set<publicId>, grants: Set<`${publicId}:${permission}`> }.
 */
export async function accessSummary(userId, pluginIds) {
  const activePlugins = new Set();
  const grants = new Set();
  await Promise.all(pluginIds.map(async (id) => {
    const acc = await getAccess(userId, id);
    if (!acc.active) return;
    activePlugins.add(id);
    for (const g of acc.grants) grants.add(`${id}:${g}`);
  }));
  return { activePlugins, grants };
}
