import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJobsDb } from './fakeJobsDb.testutil.js';

const fake = createFakeJobsDb();
vi.mock('../../services/db.js', () => ({ pool: {}, query: (sql, params) => fake.query(sql, params) }));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
const cfg = { enabled: true, 'llm.baseUrl': 'http://gw/v1', 'llm.catalogUrl': 'http://gw/catalog.json', 'llm.apiKey': '', 'jobs.healthDeferMin': 10, 'jobs.reapAfterMin': 30 };
vi.mock('../config.js', () => ({ getConfig: vi.fn(async () => ({ ...cfg, get: (k) => cfg[k] })) }));
const probe = { ok: true, error: null };
vi.mock('../llm.js', () => ({ probeGateway: vi.fn(async () => ({ ...probe })) }));
vi.mock('../prompts/index.js', () => ({ listPrompts: async () => [] }));

const jobs = await import('../jobs.js');
const { currentLane, recordUsage, currentContext } = await import('./context.js');
const { runtimeAdminRoutes } = await import('./routes.js');
const { defineJob, enqueue, claim, runJob, reconcile, retryFailed, reapStuck, healthGate, _resetJobs } = jobs;

const U1 = '11111111-1111-4111-8111-111111111111';

async function runAll() {
  const claimed = await claim(10);
  for (const j of claimed) await runJob(j);
  return claimed;
}

