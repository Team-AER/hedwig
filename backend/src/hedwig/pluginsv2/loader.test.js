import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, cp, mkdir, writeFile, rm, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createFakeDb } from './fakeDb.testutil.js';

const fake = createFakeDb();
vi.mock('../../services/db.js', () => ({ query: (...a) => fake.query(...a), pool: {} }));

const { PluginRuntime, parseGitLocation } = await import('./loader.js');
const { createPluginRegistry } = await import('../../plugins/registry.js');
const { invalidateAccess } = await import('./access.js');
const { userRoutes } = await import('./routes.js');
const { HEDWIG_HOOKS } = await import('../hooks.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, '../../../../examples/plugins/hello-hedwig');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

const manifestFor = (id, extra = {}) => JSON.stringify({
  id, name: id, version: '1.0.0', api: '^1.0.0', tier: 2, description: 'test', author: 'test',
  backend: './index.js', permissions: [{ name: 'storage', reason: 'r' }], ...extra,
});

let dir;
let registry;
let runtime;
const registerTool = vi.fn();
const unregisterPluginTools = vi.fn();

async function writePlugin(id, files, extra) {
  await mkdir(join(dir, id), { recursive: true });
  await writeFile(join(dir, id, 'hedwig.plugin.json'), manifestFor(id, extra));
  for (const [name, src] of Object.entries(files)) await writeFile(join(dir, id, name), src);
}

function newRuntime() {
  return new PluginRuntime({ registry: createPluginRegistry(), pluginsDir: dir, bundled: [], processKind: 'api', registerTool, unregisterPluginTools });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hedwig-plugins-'));
  await cp(EXAMPLE, join(dir, 'hello-hedwig'), { recursive: true });
  await writePlugin('broken-plugin', { 'index.js': 'export default function activate() { throw new Error("boom on load"); }\n' });
  await writePlugin('sneaky-plugin', { 'index.js': 'import fs from "node:fs";\nexport default () => ({ hooks: {} , x: fs });\n' });
  await writePlugin('greedy-plugin', { 'index.js': 'export default () => { const k = process.env.DATABASE_URL; return {}; };\n' });
  await mkdir(join(dir, 'garbled'));
  await writeFile(join(dir, 'garbled', 'hedwig.plugin.json'), '{ not json');
  await writePlugin('wrong-name-dir', { 'index.js': 'export default () => ({});\n' });
  await writeFile(join(dir, 'wrong-name-dir', 'hedwig.plugin.json'), manifestFor('some-other-id'));
});

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  fake.reset();
  invalidateAccess();
  registerTool.mockClear();
  unregisterPluginTools.mockClear();
  registry = createPluginRegistry();
  runtime = new PluginRuntime({ registry, pluginsDir: dir, bundled: [], processKind: 'api', registerTool, unregisterPluginTools });
});

