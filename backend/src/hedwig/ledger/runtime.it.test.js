// Integration: the job ledger, provenance columns and corrections against the dev database.
//   cd backend && set -a && . ./.env.hedwig-dev && set +a && node scripts/hedwig-migrate.mjs
//   HEDWIG_IT=1 npx vitest run src/hedwig/ledger
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mockGateway } from '../testing/mockGateway.js';

const probe = { ok: true, error: null };
vi.mock('../llm.js', async (importOriginal) => ({ ...(await importOriginal()), probeGateway: async () => ({ ...probe }) }));

describe.skipIf(!process.env.HEDWIG_IT)('runtime against the dev database', () => {
  const K = `it.rt${Date.now().toString(36)}`;
  let query; let pool; let jobs; let userId = null;

  beforeAll(async () => {
    ({ query, pool } = await import('../../services/db.js'));
    jobs = await import('../jobs.js');
    const { rows } = await query("SELECT id FROM users WHERE username = 'demo'");
    userId = rows[0]?.id || null;
  });

  afterAll(async () => {
    await query('DELETE FROM hedwig_jobs WHERE kind LIKE $1', [`${K}%`]);
    await query("DELETE FROM hedwig_ai_calls WHERE workflow LIKE 'it.runtime%'");
    if (userId) await query("DELETE FROM hedwig_corrections WHERE user_id = $1 AND note LIKE 'it.runtime%'", [userId]);
    await pool.end();
  });

  async function runAll() {
    for (const j of await jobs.claim(20)) await jobs.runJob(j);
  }
  const row = async (id) => (await query('SELECT * FROM hedwig_jobs WHERE id = $1', [id])).rows[0];

  it('walks the ledger states with the real SQL', async () => {
    let broken = true;
    let wanted = [{ n: 2 }, { n: 3 }];
    jobs.defineJob(`${K}.a`, async (p) => {
      if (broken) throw Object.assign(new Error(`broken ${p.n}`), { permanent: true });
      return p.n === 3 ? { status: 'partial', note: 'half' } : undefined;
    }, { rebuild: async () => wanted, timeoutMs: 5000 });
    const j1 = await jobs.enqueue(`${K}.a`, { n: 1 }, { userId });
    const j2 = await jobs.enqueue(`${K}.a`, { n: 2 }, { userId, dedupeKey: `${K}:2` });
    await runAll();
    expect((await row(j1)).status).toBe('failed');
    expect((await jobs.listFailed({ kind: `${K}.a` })).map((r) => r.last_error).sort()).toEqual(['broken 1', 'broken 2']);

    let stats = (await jobs.queueStats()).find((s) => s.kind === `${K}.a`);
    expect(stats.status).toMatchObject({ failed: 2, done: 0 });
    expect(stats.failed_24h).toBe(2);

    wanted = [{ n: 2 }, { n: 3 }];
    expect(await jobs.reconcile()).toMatchObject({ resolved: expect.any(Number) });
    expect((await row(j1)).status).toBe('resolved'); // rebuild() no longer lists n:1
    broken = false;
    expect(await jobs.retryFailed(`${K}.a`)).toEqual({ retried: 1, enqueued: 2, resolved: 0 });
    expect((await row(j2)).status).toBe('retried');
    await runAll();
    stats = (await jobs.queueStats()).find((s) => s.kind === `${K}.a`);
    expect(stats.status).toMatchObject({ failed: 0, resolved: 1, retried: 1, done: 1, partial: 1 });
    expect(stats.failed_24h).toBe(0);
  });

  it('reaps stuck jobs and defers gateway jobs while the gateway is down', async () => {
    jobs.defineJob(`${K}.slow`, async () => {}, { timeoutMs: 1000 });
    jobs.defineJob(`${K}.llm`, async () => {}, { needsGateway: true });
    const s = await jobs.enqueue(`${K}.slow`, {});
    await query("UPDATE hedwig_jobs SET locked_at = NOW() - INTERVAL '5 minutes', status = 'running', attempts = 1 WHERE id = $1", [s]);
    expect((await jobs.reapStuck()).reaped).toBeGreaterThanOrEqual(1);
    expect(await row(s)).toMatchObject({ status: 'queued', locked_at: null });

    const g = await jobs.enqueue(`${K}.llm`, {});
    probe.ok = false; probe.error = 'down';
    expect((await jobs.healthGate()).deferred).toBeGreaterThanOrEqual(1);
    const r = await row(g);
    expect(new Date(r.run_at).getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    expect(r.attempts).toBe(0);
    probe.ok = true;
    await jobs.healthGate();
  });

  it('records provenance columns and job tokens for model calls', async () => {
    const gw = mockGateway().install();
    // .env.hedwig-dev points the gateway at a dead URL; aim this test at the mock.
    const env = { base: process.env.HEDWIG_LLM_BASE_URL, catalog: process.env.HEDWIG_LLM_CATALOG_URL };
    const { invalidateConfigCache } = await import('../config.js');
    process.env.HEDWIG_LLM_BASE_URL = gw.baseUrl;
    process.env.HEDWIG_LLM_CATALOG_URL = gw.catalogUrl;
    invalidateConfigCache();
    try {
      const { definePrompt, runPrompt } = await import('../prompts/index.js');
      definePrompt({ id: 'it.runtime', version: 'v1', tier: 'reflex', system: 's', user: 'u', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }, feature: 'admin' });
      gw.on('it.runtime', { ok: true });
      let prov = null;
      jobs.defineJob(`${K}.prompt`, async () => { ({ provenance: prov } = await runPrompt('it.runtime', {}, { userId })); });
      const id = await jobs.enqueue(`${K}.prompt`, {}, { userId });
      await runAll();
      const job = await row(id);
      expect(job.status).toBe('done');
      expect(job.tokens_in).toBeGreaterThan(0);
      const { rows } = await query('SELECT * FROM hedwig_ai_calls WHERE id = $1', [prov.aiCallId]);
      expect(rows[0]).toMatchObject({ prompt_id: 'it.runtime', prompt_version: 'v1', prompt_hash: prov.promptHash, lane: 'background', tier: 'reflex', workflow: 'it.runtime', job_id: String(id), ok: true });
    } finally {
      gw.restore();
      for (const [k, v] of [['HEDWIG_LLM_BASE_URL', env.base], ['HEDWIG_LLM_CATALOG_URL', env.catalog]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      invalidateConfigCache();
    }
  });

  it('records and reads corrections', async (ctx) => {
    if (!userId) ctx.skip(); // needs the seeded demo user
    const { recordCorrection, recentCorrections } = await import('./corrections.js');
    await recordCorrection({ userId, kind: 'sort', targetId: 'm1', before: { stream: 'reading' }, after: { stream: 'people' }, note: 'it.runtime 1', promptId: 'sort.reflex', promptVersion: 'v1' });
    await recordCorrection({ userId, kind: 'sort', targetId: 'm1', before: { stream: 'people' }, after: { stream: 'records' }, note: 'it.runtime 2' });
    const recent = await recentCorrections(userId, 'sort', 5);
    const m1 = recent.filter((c) => c.targetId === 'm1');
    expect(m1).toHaveLength(1);
    expect(m1[0].after).toEqual({ stream: 'records' });
    await expect(recordCorrection({ userId, kind: 'bogus' })).rejects.toThrow(/unknown correction kind/);
  });
});
