// Plugins v2 against the dev database (seeded demo user). Run with:
//   set -a && . ./.env.hedwig-dev && set +a && HEDWIG_IT=1 npx vitest run src/hedwig/pluginsv2
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, cp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const IT = Boolean(process.env.HEDWIG_IT);

describe.skipIf(!IT)('plugins v2 (integration)', () => {
  let db; let runtime; let registry; let access; let userId; let dir; let HEDWIG_HOOKS;

  beforeAll(async () => {
    db = await import('../../services/db.js');
    const { runHedwigMigrations } = await import('../migrate.js');
    await runHedwigMigrations();
    const { PluginRuntime } = await import('./loader.js');
    const { createPluginRegistry } = await import('../../plugins/registry.js');
    const { BUNDLED } = await import('./bundled.js');
    access = await import('./access.js');
    ({ HEDWIG_HOOKS } = await import('../hooks.js'));
    const { rows } = await db.query("SELECT id FROM users WHERE username = 'demo'");
    if (!rows[0]) throw new Error('seed the dev DB first: node scripts/hedwig-seed.mjs');
    userId = rows[0].id;
    dir = await mkdtemp(join(tmpdir(), 'hedwig-it-plugins-'));
    await cp(join(dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/hello-hedwig'), join(dir, 'hello-hedwig'), { recursive: true });
    registry = createPluginRegistry();
    runtime = new PluginRuntime({ registry, bundled: BUNDLED, pluginsDir: dir, processKind: 'api', registerTool: () => {}, unregisterPluginTools: () => {} });
    await db.query("DELETE FROM hedwig_plugins WHERE id = 'hello-hedwig'");
    await runtime.loadAll();
  });

  afterAll(async () => {
    if (!IT) return;
    for (const id of ['aer.receipts', 'aer.digest', 'aer.pensieve', 'aer.sendguard']) {
      await access.setActivated(userId, id, false).catch(() => {});
      await access.setGrants(userId, id, []).catch(() => {});
      await db.query('DELETE FROM plugin_data WHERE plugin_id = $1 AND owner_id = $2', [id, userId]);
    }
    await runtime.uninstall('hello-hedwig').catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await db.pool.end();
  });

  it('loads every first-party plugin and the example external plugin', () => {
    for (const id of ['aer.receipts', 'aer.digest', 'aer.pensieve', 'aer.sendguard', 'hello-hedwig']) {
      expect(runtime.get(id), id).toMatchObject({ status: 'loaded' });
    }
  });

  it('records the external plugin with its pinned sha256', async () => {
    const { rows } = await db.query("SELECT source, sha256, status FROM hedwig_plugins WHERE id = 'hello-hedwig'");
    expect(rows[0]).toMatchObject({ source: 'dir', status: 'installed', sha256: runtime.get('hello-hedwig').sha256 });
  });

  it('enforces activation and grants against the real tables', async () => {
    const hedwig = runtime.get('aer.receipts').facade;
    await access.setActivated(userId, 'aer.receipts', false);
    await expect(hedwig.mail.search(userId, { limit: 1 })).rejects.toThrow(/not activated/);
    await access.setGrants(userId, 'aer.receipts', ['storage', 'views']);
    await access.setActivated(userId, 'aer.receipts', true);
    await expect(hedwig.mail.search(userId, { limit: 1 })).rejects.toThrow(/mail.read was not granted/);
    await access.setGrants(userId, 'aer.receipts', ['mail.read', 'storage', 'views']);
    const found = await hedwig.mail.search(userId, { q: 'Uber', limit: 5 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).not.toHaveProperty('uid');
    await hedwig.storage.set(userId, 'it-probe', { ok: true });
    expect(await hedwig.storage.get(userId, 'it-probe')).toEqual({ ok: true });
  });

  it('turns a seeded receipt into a ledger entry through the onMessageIndexed hook', async () => {
    await access.setGrants(userId, 'aer.receipts', ['mail.read', 'storage', 'views']);
    await access.setActivated(userId, 'aer.receipts', true);
    const hedwig = runtime.get('aer.receipts').facade;
    const [uber] = await hedwig.mail.search(userId, { q: 'Uber', limit: 1 });
    await registry.runHook(HEDWIG_HOOKS.onMessageIndexed, { userId, messageId: uber.id, accountId: uber.account_id });
    const rec = await hedwig.storage.get(userId, `r:${uber.id}`);
    expect(rec).toMatchObject({ amount: 23.4, currency: 'GBP', source: 'rules' });
  });
});
