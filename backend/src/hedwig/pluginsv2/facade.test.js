import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './fakeDb.testutil.js';

const fake = createFakeDb();
vi.mock('../../services/db.js', () => ({ query: (...a) => fake.query(...a), pool: {} }));
vi.mock('../../services/safeFetch.js', () => ({
  safeFetch: vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })),
}));

const { createFacade } = await import('./facade.js');
const { validateManifest } = await import('./manifest.js');
const { invalidateAccess } = await import('./access.js');
const { PermissionError } = await import('./errors.js');
const { safeFetch } = await import('../../services/safeFetch.js');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const manifest = validateManifest({
  id: 'acme.test',
  name: 'Test',
  version: '1.0.0',
  api: '^1.0.0',
  tier: 2,
  description: 'test plugin',
  author: 'Acme',
  permissions: [
    { name: 'storage', reason: 'r' },
    { name: 'mail.read', reason: 'r' },
    { name: 'net:api.example.com', reason: 'r' },
    { name: 'net:$settings.server', optional: true, reason: 'r' },
  ],
  net: ['api.example.com', '$settings.server'],
  settings: {
    type: 'object',
    properties: {
      server: { type: 'string', format: 'url', default: 'https://self.example.org' },
      token: { type: 'string', secret: true, default: '' },
    },
  },
}, { tier: 2 });

const plugin = { id: manifest.id, upstreamId: 'acme-test', manifest, tier: 2 };
const rt = { mailAction: vi.fn(async () => ({ ok: true })), broadcast: vi.fn(() => true), jobNames: () => new Set() };
const hedwig = createFacade(plugin, rt);

beforeEach(() => {
  fake.reset();
  invalidateAccess();
  process.env.ENCRYPTION_KEY = '0'.repeat(63) + '1';
});

describe('permission enforcement', () => {
  it('denies every capability when the user has not activated the plugin', async () => {
    fake.grant(ALICE, manifest.id, ['storage'], false);
    await expect(hedwig.storage.get(ALICE, 'k')).rejects.toBeInstanceOf(PermissionError);
    await expect(hedwig.storage.get(ALICE, 'k')).rejects.toThrow(/not activated/);
  });

  it('denies a declared permission the user did not grant', async () => {
    fake.grant(ALICE, manifest.id, ['storage'], true);
    await expect(hedwig.mail.search(ALICE, {})).rejects.toThrow(/mail.read was not granted/);
  });

  it('allows a capability once granted, and stores per user', async () => {
    fake.grant(ALICE, manifest.id, ['storage'], true);
    await hedwig.storage.set(ALICE, 'counter', 3);
    expect(await hedwig.storage.get(ALICE, 'counter')).toBe(3);
    // The row is namespaced by user and owned by the user (cascade-deleted with them).
    const [key, row] = [...fake.state.pluginData.entries()][0];
    expect(key).toBe(`acme.test|u:${ALICE}:counter`);
    expect(row.owner_id).toBe(ALICE);
  });

  it('is per user: a grant for one user does not reach another user\'s data', async () => {
    fake.grant(ALICE, manifest.id, ['storage'], true);
    fake.grant(BOB, manifest.id, ['storage'], true);
    await hedwig.storage.set(ALICE, 'secret', 'alice-only');
    expect(await hedwig.storage.get(BOB, 'secret')).toBeNull();
    expect(await hedwig.storage.list(BOB, {})).toEqual([]);
    expect((await hedwig.storage.list(ALICE, {})).map((r) => r.key)).toEqual(['secret']);
    fake.grant(BOB, manifest.id, [], true);
    invalidateAccess();
    await expect(hedwig.storage.get(BOB, 'secret')).rejects.toBeInstanceOf(PermissionError);
  });

  it('rejects calls without a real user id', async () => {
    await expect(hedwig.storage.get(undefined, 'k')).rejects.toThrow(/acting userId/);
    await expect(hedwig.storage.get('alice', 'k')).rejects.toThrow(/acting userId/);
  });

  it('never allows a permission the manifest does not declare, even with a grant row', async () => {
    fake.grant(ALICE, manifest.id, ['storage', 'compose.draft'], true);
    await expect(hedwig.compose.createDraft(ALICE, { to: ['a@b.c'] })).rejects.toThrow(/not declared in the manifest/);
    expect(rt.mailAction).not.toHaveBeenCalled();
  });

  it('rejects storage keys outside the allowed alphabet', async () => {
    fake.grant(ALICE, manifest.id, ['storage'], true);
    await expect(hedwig.storage.set(ALICE, '../x y', 1)).rejects.toThrow(/storage key/);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(hedwig)).toBe(true);
    expect(Object.isFrozen(hedwig.storage)).toBe(true);
    expect(() => { hedwig.storage.get = async () => 'x'; }).toThrow();
  });
});

describe('net.fetch', () => {
  it('refuses hosts that are not in the manifest', async () => {
    fake.grant(ALICE, manifest.id, ['net:api.example.com'], true);
    await expect(hedwig.net.fetch(ALICE, 'https://evil.example.net/x')).rejects.toThrow(/not declared/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('needs the per-host grant', async () => {
    fake.grant(ALICE, manifest.id, [], true);
    await expect(hedwig.net.fetch(ALICE, 'https://api.example.com/x')).rejects.toThrow(/net:api.example.com was not granted/);
  });

  it('fetches a granted host without following redirects', async () => {
    fake.grant(ALICE, manifest.id, ['net:api.example.com'], true);
    const res = await hedwig.net.fetch(ALICE, 'https://api.example.com/x', { method: 'POST', body: { a: 1 }, headers: { Cookie: 'x', 'X-Key': 'k' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [, init] = safeFetch.mock.calls.at(-1);
    expect(init.redirect).toBe('manual');
    expect(init.headers.cookie).toBeUndefined();
    expect(init.headers['x-key']).toBe('k');
    expect(init.body).toBe('{"a":1}');
  });

  it('resolves $settings hosts from the user\'s own settings', async () => {
    fake.grant(ALICE, manifest.id, ['storage', 'net:$settings.server'], true);
    await expect(hedwig.net.fetch(ALICE, 'https://self.example.org/api')).resolves.toMatchObject({ status: 200 });
    await hedwig.settings.set(ALICE, { server: 'https://other.example.org' });
    await expect(hedwig.net.fetch(ALICE, 'https://self.example.org/api')).rejects.toThrow(/not declared/);
    await expect(hedwig.net.fetch(ALICE, 'https://other.example.org/api')).resolves.toMatchObject({ status: 200 });
  });
});

describe('settings', () => {
  it('validates, encrypts secrets at rest and merges defaults', async () => {
    fake.grant(ALICE, manifest.id, [], true);
    await expect(hedwig.settings.set(ALICE, { server: 'ftp://x' })).rejects.toThrow(/invalid value for server/);
    await expect(hedwig.settings.set(ALICE, { nope: 1 })).rejects.toThrow(/unknown setting nope/);
    const out = await hedwig.settings.set(ALICE, { token: 's3cret' });
    expect(out).toEqual({ server: 'https://self.example.org', token: 's3cret' });
    const stored = fake.state.pluginData.get(`acme.test|s:${ALICE}`).value.v;
    expect(stored.token).toMatch(/^enc:v1:/);
  });
});