describe('loading external plugins', () => {
  it('loads the example plugin and records broken ones as errors without throwing', async () => {
    await expect(runtime.loadAll()).resolves.toBeTruthy();
    const hello = runtime.get('hello-hedwig');
    expect(hello.status).toBe('loaded');
    expect(hello.tier).toBe(2);
    expect(hello.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.get('broken-plugin')).toMatchObject({ status: 'error', error: expect.stringMatching(/boom on load/) });
    expect(runtime.get('sneaky-plugin')).toMatchObject({ status: 'error', error: expect.stringMatching(/node:fs/) });
    expect(runtime.get('greedy-plugin')).toMatchObject({ status: 'error', error: expect.stringMatching(/process/) });
    expect(runtime.get('garbled')).toMatchObject({ status: 'error', error: expect.stringMatching(/invalid JSON/) });
    expect(runtime.get('some-other-id') || runtime.get('wrong-name-dir')).toMatchObject({ status: 'error', error: expect.stringMatching(/must equal the plugin id/) });
    // Pinned in hedwig_plugins on first sight.
    expect(fake.state.plugins.get('hello-hedwig')).toMatchObject({ source: 'dir', status: 'installed', sha256: hello.sha256 });
  });

  it('registers a shim upstream and its agent tool with the plugin id and permission', async () => {
    await runtime.loadAll();
    expect(registry.has('hello-hedwig')).toBe(true);
    expect(registry.get('hello-hedwig').name).toBe('Hello Hedwig');
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'hello_hedwig__say_hello', pluginId: 'hello-hedwig', permission: 'agent.tools' }));
  });

  it('fires hooks only for users who activated the plugin and granted the hook permission', async () => {
    await runtime.loadAll();
    const ctx = { userId: ALICE, messageId: MSG, accountId: MSG };
    await registry.runHook(HEDWIG_HOOKS.onMessageIndexed, ctx);
    expect(fake.state.pluginData.size).toBe(0); // not activated
    fake.grant(ALICE, 'hello-hedwig', ['storage'], true);
    invalidateAccess();
    await registry.runHook(HEDWIG_HOOKS.onMessageIndexed, ctx);
    expect(fake.state.pluginData.size).toBe(0); // mail.read not granted
    fake.grant(ALICE, 'hello-hedwig', ['storage', 'mail.read'], true);
    invalidateAccess();
    await registry.runHook(HEDWIG_HOOKS.onMessageIndexed, ctx);
    await registry.runHook(HEDWIG_HOOKS.onMessageIndexed, ctx);
    expect(fake.state.pluginData.get(`hello-hedwig|u:${ALICE}:indexed`).value.v).toBe(2);
    // Another user's event never touches Alice's data, and without activation does nothing.
    await registry.runHook(HEDWIG_HOOKS.onMessageIndexed, { ...ctx, userId: BOB });
    expect([...fake.state.pluginData.keys()]).toEqual([`hello-hedwig|u:${ALICE}:indexed`]);
  });

  it('refuses files that changed after install until an admin reloads', async () => {
    await runtime.loadAll();
    const pinned = runtime.get('hello-hedwig').sha256;
    await appendFile(join(dir, 'hello-hedwig', 'backend', 'greet.js'), '\n// tampered\n');
    try {
      const again = newRuntime();
      await again.loadAll();
      expect(again.get('hello-hedwig')).toMatchObject({ status: 'error', error: expect.stringMatching(/files changed since install/) });
      expect(fake.state.plugins.get('hello-hedwig').sha256).toBe(pinned); // a failed load never re-pins
      await again.reload('hello-hedwig');
      expect(again.get('hello-hedwig').status).toBe('loaded');
      expect(fake.state.plugins.get('hello-hedwig').sha256).not.toBe(pinned);
    } finally {
      await cp(join(EXAMPLE, 'backend', 'greet.js'), join(dir, 'hello-hedwig', 'backend', 'greet.js'));
    }
  });

  it('uninstall removes plugin data, grants and the upstream hooks', async () => {
    await runtime.loadAll();
    fake.grant(ALICE, 'hello-hedwig', ['storage', 'mail.read'], true);
    invalidateAccess();
    await registry.runHook(HEDWIG_HOOKS.onMessageIndexed, { userId: ALICE, messageId: MSG });
    expect(fake.state.pluginData.size).toBe(1);
    await runtime.uninstall('hello-hedwig');
    expect(runtime.get('hello-hedwig')).toBeNull();
    expect(fake.state.pluginData.size).toBe(0);
    expect(fake.state.access.has(`${ALICE}|hello-hedwig`)).toBe(false);
    expect(fake.state.plugins.has('hello-hedwig')).toBe(false);
    expect(Object.keys(registry.get('hello-hedwig').hooks)).toEqual([]);
    expect(unregisterPluginTools).toHaveBeenCalledWith('hello-hedwig');
  });
});

