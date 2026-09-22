// Plugin manifest v2 (`hedwig.plugin.json`): the permission catalog, the hook table, a small semver
// implementation and a strict validator. Pure module: no DB, no filesystem, so the CLI
// (scripts/hedwig-plugin.mjs) and the tests can use it directly.
import { HEDWIG_HOOKS } from '../hooks.js';
import { ManifestError } from './errors.js';

/** The plugin API version this server implements. Manifests declare a semver range against it. */
export const HEDWIG_PLUGIN_API = '1.0.0';

export const ID_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SETTING_REF_RE = /^\$settings\.([A-Za-z][A-Za-z0-9_]{0,63})$/;
const SEMVER_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const REL_JS_RE = /^\.\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:m?js)$/;

/** Permission catalog. `net:<host>` is open-ended and described on the fly. */
export const PERMISSIONS = Object.freeze({
  'mail.read': 'Read your messages, threads and account list',
  'mail.write': 'Label and archive your messages',
  'context.read': 'Read the people, topics and commitments Hedwig knows about',
  'context.write': 'Add facts to Hedwig\'s context',
  'triage.hook': 'See and steer how new mail is triaged',
  'llm.summarize': 'Summarize text with the model gateway (counts against its daily budget)',
  'llm.extract': 'Extract structured data with the model gateway (counts against its daily budget)',
  'llm.chat': 'Send its own prompts to the model gateway (counts against its daily budget)',
  'compose.draft': 'Create drafts in your Drafts folder (never sends)',
  storage: 'Keep its own data',
  views: 'Add views and commands to the interface',
  schedule: 'Run in the background on a schedule',
  'agent.tools': 'Offer tools to the Hedwig agent',
});

export function describePermission(name) {
  if (PERMISSIONS[name]) return PERMISSIONS[name];
  if (typeof name === 'string' && name.startsWith('net:')) {
    const target = name.slice(4);
    const ref = SETTING_REF_RE.exec(target);
    if (ref) return `Connect to the server you configure in its "${ref[1]}" setting`;
    return `Connect to ${target}`;
  }
  return name;
}

/**
 * Hooks a v2 plugin may implement. `registry` is the name dispatched through upstream's
 * pluginRegistry; `permission` must be granted for the hook to fire for a user; `timeoutMs`
 * bounds a slow plugin so it cannot stall the dispatch site (beforeSend sits in the send path).
 */
export const HOOKS = Object.freeze({
  beforeTriage: { registry: HEDWIG_HOOKS.beforeTriage, permission: 'triage.hook', timeoutMs: 10_000 },
  afterTriage: { registry: HEDWIG_HOOKS.afterTriage, permission: 'triage.hook', timeoutMs: 60_000 },
  onContextBuilt: { registry: HEDWIG_HOOKS.onContextBuilt, permission: 'context.read', timeoutMs: 60_000 },
  beforeSend: { registry: HEDWIG_HOOKS.beforeSend, permission: 'mail.read', timeoutMs: 5_000 },
  onMessageIndexed: { registry: HEDWIG_HOOKS.onMessageIndexed, permission: 'mail.read', timeoutMs: 120_000 },
  collectInsights: { registry: HEDWIG_HOOKS.collectInsights, permission: null, timeoutMs: 60_000 },
  // Upstream event, re-shaped so the plugin never sees the account row or the engine facade.
  onSentMessage: { registry: 'onSentMessage', permission: 'mail.read', timeoutMs: 60_000 },
});

const TOP_LEVEL_KEYS = new Set([
  'id', 'name', 'version', 'api', 'tier', 'description', 'author', 'homepage', 'license',
  'backend', 'frontend', 'permissions', 'hooks', 'settings', 'net', 'views', 'commands',
]);
const SETTING_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const SETTING_FORMATS = new Set(['url', 'email', 'host', 'secret', 'multiline']);

