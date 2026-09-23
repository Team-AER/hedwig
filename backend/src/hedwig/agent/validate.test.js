import { describe, it, expect } from 'vitest';
import { validateSchema, validateArgs } from './validate.js';

const schema = {
  type: 'object',
  required: ['stream', 'confidence', 'tags'],
  additionalProperties: false,
  properties: {
    stream: { type: 'string', enum: ['people', 'reading', 'records'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: ['string', 'null'], minLength: 3, maxLength: 10 },
    count: { type: 'integer', exclusiveMinimum: 0 },
    tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', pattern: '^[a-z]+$' } },
    meta: { type: 'object', additionalProperties: { type: 'number' } },
    when: { type: 'string', format: 'date' },
    kind: { const: 'mail' },
    either: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['n/a'] }] },
  },
};

describe('validateSchema', () => {
  it('accepts a valid value, allows null through a type array, and applies no coercion by default', () => {
    const v = { stream: 'people', confidence: 0.5, reason: null, tags: ['a'], meta: { x: 1 }, when: '2026-09-23', kind: 'mail', either: 'n/a' };
    expect(validateSchema(schema, v)).toEqual({ ok: true, value: v });
    expect(validateSchema(schema, { ...v, confidence: '0.5' }).ok).toBe(false);
  });

  it('reports every problem with a path', () => {
    const r = validateSchema(schema, {
      stream: 'spam', reason: 'no', count: 0, tags: ['UP', 'b', 'c'], meta: { x: 'y' }, when: '23/09/2026', kind: 'x', either: 1.5, extra: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      'confidence is required',
      'stream must be one of people, reading, records',
      'reason is too short',
      'count must be > 0',
      'tags has more than 2 items',
      'tags[0] does not match ^[a-z]+$',
      'meta.x must be number',
      'when must be a date (YYYY-MM-DD)',
      'kind must be "mail"',
      'extra is not an allowed property',
    ]));
    expect(r.errors.find((e) => e.startsWith('either matches none'))).toBeTruthy();
  });

  it('coerces and drops unknown properties when asked (prompt outputs)', () => {
    const r = validateSchema(schema, { stream: 'reading', confidence: '1', tags: 'solo', extra: true }, { coerce: true, dropUnknown: true });
    expect(r).toEqual({ ok: true, value: { stream: 'reading', confidence: 1, tags: ['solo'] } });
  });

  it('handles nested arrays of objects and top-level type errors', () => {
    const s = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } };
    expect(validateSchema(s, { items: [{ id: 'a' }, {}] }).errors).toEqual(['items[1].id is required']);
    expect(validateSchema(s, []).errors).toEqual(['$ must be object']);
    expect(validateSchema({ type: ['integer', 'null'], maximum: 3 }, 4).errors).toEqual(['$ must be ≤ 3']);
  });
});

describe('validateArgs (tool arguments) keeps its lenient behaviour', () => {
  it('treats empty strings as missing, coerces, drops unknowns and applies defaults', () => {
    const s = { type: 'object', required: ['q'], properties: { q: { type: 'string' }, n: { type: 'integer', default: 5 } } };
    expect(validateArgs(s, { q: '' })).toEqual({ ok: false, errors: ['q is required'] });
    expect(validateArgs(s, { q: 'x', junk: 1 })).toEqual({ ok: true, value: { q: 'x', n: 5 } });
    expect(validateArgs(s, { q: 7, n: '3' })).toEqual({ ok: true, value: { q: '7', n: 3 } });
  });
});