describe('admin installs', () => {
  it('accepts only https git URLs without credentials, queries or option-like refs', () => {
    expect(parseGitLocation('https://github.com/acme/hedwig-weather.git#v1.2.0')).toEqual({ url: 'https://github.com/acme/hedwig-weather.git', branch: 'v1.2.0' });
    for (const bad of ['http://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://github.com/a/b', 'file:///etc', 'https://user:pw@github.com/a/b.git', 'https://github.com/a/b.git?x=1']) {
      expect(() => parseGitLocation(bad), bad).toThrow();
    }
    expect(() => parseGitLocation('https://github.com/a/b.git#--upload-pack=evil')).toThrow(/invalid git ref/);
    expect(() => parseGitLocation('https://github.com/a/b.git', '../../x')).toThrow(/invalid git ref/);
  });

  it('installs a directory only from directly inside plugins.dir', async () => {
    await expect(runtime.install({ source: 'dir', location: '/etc' })).rejects.toThrow(/direct subdirectory/);
    await expect(runtime.install({ source: 'dir', location: '../' })).rejects.toThrow(/direct subdirectory/);
    await expect(runtime.install({ source: 'ftp', location: 'x' })).rejects.toThrow(/source must be/);
    const entry = await runtime.install({ source: 'dir', location: 'hello-hedwig', installedBy: ALICE });
    expect(entry.status).toBe('loaded');
    expect(fake.state.plugins.get('hello-hedwig')).toMatchObject({ source: 'dir', installed_by: ALICE });
  });
});

describe('plugin routes', () => {
  let server;
  let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: req.headers['x-user'] }; next(); });
    const r = express.Router();
    userRoutes(r, { get: (id) => runtime.get(id), list: () => runtime.list() });
    app.use('/api/hedwig', r);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/hedwig`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  const call = (path, { user = ALICE, method = 'GET', body } = {}) => fetch(base + path, {
    method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });

  it('gates plugin routes, frontend bundles and enabling on activation and grants', async () => {
    await runtime.loadAll();
    fake.state.users.add(ALICE);
    expect((await call('/p/hello-hedwig/hello')).status).toBe(403);
    expect((await call('/plugins/hello-hedwig/frontend.js')).status).toBe(404);

    const list = await (await call('/plugins')).json();
    const info = list.find((p) => p.id === 'hello-hedwig');
    expect(info).toMatchObject({ activated: false, tier: 2, hasFrontend: true, status: 'loaded', views: ['hello-hedwig.panel'], tools: ['hello_hedwig__say_hello'] });
    expect(list.find((p) => p.id === 'broken-plugin')).toMatchObject({ status: 'error' });

    const missing = await call('/plugins/hello-hedwig/enable', { method: 'POST', body: { grants: ['storage'] } });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatch(/required permissions not granted: mail.read, views/);
    const unknown = await call('/plugins/hello-hedwig/enable', { method: 'POST', body: { grants: ['storage', 'mail.read', 'views', 'mail.write'] } });
    expect(unknown.status).toBe(400);

    const enabled = await call('/plugins/hello-hedwig/enable', { method: 'POST', body: { grants: ['storage', 'mail.read', 'views'] } });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ activated: true, activationKey: 'hello-hedwig' });

    const hello = await call('/p/hello-hedwig/hello');
    expect(hello.status).toBe(200);
    expect(hello.headers.get('x-content-type-options')).toBe('nosniff');
    expect(hello.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(await hello.json()).toMatchObject({ count: 0, message: expect.stringMatching(/^Hello!/) });
    expect((await call('/p/hello-hedwig/nope')).status).toBe(404);

    const js = await call('/plugins/hello-hedwig/frontend.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/^application\/javascript/);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await js.text()).toMatch(/window\.hedwig/);

    // Bob never activated it.
    fake.state.users.add(BOB);
    expect((await call('/p/hello-hedwig/hello', { user: BOB })).status).toBe(403);

    const put = await call('/plugins/hello-hedwig/settings', { method: 'PUT', body: { greeting: 'Ahoy' } });
    expect(await put.json()).toEqual({ greeting: 'Ahoy' });
    expect((await (await call('/p/hello-hedwig/hello')).json()).message).toMatch(/^Ahoy!/);

    const disabled = await call('/plugins/hello-hedwig/disable', { method: 'POST' });
    expect(await disabled.json()).toMatchObject({ activated: false });
    expect(fake.state.access.get(`${ALICE}|hello-hedwig`).grants).toEqual([]);
    expect((await call('/p/hello-hedwig/hello')).status).toBe(403);
  });
});