beforeEach(() => {
  fake.state.rows.length = 0;
  fake.state.nextId = 1;
  fake.state.now = Date.now();
  probe.ok = true; probe.error = null;
  _resetJobs();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('job ledger', () => {
  it('runs handlers in the background lane, records tokens, and supports partial results', async () => {
    const seen = [];
    defineJob('t.work', async (payload) => {
      seen.push(currentLane());
      recordUsage({ prompt_tokens: 120, completion_tokens: 30 });
      recordUsage({ prompt_tokens: 80, completion_tokens: 10 });
      return payload.partial ? { status: 'partial', note: '2 of 3 messages sorted' } : undefined;
    });
    const a = await enqueue('t.work', {}, { userId: U1 });
    const b = await enqueue('t.work', { partial: true }, { userId: U1 });
    await runAll();
    expect(seen).toEqual(['background', 'background']);
    expect(fake.row(a)).toMatchObject({ status: 'done', tokens_in: 200, tokens_out: 40, note: null });
    expect(fake.row(b)).toMatchObject({ status: 'partial', note: '2 of 3 messages sorted' });
  });

  it('moves a throwing job through queued (backoff) to failed and keeps last_error', async () => {
    defineJob('t.flaky', async () => { throw new Error('parse error'); });
    const id = await enqueue('t.flaky', { n: 1 }, { maxAttempts: 2 });
    await runAll();
    expect(fake.row(id)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'parse error' });
    fake.advance(60_000);
    await runAll();
    expect(fake.row(id)).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('reconcile resolves a failure once a later run of the same work succeeds', async () => {
    let fail = true;
    defineJob('t.sum', async () => { if (fail) throw Object.assign(new Error('boom'), { permanent: true }); });
    const first = await enqueue('t.sum', { topicId: 7 }, { userId: U1, dedupeKey: 'sum:7' });
    await runAll();
    expect(fake.row(first).status).toBe('failed');
    expect(await reconcile()).toEqual({ resolved: 0 });
    fail = false;
    fake.advance(1000);
    const second = await enqueue('t.sum', { topicId: 7 }, { userId: U1, dedupeKey: 'sum:7' });
    expect(second).not.toBe(first); // the failed row no longer blocks the dedupe key
    await runAll();
    expect(await reconcile()).toEqual({ resolved: 1 });
    expect(fake.row(first)).toMatchObject({ status: 'resolved', note: 'a later run succeeded' });
  });

  it('reconcile resolves failures rebuild() no longer lists', async () => {
    let wanted = [{ messageId: 'm1' }, { messageId: 'm2' }];
    defineJob('t.extract', async () => { throw Object.assign(new Error('bad'), { permanent: true }); }, { rebuild: async () => wanted });
    const m1 = await enqueue('t.extract', { messageId: 'm1' }, { userId: U1 });
    const m2 = await enqueue('t.extract', { messageId: 'm2' }, { userId: U1 });
    await runAll();
    wanted = [{ messageId: 'm2' }];
    expect(await reconcile()).toEqual({ resolved: 1 });
    expect(fake.row(m1).status).toBe('resolved');
    expect(fake.row(m2).status).toBe('failed');
  });

  it('retryFailed re-enqueues from rebuild() and marks old rows retried or resolved', async () => {
    let broken = true;
    const rebuild = vi.fn(async (userId) => (userId === U1 ? [{ messageId: 'm2' }, { messageId: 'm3' }] : []));
    defineJob('t.extract', async () => { if (broken) throw Object.assign(new Error('bad'), { permanent: true }); }, { rebuild });
    const m1 = await enqueue('t.extract', { messageId: 'm1' }, { userId: U1 });
    const m2 = await enqueue('t.extract', { messageId: 'm2' }, { userId: U1, dedupeKey: 'extract:m2' });
    await runAll();
    broken = false;
    const out = await retryFailed('t.extract');
    expect(out).toEqual({ retried: 1, enqueued: 2, resolved: 1 });
    expect(rebuild).toHaveBeenCalledWith(U1);
    expect(fake.row(m1).status).toBe('resolved');
    expect(fake.row(m2).status).toBe('retried');
    const fresh = fake.state.rows.filter((r) => r.status === 'queued');
    expect(fresh.map((r) => r.payload)).toEqual([{ messageId: 'm2' }, { messageId: 'm3' }]);
    expect(fresh[0].dedupe_key).toBe('extract:m2');
    expect(fresh[1].dedupe_key).toMatch(/^rb:t\.extract:[0-9a-f]{40}$/);
    await runAll();
    expect(fake.state.rows.filter((r) => r.status === 'done')).toHaveLength(2);
    expect(await retryFailed()).toEqual({ retried: 0, enqueued: 0, resolved: 0 }); // failed counts only rows still failed
  });

  it('retryFailed copies failed jobs of kinds without rebuild()', async () => {
    defineJob('t.plain', async () => { throw Object.assign(new Error('nope'), { permanent: true }); });
    const id = await enqueue('t.plain', { a: 1 }, { userId: U1, priority: 3, maxAttempts: 2 });
    await runAll();
    expect(await retryFailed()).toEqual({ retried: 1, enqueued: 1, resolved: 0 });
    expect(fake.row(id).status).toBe('retried');
    const copy = fake.state.rows.find((r) => r.id !== id);
    expect(copy).toMatchObject({ kind: 't.plain', payload: { a: 1 }, user_id: U1, priority: 3, max_attempts: 2, status: 'queued', attempts: 0 });
  });

  it('reapStuck requeues jobs running past their timeout, failing those out of attempts', async () => {
    defineJob('t.slow', async () => {}, { timeoutMs: 60_000 });
    const a = await enqueue('t.slow', { i: 1 });
    const b = await enqueue('t.slow', { i: 2 }, { maxAttempts: 1 });
    const c = await enqueue('t.unknown', { i: 3 });
    await claim(10); // locked, never finished (the worker died)
    // an unknown kind locked by another process
    Object.assign(fake.row(c), { locked_at: fake.state.now, status: 'running', attempts: 1 });
    fake.advance(90_000);
    expect(await reapStuck()).toEqual({ reaped: 0 }); // under timeout + 60 s grace
    fake.advance(40_000);
    expect(await reapStuck()).toEqual({ reaped: 2 });
    expect(fake.row(a)).toMatchObject({ status: 'queued', locked_at: null, attempts: 1 });
    expect(fake.row(b)).toMatchObject({ status: 'failed' });
    expect(fake.row(c).status).toBe('running');
    fake.advance(30 * 60_000);
    expect(await reapStuck()).toEqual({ reaped: 1 }); // jobs.reapAfterMin for kinds it does not know
  });

  it('healthGate defers gateway jobs while the gateway is down without consuming attempts', async () => {
    defineJob('t.llm', async () => {}, { needsGateway: true });
    defineJob('t.mail', async () => {});
    const llm = await enqueue('t.llm', {});
    const mail = await enqueue('t.mail', {});
    probe.ok = false; probe.error = 'connect ECONNREFUSED';
    expect(await healthGate()).toMatchObject({ ok: false, deferred: 1 });
    expect(fake.row(llm).run_at).toBe(fake.state.now + 10 * 60_000);
    expect(fake.row(llm).attempts).toBe(0);
    await runAll();
    expect(fake.row(mail).status).toBe('done');
    // a job claimed while the gate is closed goes back without losing its attempt
    fake.row(llm).run_at = fake.state.now;
    await runAll();
    expect(fake.row(llm)).toMatchObject({ status: 'queued', attempts: 0 });
    probe.ok = true;
    expect(await healthGate()).toEqual({ ok: true, deferred: 0 });
    fake.row(llm).run_at = fake.state.now;
    await runAll();
    expect(fake.row(llm).status).toBe('done');
  });

  it('defers (not fails) any job whose model call failed because the gateway is unreachable', async () => {
    defineJob('t.extract', async () => {
      throw Object.assign(new Error('fetch failed'), { name: 'LlmError', status: 502, code: 'llm_error' });
    });
    const id = await enqueue('t.extract', {}, { maxAttempts: 1 });
    probe.ok = false; probe.error = 'timeout';
    await runAll();
    expect(fake.row(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(fake.row(id).last_error).toMatch(/gateway unreachable/);
    // gateway up: the same error is a real failure
    probe.ok = true;
    fake.row(id).run_at = fake.state.now;
    await runAll();
    expect(fake.row(id).status).toBe('failed');
  });

  it('keeps budget exhaustion out of failed', async () => {
    defineJob('t.budget', async () => { throw Object.assign(new Error('budget'), { code: 'budget_exceeded' }); });
    const id = await enqueue('t.budget', {}, { maxAttempts: 1 });
    await runAll();
    expect(fake.row(id)).toMatchObject({ status: 'queued', attempts: 0 });
  });
});

describe('job locks and timeouts (review fixes)', () => {
  const MIN = 60_000;

  it('never re-claims a job still inside its own timeout (45 min kind), only after timeout + margin', async () => {
    defineJob('t.nightly', async () => {}, { timeoutMs: 45 * MIN });
    const id = await enqueue('t.nightly', {});
    expect(await claim(10)).toHaveLength(1); // running, the worker is busy with it
    fake.advance(16 * MIN);
    expect(await claim(10)).toHaveLength(0); // the old fixed 15 min would re-claim it here
    fake.advance(29 * MIN);
    expect(await claim(10)).toHaveLength(0); // 45 min: still within timeout + 60 s
    fake.advance(2 * MIN);
    const again = await claim(10);
    expect(again.map((j) => j.id)).toEqual([id]); // the first worker died
    expect(fake.row(id).attempts).toBe(2);
  });

  it('the admin reconcile route does not reap kinds this (API) process does not know', async () => {
    const id = await enqueue('t.workerOnly', {});
    Object.assign(fake.row(id), { locked_at: fake.state.now, status: 'running', attempts: 1 });
    fake.advance(40 * MIN); // past jobs.reapAfterMin (30), well inside a worker kind's 60 min timeout
    const routes = {};
    runtimeAdminRoutes({ get() {}, post(path, fn) { routes[path] = fn; } });
    let body = null;
    await routes['/jobs/reconcile']({ body: {} }, { json: (b) => { body = b; }, status() { return this; } });
    expect(body).toMatchObject({ resolved: 0 });
    expect(body.reaped).toBeUndefined();
    expect(fake.row(id)).toMatchObject({ status: 'running', locked_at: expect.any(Number) });
  });

  it('aborts the handler through ctx.signal (and the ambient signal) when the job times out', async () => {
    let seen = null;
    defineJob('t.hang', (payload, job, ctx) => new Promise((resolve, reject) => {
      seen = { ctx: ctx.signal, ambient: currentContext().signal };
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
    }), { timeoutMs: 30 });
    const id = await enqueue('t.hang', {}, { maxAttempts: 1 });
    await runAll();
    expect(seen.ctx.aborted).toBe(true);
    expect(seen.ambient).toBe(seen.ctx);
    expect(fake.row(id)).toMatchObject({ status: 'failed', last_error: 'job timed out after 30 ms' });
  });

  it('time spent waiting for a lane slot does not count against the timeout, and pushes the lock out', async () => {
    const WAIT = 1100;
    defineJob('t.laneWait', async () => {
      const { laneWait } = currentContext();
      laneWait.pause(); // what llm.js takeLane does around acquireLane
      await new Promise((r) => setTimeout(r, WAIT));
      laneWait.resume();
      await new Promise((r) => setTimeout(r, 50));
      return undefined;
    }, { timeoutMs: 300 });
    const id = await enqueue('t.laneWait', {});
    const [job] = await claim(10);
    await runJob(job);
    expect(fake.row(id).status).toBe('done');
    const extend = fake.state.calls.find((c) => c.sql.startsWith('UPDATE hedwig_jobs SET locked_at = locked_at + make_interval'));
    expect(extend.params[0]).toBe(id);
    expect(extend.params[1]).toBeGreaterThanOrEqual(WAIT / 1000 - 0.05);
  }, 10_000);
});