// ── semver ───────────────────────────────────────────────────────────────────
export function parseVersion(v) {
  const m = SEMVER_RE.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

function cmp(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

// Expand one comparator into [op, version] pairs. Supports *, x-ranges, ^, ~, and >=,>,<=,<,=.
function comparators(token) {
  if (token === '*' || token === 'x' || token === 'X' || token === '') return [];
  const op = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
  const sym = op[1] || '';
  const raw = op[2];
  const parts = raw.split('.');
  if (parts.length > 3 || !parts.length) return null;
  const nums = [];
  for (const p of parts.slice(0, 3)) {
    if (/^[xX*]$/.test(p)) break;
    const n = /^\d{1,6}(?:-[0-9A-Za-z.-]+)?$/.test(p) ? parseInt(p, 10) : NaN;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const pre = parts.length === 3 ? (/-([0-9A-Za-z.-]+)$/.exec(parts[2])?.[1] || null) : null;
  const full = nums.length === 3;
  const lo = { major: nums[0] ?? 0, minor: nums[1] ?? 0, patch: nums[2] ?? 0, pre };
  if (nums.length === 0) return sym === '' || sym === '=' ? [] : null;
  if (sym === '^') {
    const hi = lo.major > 0 ? { major: lo.major + 1, minor: 0, patch: 0, pre: null }
      : (nums.length >= 2 && lo.minor > 0) ? { major: 0, minor: lo.minor + 1, patch: 0, pre: null }
        : nums.length === 3 ? { major: 0, minor: 0, patch: lo.patch + 1, pre: null }
          : nums.length === 2 ? { major: 0, minor: lo.minor + 1, patch: 0, pre: null }
            : { major: 1, minor: 0, patch: 0, pre: null };
    return [['>=', lo], ['<', hi]];
  }
  if (sym === '~') {
    const hi = nums.length >= 2 ? { major: lo.major, minor: lo.minor + 1, patch: 0, pre: null } : { major: lo.major + 1, minor: 0, patch: 0, pre: null };
    return [['>=', lo], ['<', hi]];
  }
  if (!full) {
    // Partial version: 1 → >=1.0.0 <2.0.0, 1.2 → >=1.2.0 <1.3.0 (with an operator, pad with zeros).
    if (sym && sym !== '=') return [[sym, lo]];
    const hi = nums.length === 1 ? { major: lo.major + 1, minor: 0, patch: 0, pre: null } : { major: lo.major, minor: lo.minor + 1, patch: 0, pre: null };
    return [['>=', lo], ['<', hi]];
  }
  return [[sym || '=', lo]];
}

/** Parse a range into OR-groups of AND-comparators; null when malformed. */
export function parseRange(range) {
  if (typeof range !== 'string' || !range.trim() || range.length > 128) return null;
  const groups = [];
  for (const group of range.split('||')) {
    const tokens = group.trim().replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const all = [];
    for (const t of tokens.length ? tokens : ['*']) {
      const c = comparators(t);
      if (!c) return null;
      all.push(...c);
    }
    groups.push(all);
  }
  return groups;
}

export function satisfies(version, range) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  const groups = parseRange(range);
  if (!v || !groups) return false;
  return groups.some((g) => g.every(([op, ref]) => {
    const c = cmp(v, ref);
    switch (op) {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  }));
}

// ── ids ──────────────────────────────────────────────────────────────────────
/**
 * Upstream's registry id regex has no dots, so a v2 id registers there as dots → '-'. This mapped
 * id is also the activation key stored in users.preferences.enabledPlugins (the upstream
 * activation store), so /api/plugins and the old Settings → Plugins tab toggle v2 plugins too.
 */
export function upstreamIdFor(id) {
  return String(id).replace(/\./g, '-');
}

/** Agent tool name prefix: `aer.receipts` → `aer_receipts__`. */
export function toolPrefix(id) {
  return `${String(id).replace(/[.-]/g, '_')}__`;
}

export function isHost(s) {
  return typeof s === 'string' && HOST_RE.test(s);
}

export function settingRef(s) {
  const m = SETTING_REF_RE.exec(String(s || ''));
  return m ? m[1] : null;
}

// ── validation ───────────────────────────────────────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function checkString(errors, path, v, { min = 1, max = 200, required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) errors.push(`${path} is required`);
    return false;
  }
  if (typeof v !== 'string') { errors.push(`${path} must be a string`); return false; }
  if (v.trim().length < min) { errors.push(`${path} must not be empty`); return false; }
  if (v.length > max) { errors.push(`${path} is longer than ${max} characters`); return false; }
  return true;
}

function validateSettingsSchema(errors, schema) {
  if (!isPlainObject(schema)) { errors.push('settings must be an object ({ type: "object", properties })'); return; }
  if (schema.type !== undefined && schema.type !== 'object') errors.push('settings.type must be "object"');
  const props = schema.properties;
  if (!isPlainObject(props)) { errors.push('settings.properties must be an object'); return; }
  const keys = Object.keys(props);
  if (keys.length > 40) errors.push('settings may declare at most 40 properties');
  for (const key of keys) {
    const p = props[key];
    const path = `settings.properties.${key}`;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) { errors.push(`${path}: key must match [A-Za-z][A-Za-z0-9_]*`); continue; }
    if (!isPlainObject(p)) { errors.push(`${path} must be an object`); continue; }
    for (const k of Object.keys(p)) {
      if (!['type', 'title', 'description', 'default', 'enum', 'format', 'secret', 'minimum', 'maximum', 'maxLength'].includes(k)) {
        errors.push(`${path}: unknown key "${k}"`);
      }
    }
    if (!SETTING_TYPES.has(p.type)) { errors.push(`${path}.type must be one of ${[...SETTING_TYPES].join(', ')}`); continue; }
    if (p.title !== undefined) checkString(errors, `${path}.title`, p.title, { max: 120 });
    if (p.description !== undefined) checkString(errors, `${path}.description`, p.description, { max: 500 });
    if (p.format !== undefined && !SETTING_FORMATS.has(p.format)) errors.push(`${path}.format must be one of ${[...SETTING_FORMATS].join(', ')}`);
    if (p.secret !== undefined && typeof p.secret !== 'boolean') errors.push(`${path}.secret must be a boolean`);
    if (p.enum !== undefined) {
      if (!Array.isArray(p.enum) || !p.enum.length || p.enum.length > 50) errors.push(`${path}.enum must be a non-empty array`);
      else if (p.enum.some((e) => coerceSettingValue(p, e) !== e)) errors.push(`${path}.enum values must match its type`);
    }
    for (const k of ['minimum', 'maximum', 'maxLength']) {
      if (p[k] !== undefined && !Number.isFinite(p[k])) errors.push(`${path}.${k} must be a number`);
    }
    if (p.default !== undefined && coerceSettingValue(p, p.default) === undefined) {
      errors.push(`${path}.default does not match its type`);
    }
  }
}

