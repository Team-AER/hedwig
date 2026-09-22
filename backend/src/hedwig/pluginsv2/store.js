// Per-user plugin storage and settings, both in upstream's generic plugin_data table (so user
// deletion cascades through owner_id and uninstall is one DELETE by plugin_id).
//
//   u:<userId>:<key>   a plugin's own key/value data for one user (storage.*)
//   s:<userId>         the plugin's settings for one user (settings.*)
//
// A plugin never sees these prefixes: every call is scoped to (plugin, user) by the facade.
import { query } from '../../services/db.js';
import { encrypt, decrypt, isEncrypted } from '../../services/encryption.js';
import { PluginInputError } from './errors.js';
import { coerceSettingValue, isSecretSetting, settingsDefaults } from './manifest.js';

const KEY_RE = /^[A-Za-z0-9._:/@+=-]{1,200}$/;
export const MAX_VALUE_BYTES = 256 * 1024;
export const MAX_KEYS_PER_USER = 20_000;
export const SECRET_MASK = '••••••••';

const userPrefix = (userId) => `u:${userId}:`;

function checkKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new PluginInputError(`storage key must match ${KEY_RE} (got ${JSON.stringify(key)?.slice(0, 80)})`);
  }
}

function encodeValue(value) {
  let json;
  try { json = JSON.stringify(value === undefined ? null : value); } catch { throw new PluginInputError('storage value must be JSON-serialisable'); }
  if (Buffer.byteLength(json) > MAX_VALUE_BYTES) throw new PluginInputError(`storage value is larger than ${MAX_VALUE_BYTES} bytes`);
  // plugin_data.value is JSONB NOT NULL; wrap so scalars and null round-trip.
  return JSON.stringify({ v: JSON.parse(json) });
}

export async function storageGet(pluginId, userId, key) {
  checkKey(key);
  const { rows } = await query(
    'SELECT value FROM plugin_data WHERE plugin_id = $1 AND key = $2 AND owner_id = $3',
    [pluginId, userPrefix(userId) + key, userId],
  );
  return rows[0] ? (rows[0].value?.v ?? null) : null;
}

export async function storageSet(pluginId, userId, key, value) {
  checkKey(key);
  const encoded = encodeValue(value);
  const fullKey = userPrefix(userId) + key;
  const { rows: existing } = await query('SELECT 1 FROM plugin_data WHERE plugin_id = $1 AND key = $2', [pluginId, fullKey]);
  if (!existing.length) {
    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM plugin_data WHERE plugin_id = $1 AND owner_id = $2 AND left(key, $4) = $3',
      [pluginId, userId, userPrefix(userId), userPrefix(userId).length],
    );
    if ((rows[0]?.n || 0) >= MAX_KEYS_PER_USER) throw new PluginInputError(`storage quota reached (${MAX_KEYS_PER_USER} keys per user)`);
  }
  await query(
    `INSERT INTO plugin_data (plugin_id, key, owner_id, value, visibility, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, 'private', NOW())
     ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value, owner_id = EXCLUDED.owner_id, updated_at = NOW()`,
    [pluginId, fullKey, userId, encoded],
  );
  return true;
}

export async function storageDelete(pluginId, userId, key) {
  checkKey(key);
  const res = await query('DELETE FROM plugin_data WHERE plugin_id = $1 AND key = $2 AND owner_id = $3', [pluginId, userPrefix(userId) + key, userId]);
  return (res.rowCount || 0) > 0;
}

/** Keys under an optional prefix, newest first: [{ key, value, updatedAt }]. */
export async function storageList(pluginId, userId, { prefix = '', limit = 100, offset = 0, values = true } = {}) {
  if (prefix) checkKey(prefix);
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  const off = Math.max(0, Math.min(1_000_000, Number(offset) || 0));
  const full = userPrefix(userId) + (prefix || '');
  const { rows } = await query(
    `SELECT key, ${values ? 'value' : 'NULL::jsonb AS value'}, updated_at FROM plugin_data
      WHERE plugin_id = $1 AND owner_id = $2 AND left(key, $4) = $3
      ORDER BY updated_at DESC, key LIMIT $5 OFFSET $6`,
    [pluginId, userId, full, full.length, lim, off],
  );
  const strip = userPrefix(userId).length;
  return rows.map((r) => ({ key: r.key.slice(strip), value: values ? (r.value?.v ?? null) : undefined, updatedAt: r.updated_at }));
}

// ── Settings ─────────────────────────────────────────────────────────────────
async function readRawSettings(pluginId, userId) {
  const { rows } = await query(
    'SELECT value FROM plugin_data WHERE plugin_id = $1 AND key = $2 AND owner_id = $3',
    [pluginId, `s:${userId}`, userId],
  );
  return rows[0]?.value?.v && typeof rows[0].value.v === 'object' ? rows[0].value.v : {};
}

/** The user's settings for a plugin: schema defaults overlaid with stored values, secrets decrypted. */
export async function settingsGet(manifest, userId) {
  const schema = manifest.settings;
  const out = settingsDefaults(schema);
  if (!schema) return out;
  const stored = await readRawSettings(manifest.id, userId);
  for (const [k, prop] of Object.entries(schema.properties)) {
    if (!(k in stored)) continue;
    let v = stored[k];
    if (isSecretSetting(prop) && typeof v === 'string' && v && isEncrypted(v)) {
      try { v = decrypt(v); } catch { v = undefined; }
    }
    const c = coerceSettingValue(prop, v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Settings as shown to the browser: secrets masked. */
export async function settingsForClient(manifest, userId) {
  const values = await settingsGet(manifest, userId);
  for (const [k, prop] of Object.entries(manifest.settings?.properties || {})) {
    if (isSecretSetting(prop)) values[k] = values[k] ? SECRET_MASK : '';
  }
  return values;
}

/**
 * Merge a patch into the user's settings. Unknown keys and values that do not fit the schema are
 * rejected with every problem listed. `null` resets a key to its default. The secret mask means
 * "unchanged". Secrets are encrypted at rest.
 */
export async function settingsSet(manifest, userId, patch) {
  const schema = manifest.settings;
  if (!schema) throw new PluginInputError(`${manifest.id} has no settings`);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new PluginInputError('settings must be an object');
  const stored = await readRawSettings(manifest.id, userId);
  const errors = [];
  for (const [k, raw] of Object.entries(patch)) {
    const prop = schema.properties[k];
    if (!prop) { errors.push(`unknown setting ${k}`); continue; }
    if (raw === null) { delete stored[k]; continue; }
    if (isSecretSetting(prop) && raw === SECRET_MASK) continue;
    const v = coerceSettingValue(prop, raw);
    if (v === undefined) { errors.push(`invalid value for ${k}`); continue; }
    stored[k] = isSecretSetting(prop) && v ? encrypt(v) : v;
  }
  if (errors.length) throw new PluginInputError(errors.join('; '));
  await query(
    `INSERT INTO plugin_data (plugin_id, key, owner_id, value, visibility, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, 'private', NOW())
     ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [manifest.id, `s:${userId}`, userId, JSON.stringify({ v: stored })],
  );
  return settingsGet(manifest, userId);
}
