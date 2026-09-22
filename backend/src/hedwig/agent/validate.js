// Argument validation for agent tool calls. Models produce arguments, so everything is checked
// against the tool's JSON schema before a handler (or a pending action) ever sees it. Supports the
// subset of JSON schema the tools use; unknown properties are dropped rather than passed through.
// Light coercion covers what models commonly get wrong ("true" for true, "5" for 5).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function coerce(schema, v) {
  if (v === undefined || v === null) return v;
  const t = schema.type;
  if ((t === 'number' || t === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (t === 'boolean' && typeof v === 'string') {
    if (/^(true|yes|1)$/i.test(v.trim())) return true;
    if (/^(false|no|0)$/i.test(v.trim())) return false;
  }
  if (t === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  if (t === 'array' && !Array.isArray(v) && v !== '') return [v];
  return v;
}

function check(schema, raw, path, errors) {
  if (!schema || typeof schema !== 'object') return raw;
  const v = coerce(schema, raw);
  const t = schema.type;
  if (t) {
    const actual = typeOf(v);
    const ok = t === actual || (t === 'number' && actual === 'integer');
    if (!ok) { errors.push(`${path} must be ${t}`); return undefined; }
  }
  if (schema.enum && !schema.enum.includes(v)) { errors.push(`${path} must be one of ${schema.enum.join(', ')}`); return undefined; }
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength} characters`);
    if (schema.format === 'uuid' && !UUID_RE.test(v)) errors.push(`${path} must be an id from a tool result`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(v))) errors.push(`${path} must be an ISO 8601 date-time`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path} must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path} must be ≤ ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    return schema.items ? v.map((item, i) => check(schema.items, item, `${path}[${i}]`, errors)) : v;
  }
  if (t === 'object' && v && typeof v === 'object') {
    const out = {};
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (v[key] === undefined || v[key] === null || v[key] === '') errors.push(`${path === '$' ? '' : `${path}.`}${key} is required`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (v[key] === undefined || v[key] === null) {
        if (sub.default !== undefined) out[key] = sub.default;
        continue;
      }
      const res = check(sub, v[key], path === '$' ? key : `${path}.${key}`, errors);
      if (res !== undefined) out[key] = res;
    }
    return out;
  }
  return v;
}

/**
 * Validate and normalise tool arguments.
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
export function validateArgs(schema, args) {
  if (args && typeof args === 'object' && '_raw' in args && Object.keys(args).length === 1) {
    return { ok: false, errors: ['arguments were not valid JSON'] };
  }
  const errors = [];
  const value = check(schema || { type: 'object', properties: {} }, args ?? {}, '$', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: value ?? {} };
}
