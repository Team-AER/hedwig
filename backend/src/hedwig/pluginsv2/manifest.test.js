import { describe, it, expect } from 'vitest';
import { validateManifest, satisfies, parseRange, upstreamIdFor, toolPrefix, coerceSettingValue, HEDWIG_PLUGIN_API } from './manifest.js';
import { ManifestError } from './errors.js';
import { BUNDLED } from './bundled.js';

const base = () => ({
  id: 'acme.hello',
  name: 'Hello',
  version: '1.2.3',
  api: '^1.0.0',
  tier: 2,
  description: 'Says hello',
  author: 'Acme',
  backend: './backend/index.js',
  permissions: [{ name: 'storage', reason: 'keep a counter' }],
});

function errorsOf(raw, opts) {
  try { validateManifest(raw, opts); return []; } catch (err) {
    expect(err).toBeInstanceOf(ManifestError);
    return err.errors;
  }
}

describe('manifest validation', () => {
  it('accepts a minimal valid manifest and freezes the result', () => {
    const m = validateManifest(base(), { tier: 2 });
    expect(m.id).toBe('acme.hello');
    expect(m.permissions).toEqual([{ name: 'storage', optional: false, reason: 'keep a counter' }]);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.permissions[0])).toBe(true);
  });

  it('accepts every bundled first-party manifest as tier 1', () => {
    for (const b of BUNDLED) expect(() => validateManifest(b.manifest, { tier: 1 })).not.toThrow();
  });

  it('rejects bad ids, unknown keys and missing fields, reporting all problems at once', () => {
    const errs = errorsOf({ ...base(), id: 'Acme_Hello', extra: 1, name: '', reason: undefined });
    expect(errs.some((e) => e.startsWith('id must match'))).toBe(true);
    expect(errs).toContain('unknown key "extra"');
    expect(errs).toContain('unknown key "reason"');
    expect(errs).toContain('name must not be empty');
    expect(errorsOf({ ...base(), id: 'acme..hello' })[0]).toMatch(/must not contain/);
  });

  it('rejects unknown permissions, missing reasons and duplicates', () => {
    const errs = errorsOf({ ...base(), permissions: [{ name: 'mail.send', reason: 'x' }, { name: 'storage' }, { name: 'storage', reason: 'y' }] });
    expect(errs.join('\n')).toMatch(/unknown permission "mail.send"/);
    expect(errs.join('\n')).toMatch(/permissions\[1\]\.reason is required/);
    expect(errs.join('\n')).toMatch(/declared twice/);
  });

  it('requires a hook\'s permission to be declared', () => {
    expect(errorsOf({ ...base(), hooks: ['beforeSend'] }).join()).toMatch(/"beforeSend" needs the "mail.read" permission/);
    expect(errorsOf({ ...base(), hooks: ['onEverything'] }).join()).toMatch(/unknown hook/);
  });

  it('ties net hosts to net: permissions both ways', () => {
    expect(errorsOf({ ...base(), net: ['api.example.com'] }).join()).toMatch(/needs a matching "net:api.example.com" permission/);
    expect(errorsOf({ ...base(), permissions: [...base().permissions, { name: 'net:api.example.com', reason: 'x' }] }).join()).toMatch(/no matching entry in net/);
    expect(errorsOf({ ...base(), net: ['https://api.example.com'], permissions: [...base().permissions, { name: 'net:https://api.example.com', reason: 'x' }] }).join()).toMatch(/not a hostname/);
    const ok = validateManifest({
      ...base(),
      net: ['api.example.com', '$settings.server'],
      permissions: [...base().permissions, { name: 'net:api.example.com', reason: 'x' }, { name: 'net:$settings.server', reason: 'y' }],
      settings: { type: 'object', properties: { server: { type: 'string', format: 'url', default: 'https://x.example.com' } } },
    });
    expect(ok.net).toEqual(['api.example.com', '$settings.server']);
  });

  it('refuses a settings reference to a non-url setting', () => {
    const errs = errorsOf({
      ...base(), net: ['$settings.name'], permissions: [...base().permissions, { name: 'net:$settings.name', reason: 'x' }],
      settings: { type: 'object', properties: { name: { type: 'string' } } },
    });
    expect(errs.join()).toMatch(/must reference a string setting with format "url"/);
  });

  it('checks the API range against this server and the declared tier', () => {
    expect(errorsOf({ ...base(), api: '^2.0.0' }).join()).toMatch(`this server provides ${HEDWIG_PLUGIN_API}`);
    expect(errorsOf({ ...base(), api: 'banana' }).join()).toMatch(/semver range/);
    expect(errorsOf(base(), { tier: 1 }).join()).toMatch(/bundled plugins must declare tier 1/);
    expect(errorsOf({ ...base(), tier: 1 }, { tier: 2 }).join()).toMatch(/external plugins must declare tier 2/);
  });

  it('rejects entry paths that leave the plugin directory', () => {
    expect(errorsOf({ ...base(), backend: '../core.js' }).join()).toMatch(/relative path/);
    expect(errorsOf({ ...base(), backend: '/etc/x.js' }).join()).toMatch(/relative path/);
    expect(errorsOf({ ...base(), frontend: './a/../../b.js' }).join()).toMatch(/relative path/);
  });

  it('validates settings schemas and their defaults', () => {
    const errs = errorsOf({ ...base(), settings: { type: 'object', properties: { n: { type: 'integer', default: 1.5 }, bad: { type: 'date' } } } });
    expect(errs.join()).toMatch(/n.default does not match/);
    expect(errs.join()).toMatch(/bad.type must be one of/);
  });

  it('requires views and commands to be namespaced and to declare the views permission', () => {
    const errs = errorsOf({ ...base(), views: ['other.view'] });
    expect(errs.join()).toMatch(/must start with "acme.hello."/);
    expect(errs.join()).toMatch(/requires the "views" permission/);
  });
});

describe('semver', () => {
  it('handles caret, tilde, x-ranges, comparators and ||', () => {
    expect(satisfies('1.0.0', '^1.0.0')).toBe(true);
    expect(satisfies('1.9.3', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('0.2.5', '^0.2.1')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.4.0', '1.x')).toBe(true);
    expect(satisfies('1.0.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('1.0.0', '>= 2.0.0 || 1.0.0')).toBe(true);
    expect(satisfies('1.0.0-beta.1', '>=1.0.0')).toBe(false);
    expect(parseRange('not a range')).toBeNull();
  });
});

describe('ids and settings values', () => {
  it('maps ids for upstream registration and tool names', () => {
    expect(upstreamIdFor('aer.receipts')).toBe('aer-receipts');
    expect(toolPrefix('aer.hello-world')).toBe('aer_hello_world__');
  });
  it('coerces settings values strictly', () => {
    expect(coerceSettingValue({ type: 'integer', minimum: 0, maximum: 23 }, '7')).toBe(7);
    expect(coerceSettingValue({ type: 'integer', minimum: 0, maximum: 23 }, 24)).toBeUndefined();
    expect(coerceSettingValue({ type: 'string', format: 'url' }, 'javascript:alert(1)')).toBeUndefined();
    expect(coerceSettingValue({ type: 'string', format: 'url' }, 'https://user:pw@x.example.com')).toBeUndefined();
    expect(coerceSettingValue({ type: 'string', enum: ['off', 'warn'] }, 'block')).toBeUndefined();
    expect(coerceSettingValue({ type: 'boolean' }, 'true')).toBe(true);
  });
});