/**
 * Coerce one settings value to its declared type, or undefined when it does not fit. Used by the
 * validator and by settings.set, so a plugin's settings are always the shape its schema promises.
 */
export function coerceSettingValue(prop, raw) {
  if (raw === undefined || raw === null) return undefined;
  let v;
  switch (prop.type) {
    case 'boolean':
      if (typeof raw === 'boolean') v = raw;
      else if (raw === 'true' || raw === 'false') v = raw === 'true';
      else return undefined;
      break;
    case 'number':
    case 'integer': {
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw) : NaN);
      if (!Number.isFinite(n)) return undefined;
      if (prop.type === 'integer' && !Number.isInteger(n)) return undefined;
      if (prop.minimum !== undefined && n < prop.minimum) return undefined;
      if (prop.maximum !== undefined && n > prop.maximum) return undefined;
      v = n;
      break;
    }
    case 'string': {
      if (typeof raw !== 'string') return undefined;
      const max = prop.maxLength ?? 2000;
      if (raw.length > max) return undefined;
      if (/[\0]/.test(raw)) return undefined;
      if (prop.format === 'url' && raw) {
        let u;
        try { u = new URL(raw); } catch { return undefined; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
        if (u.username || u.password) return undefined;
      }
      if (prop.format === 'host' && raw && !isHost(raw.toLowerCase())) return undefined;
      if (prop.format === 'email' && raw && !/^[^\s@]+@[^\s@]+$/.test(raw)) return undefined;
      v = raw;
      break;
    }
    default:
      return undefined;
  }
  if (prop.enum && !prop.enum.includes(v)) return undefined;
  return v;
}

