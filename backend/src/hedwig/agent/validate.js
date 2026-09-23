// JSON schema validation for everything a model produces: agent tool arguments and prompt outputs
// (prompts/index.js). A draft-07 subset: type (including type arrays, so ['string','null'] is
// nullable), enum, const, anyOf, required, properties, additionalProperties (false or a schema),
// items, minItems/maxItems, minimum/maximum, exclusiveMinimum/exclusiveMaximum, minLength/
// maxLength, pattern, format (uuid, date-time, date, email), default.
//
// Two modes:
//   validateArgs(schema, args)       tool arguments: light coercion ("true" → true, "5" → 5), unknown
//                                    properties dropped, empty strings count as missing.
//   validateSchema(schema, value, o) general: options { coerce, dropUnknown } (both default false);
//                                    additionalProperties:false is an error unless dropUnknown.
// Both return { ok: true, value } with defaults applied, or { ok: false, errors: [string] }.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typesOf(schema) {
  if (Array.isArray(schema.type)) return schema.type;
  return schema.type ? [schema.type] : null;
}

function matchesType(t, actual) {
  return t === actual || (t === 'number' && actual === 'integer');
}

function coerceTo(t, v) {
  if ((t === 'number' || t === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (t === 'boolean' && typeof v === 'string') {
    if (/^(true|yes|1)$/i.test(v.trim())) return true;
    if (/^(false|no|0)$/i.test(v.trim())) return false;
  }
  if (t === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
  if (t === 'array' && !Array.isArray(v) && v !== '') return [v];
  return v;
}

function coerce(types, v) {
  if (v === undefined || v === null || !types) return v;
  const actual = typeOf(v);
  if (types.some((t) => matchesType(t, actual))) return v;
  for (const t of types) {
    if (t === 'null') continue;
    const c = coerceTo(t, v);
    if (c !== v) return c;
  }
  return v;
}

const join = (path, key) => (path === '$' ? key : `${path}.${key}`);

function check(schema, raw, path, errors, opts) {
  if (!schema || typeof schema !== 'object') return raw;
  const types = typesOf(schema);
  const v = opts.coerce ? coerce(types, raw) : raw;

  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    let firstErrors = null;
    for (const sub of schema.anyOf) {
      const subErrors = [];
      const out = check(sub, v, path, subErrors, opts);
      if (!subErrors.length) return out;
      if (!firstErrors) firstErrors = subErrors;
    }
    errors.push(`${path} matches none of the allowed shapes (${(firstErrors || []).join('; ')})`);
    return undefined;
  }

  if (types) {
    const actual = typeOf(v);
    if (!types.some((t) => matchesType(t, actual))) {
      errors.push(`${path} must be ${types.join(' or ')}`);
      return undefined;
    }
  }
  if (v === null) return v;
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) {
    errors.push(`${path} must be ${JSON.stringify(schema.const)}`);
    return undefined;
  }
  if (schema.enum && !schema.enum.includes(v)) { errors.push(`${path} must be one of ${schema.enum.join(', ')}`); return undefined; }
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength} characters`);
    if (schema.pattern !== undefined) {
      let re;
      try { re = new RegExp(schema.pattern, 'u'); } catch { re = null; }
      if (re && !re.test(v)) errors.push(`${path} does not match ${schema.pattern}`);
    }
    if (schema.format === 'uuid' && !UUID_RE.test(v)) errors.push(`${path} must be an id from a tool result`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(v))) errors.push(`${path} must be an ISO 8601 date-time`);
    if (schema.format === 'date' && (!DATE_RE.test(v) || Number.isNaN(Date.parse(v)))) errors.push(`${path} must be a date (YYYY-MM-DD)`);
    if (schema.format === 'email' && !EMAIL_RE.test(v)) errors.push(`${path} must be an email address`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path} must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path} must be ≤ ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) errors.push(`${path} must be > ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) errors.push(`${path} must be < ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(v)) {
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errors.push(`${path} has more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && v.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    return schema.items ? v.map((item, i) => check(schema.items, item, `${path}[${i}]`, errors, opts)) : v;
  }
  const isObject = v && typeof v === 'object';
  if (isObject && (types?.includes('object') || schema.properties)) {
    const out = {};
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      const missing = v[key] === undefined || (opts.emptyIsMissing && (v[key] === null || v[key] === ''));
      if (missing) errors.push(`${join(path, key)} is required`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (v[key] === undefined || (opts.emptyIsMissing && v[key] === null)) {
        if (sub && sub.default !== undefined) out[key] = sub.default;
        continue;
      }
      const res = check(sub, v[key], join(path, key), errors, opts);
      if (res !== undefined) out[key] = res;
    }
    const extra = Object.keys(v).filter((k) => !(k in props));
    const ap = schema.additionalProperties;
    for (const key of extra) {
      if (opts.dropUnknown) continue;
      if (ap === false) errors.push(`${join(path, key)} is not an allowed property`);
      else if (ap && typeof ap === 'object') {
        const res = check(ap, v[key], join(path, key), errors, opts);
        if (res !== undefined) out[key] = res;
      } else out[key] = v[key];
    }
    return out;
  }
  return v;
}

/**
 * Validate a value against a JSON schema.
 * @param {object} schema
 * @param {any} value
 * @param {{ coerce?: boolean, dropUnknown?: boolean }} [opts]
 * @returns {{ ok: true, value: any } | { ok: false, errors: string[] }}
 */
export function validateSchema(schema, value, { coerce: doCoerce = false, dropUnknown = false } = {}) {
  const errors = [];
  const out = check(schema, value, '$', errors, { coerce: doCoerce, dropUnknown, emptyIsMissing: false });
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
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
  const value = check(schema || { type: 'object', properties: {} }, args ?? {}, '$', errors, { coerce: true, dropUnknown: true, emptyIsMissing: true });
  return errors.length ? { ok: false, errors } : { ok: true, value: value ?? {} };
}
