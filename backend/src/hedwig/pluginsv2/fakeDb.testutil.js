// In-memory stand-in for the handful of queries the plugin runtime issues, for unit tests that
// mock services/db.js. Not a SQL engine: each branch matches one statement from access.js,
// store.js or loader.js.
export function createFakeDb() {
  const state = {
    access: new Map(), // `${userId}|${pluginId}` -> { grants: [] }
    enabled: new Map(), // userId -> Set of upstream ids (users.preferences.enabledPlugins)
    users: new Set(),
    pluginData: new Map(), // `${pluginId}|${key}` -> { owner_id, value, updated_at }
    plugins: new Map(), // id -> hedwig_plugins row
    calls: [],
  };

  const upstream = (id) => id.replace(/\./g, '-');
  function grant(userId, pluginId, grants = [], active = true) {
    state.users.add(userId);
    state.access.set(`${userId}|${pluginId}`, { grants: [...grants] });
    const set = state.enabled.get(userId) || new Set();
    if (active) set.add(upstream(pluginId)); else set.delete(upstream(pluginId));
    state.enabled.set(userId, set);
  }
  function reset() {
    state.access.clear(); state.enabled.clear(); state.users.clear(); state.pluginData.clear(); state.plugins.clear(); state.calls.length = 0;
  }

  async function query(sql, params = []) {
    state.calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.includes('AS active') && s.includes('FROM users u WHERE u.id = $1')) {
      const [userId, upstreamId, pluginId] = params;
      if (!state.users.has(userId)) return { rows: [] };
      const a = state.access.get(`${userId}|${pluginId}`);
      return { rows: [{ active: Boolean(state.enabled.get(userId)?.has(upstreamId)), grants: a?.grants || [] }] };
    }
    if (s.startsWith('SELECT u.id FROM users u JOIN hedwig_plugin_grants')) {
      const [pluginId, upstreamId, permission] = params;
      const rows = [];
      for (const [k, a] of state.access) {
        const [userId, pid] = k.split('|');
        if (pid === pluginId && state.enabled.get(userId)?.has(upstreamId) && a.grants.includes(permission)) rows.push({ id: userId });
      }
      return { rows };
    }
    if (s.startsWith('WITH del AS ( DELETE FROM hedwig_plugin_grants')) {
      const [userId, pluginId, grants] = params;
      state.users.add(userId);
      state.access.set(`${userId}|${pluginId}`, { grants: [...grants] });
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM hedwig_plugin_grants WHERE plugin_id = $1')) {
      for (const k of [...state.access.keys()]) if (k.endsWith(`|${params[0]}`)) state.access.delete(k);
      return { rows: [] };
    }
    // upstream activation.js
    if (s.startsWith("SELECT preferences->'enabledPlugins' AS list FROM users WHERE id = $1")) {
      return { rows: state.users.has(params[0]) ? [{ list: [...(state.enabled.get(params[0]) || [])] }] : [] };
    }
    if (s.startsWith('UPDATE users SET preferences = jsonb_set(COALESCE(preferences')) {
      state.users.add(params[0]);
      state.enabled.set(params[0], new Set(JSON.parse(params[1])));
      return { rows: [] };
    }
    if (s.startsWith("UPDATE users SET preferences = jsonb_set(preferences, '{enabledPlugins}'")) {
      for (const set of state.enabled.values()) set.delete(params[0]);
      return { rows: [] };
    }

    // plugin_data
    if (s.startsWith('SELECT value FROM plugin_data WHERE plugin_id = $1 AND key = $2 AND owner_id = $3')) {
      const r = state.pluginData.get(`${params[0]}|${params[1]}`);
      return { rows: r && r.owner_id === params[2] ? [{ value: r.value }] : [] };
    }
    if (s.startsWith('SELECT 1 FROM plugin_data WHERE plugin_id = $1 AND key = $2')) {
      return { rows: state.pluginData.has(`${params[0]}|${params[1]}`) ? [{ '?column?': 1 }] : [] };
    }
    if (s.startsWith('SELECT COUNT(*)::int AS n FROM plugin_data')) {
      const [pluginId, owner, prefix] = params;
      let n = 0;
      for (const [k, r] of state.pluginData) if (k.startsWith(`${pluginId}|${prefix}`) && r.owner_id === owner) n++;
      return { rows: [{ n }] };
    }
    if (s.startsWith('INSERT INTO plugin_data')) {
      const [pluginId, key, owner, value] = params;
      state.pluginData.set(`${pluginId}|${key}`, { owner_id: owner, value: JSON.parse(value), updated_at: new Date(Date.now() + state.calls.length) });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM plugin_data WHERE plugin_id = $1 AND key = $2 AND owner_id = $3')) {
      const k = `${params[0]}|${params[1]}`;
      const r = state.pluginData.get(k);
      if (r && r.owner_id === params[2]) { state.pluginData.delete(k); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM plugin_data WHERE plugin_id = $1')) {
      for (const k of [...state.pluginData.keys()]) if (k.startsWith(`${params[0]}|`)) state.pluginData.delete(k);
      return { rows: [] };
    }
    if (s.startsWith('SELECT key,') && s.includes('FROM plugin_data')) {
      const [pluginId, owner, full, , limit, offset] = params;
      const rows = [...state.pluginData.entries()]
        .filter(([k, r]) => k.startsWith(`${pluginId}|${full}`) && r.owner_id === owner)
        .map(([k, r]) => ({ key: k.slice(pluginId.length + 1), value: r.value, updated_at: r.updated_at }))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(offset, offset + limit);
      return { rows };
    }

    // hedwig_plugins
    if (s.startsWith('SELECT id, source, location, manifest, sha256') && s.includes('FROM hedwig_plugins')) {
      return { rows: [...state.plugins.values()] };
    }
    if (s.startsWith('INSERT INTO hedwig_plugins')) {
      const [id, source, location, manifest, sha256, status, error, installedBy, pin] = params;
      const prev = state.plugins.get(id);
      state.plugins.set(id, {
        id, source, location, manifest: JSON.parse(manifest), status, error,
        sha256: prev && !pin ? prev.sha256 : sha256,
        installed_by: installedBy || prev?.installed_by || null,
        installed_at: prev?.installed_at || new Date(), updated_at: new Date(),
      });
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM hedwig_plugins WHERE id = $1')) {
      state.plugins.delete(params[0]);
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  }

  return { state, query, grant, reset };
}