/**
 * Validate a manifest strictly. Returns a normalized, deep-frozen copy; throws ManifestError with
 * every problem found (not just the first) so an author can fix them in one pass.
 * @param {object} raw
 * @param {{ tier?: 1|2, source?: string }} [opts] expected tier (bundled = 1, external = 2)
 */
export function validateManifest(raw, { tier: expectedTier, source = 'hedwig.plugin.json' } = {}) {
  const errors = [];
  if (!isPlainObject(raw)) throw new ManifestError(['must be a JSON object'], source);

  for (const k of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(k)) errors.push(`unknown key "${k}"`);

  if (checkString(errors, 'id', raw.id, { max: 64 })) {
    if (!ID_RE.test(raw.id)) errors.push(`id must match ${ID_RE} (lowercase letters, digits, "." and "-"), got ${JSON.stringify(raw.id)}`);
    else if (/[.-]{2}|[.-]$/.test(raw.id)) errors.push('id must not contain ".." / "--" or end with "." or "-"');
  }
  checkString(errors, 'name', raw.name, { max: 80 });
  if (checkString(errors, 'version', raw.version, { max: 80 }) && !parseVersion(raw.version)) {
    errors.push(`version must be semver (x.y.z), got ${JSON.stringify(raw.version)}`);
  }
  if (checkString(errors, 'api', raw.api, { max: 128 })) {
    if (!parseRange(raw.api)) errors.push(`api must be a semver range such as "^1.0.0", got ${JSON.stringify(raw.api)}`);
    else if (!satisfies(HEDWIG_PLUGIN_API, raw.api)) errors.push(`requires Hedwig plugin API ${raw.api}; this server provides ${HEDWIG_PLUGIN_API}`);
  }
  if (raw.tier !== 1 && raw.tier !== 2) errors.push(`tier must be 1 (in-repo) or 2 (external), got ${JSON.stringify(raw.tier)}`);
  else if (expectedTier && raw.tier !== expectedTier) {
    errors.push(expectedTier === 2 ? 'external plugins must declare tier 2' : 'bundled plugins must declare tier 1');
  }
  checkString(errors, 'description', raw.description, { max: 500 });
  if (raw.author !== undefined) {
    if (typeof raw.author === 'string') checkString(errors, 'author', raw.author, { max: 200 });
    else if (isPlainObject(raw.author)) checkString(errors, 'author.name', raw.author.name, { max: 200 });
    else errors.push('author must be a string or { name, email?, url? }');
  } else errors.push('author is required');
  if (raw.homepage !== undefined) checkString(errors, 'homepage', raw.homepage, { max: 300 });
  if (raw.license !== undefined) checkString(errors, 'license', raw.license, { max: 64 });

  for (const key of ['backend', 'frontend']) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !REL_JS_RE.test(v) || v.split('/').includes('..')) {
      errors.push(`${key} must be a relative path to a .js/.mjs file inside the plugin, like "./${key === 'backend' ? 'backend/index.js' : 'frontend.js'}"`);
    }
  }

  // Permissions
  const declared = new Map();
  if (raw.permissions === undefined) errors.push('permissions is required (use [] for none)');
  else if (!Array.isArray(raw.permissions)) errors.push('permissions must be an array');
  else {
    if (raw.permissions.length > 40) errors.push('at most 40 permissions');
    raw.permissions.forEach((p, i) => {
      const path = `permissions[${i}]`;
      if (!isPlainObject(p)) { errors.push(`${path} must be { name, reason, optional? }`); return; }
      for (const k of Object.keys(p)) if (!['name', 'optional', 'reason'].includes(k)) errors.push(`${path}: unknown key "${k}"`);
      if (typeof p.name !== 'string') { errors.push(`${path}.name is required`); return; }
      if (p.name.startsWith('net:')) {
        const target = p.name.slice(4);
        if (!isHost(target) && !settingRef(target)) errors.push(`${path}.name: "${p.name}" must be net:<hostname> or net:$settings.<key>`);
      } else if (!PERMISSIONS[p.name]) {
        errors.push(`${path}.name: unknown permission "${p.name}" (known: ${Object.keys(PERMISSIONS).join(', ')}, net:<host>)`);
      }
      if (declared.has(p.name)) errors.push(`${path}.name: "${p.name}" is declared twice`);
      if (p.optional !== undefined && typeof p.optional !== 'boolean') errors.push(`${path}.optional must be a boolean`);
      checkString(errors, `${path}.reason`, p.reason, { max: 300 });
      declared.set(p.name, { name: p.name, optional: p.optional === true, reason: typeof p.reason === 'string' ? p.reason : '' });
    });
  }

  // Hooks
  const hooks = [];
  if (raw.hooks !== undefined) {
    if (!Array.isArray(raw.hooks)) errors.push('hooks must be an array of hook names');
    else {
      for (const h of raw.hooks) {
        if (!HOOKS[h]) { errors.push(`hooks: unknown hook "${h}" (known: ${Object.keys(HOOKS).join(', ')})`); continue; }
        if (hooks.includes(h)) { errors.push(`hooks: "${h}" listed twice`); continue; }
        const perm = HOOKS[h].permission;
        if (perm && !declared.has(perm)) errors.push(`hooks: "${h}" needs the "${perm}" permission to be declared`);
        hooks.push(h);
      }
    }
  }

  // Settings
  if (raw.settings !== undefined) validateSettingsSchema(errors, raw.settings);
  const settingProps = isPlainObject(raw.settings?.properties) ? raw.settings.properties : {};

  // Network
  const net = [];
  if (raw.net !== undefined) {
    if (!Array.isArray(raw.net)) errors.push('net must be an array of hostnames');
    else {
      for (const entry of raw.net) {
        const e = typeof entry === 'string' ? entry.toLowerCase() : entry;
        const ref = settingRef(entry);
        if (ref) {
          const prop = settingProps[ref];
          if (!prop || prop.type !== 'string' || (prop.format !== 'url' && prop.format !== 'host')) {
            errors.push(`net: "${entry}" must reference a string setting with format "url" or "host"`);
          }
          net.push(entry);
        } else if (!isHost(e)) {
          errors.push(`net: "${entry}" is not a hostname (no scheme, port or path; wildcards are not allowed)`);
        } else net.push(e);
      }
    }
  }
  for (const n of net) if (!declared.has(`net:${n}`)) errors.push(`net: "${n}" needs a matching "net:${n}" permission`);
  for (const name of declared.keys()) {
    if (name.startsWith('net:') && !net.includes(name.slice(4))) errors.push(`permission "${name}" has no matching entry in net`);
  }

  // Views / commands (ids the plugin's frontend registers; shown on the plugin card)
  for (const key of ['views', 'commands']) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 50) { errors.push(`${key} must be an array of ids`); continue; }
    for (const vid of v) {
      if (typeof vid !== 'string' || !vid.startsWith(`${raw.id}.`) || vid.length > 128) {
        errors.push(`${key}: "${vid}" must start with "${raw.id}."`);
      }
    }
    if (v.length && !declared.has('views')) errors.push(`${key} requires the "views" permission`);
  }

  if (errors.length) throw new ManifestError(errors, source);

  return deepFreeze({
    id: raw.id,
    name: raw.name.trim(),
    version: raw.version,
    api: raw.api,
    tier: raw.tier,
    description: raw.description.trim(),
    author: typeof raw.author === 'string' ? raw.author : raw.author.name,
    homepage: raw.homepage || null,
    license: raw.license || null,
    backend: raw.backend || null,
    frontend: raw.frontend || null,
    permissions: [...declared.values()],
    hooks,
    settings: raw.settings ? JSON.parse(JSON.stringify(raw.settings)) : null,
    net,
    views: raw.views ? [...raw.views] : [],
    commands: raw.commands ? [...raw.commands] : [],
  });
}

export function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

/** Default values from a settings schema. */
export function settingsDefaults(schema) {
  const out = {};
  for (const [k, p] of Object.entries(schema?.properties || {})) if (p.default !== undefined) out[k] = p.default;
  return out;
}

export function isSecretSetting(prop) {
  return Boolean(prop && (prop.secret === true || prop.format === 'secret'));
}
