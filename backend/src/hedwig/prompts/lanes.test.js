import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/redis.js', () => ({ redisClient: { isReady: false, isOpen: false } }));
const { acquireLane, laneStats, setLaneRedis, _resetLanes } = await import('./lanes.js');

/** A fake Redis that runs the lease script's semantics (leases + FIFO waiter queue) over in-memory sorted sets. */
function fakeRedis() {
  const sets = new Map(); // key -> Map(member -> score)
  const get = (k) => { if (!sets.has(k)) sets.set(k, new Map()); return sets.get(k); };
  const r = {
    isReady: true,
    evals: 0,
    fail: false,
    async eval(script, { keys: [key, queueKey, aliveKey], arguments: [limit, leaseMs, id, heartbeatMs] }) {
      r.evals++;
      if (r.fail) throw new Error('connection lost');
      const now = Date.now();
      const leases = get(key);
      for (const [m, score] of leases) if (score <= now) leases.delete(m);
      const queue = queueKey ? get(queueKey) : new Map();
      const alive = aliveKey ? get(aliveKey) : new Map();
      const ticket = queue.has(id) ? queue.get(id) : now;
      let free = Number(limit) - leases.size;
      if (free > 0) {
        for (const [m, score] of alive) if (score <= now) alive.delete(m);
        for (const [w, t] of [...queue]) {
          if (t >= ticket || w === id) continue;
          if (alive.has(w)) free--; else queue.delete(w);
        }
      }
      if (free > 0) { leases.set(id, now + Number(leaseMs)); queue.delete(id); alive.delete(id); return 1; }
      if (!queue.has(id)) queue.set(id, ticket);
      alive.set(id, now + Number(heartbeatMs || 5000));
      return 0;
    },
    async zRem(key, id) { sets.get(key)?.delete(id); return 1; },
    async zCount(key, min) { return [...(sets.get(key)?.values() || [])].filter((s) => s >= min).length; },
    sets,
  };
  return r;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

beforeEach(() => _resetLanes());

describe('lanes', () => {
  it('holds the limit across callers sharing Redis and hands the slot on release', async () => {
    const redis = fakeRedis();
    setLaneRedis(redis);
    const opts = { limit: 2, leaseMs: 60_000, maxWaitMs: 5000 };
    const a = await acquireLane('background', opts);
    const b = await acquireLane('background', opts);
    let thirdIn = false;
    const third = acquireLane('background', opts).then((rel) => { thirdIn = true; return rel; });
    await new Promise((r) => setTimeout(r, 120));
    expect(thirdIn).toBe(false);
    expect((await laneStats({ background: 2 })).background).toMatchObject({ active: 2, backend: 'redis' });
    a();
    const c = await third;
    expect(thirdIn).toBe(true);
    b(); c();
    c(); // idempotent
    expect(redis.sets.get('hedwig:lane:background').size).toBe(0);
  });

  it('keeps lanes independent', async () => {
    setLaneRedis(fakeRedis());
    await acquireLane('background', { limit: 1, leaseMs: 60_000 });
    const rel = await acquireLane('interactive', { limit: 1, leaseMs: 60_000 });
    expect(typeof rel).toBe('function');
  });

  it('frees a lease left behind by a crashed process once it expires', async () => {
    setLaneRedis(fakeRedis());
    await acquireLane('background', { limit: 1, leaseMs: 80 }); // never released
    const started = Date.now();
    const rel = await acquireLane('background', { limit: 1, leaseMs: 80, maxWaitMs: 2000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    rel();
  });

  it('gives up with lane_busy after maxWaitMs', async () => {
    setLaneRedis(fakeRedis());
    await acquireLane('interactive', { limit: 1, leaseMs: 60_000 });
    await expect(acquireLane('interactive', { limit: 1, leaseMs: 60_000, maxWaitMs: 100 })).rejects.toMatchObject({ code: 'lane_busy' });
  });

  it('hands a freed slot to the caller that has waited longest, not to a newcomer or the caller that just released', async () => {
    const redis = fakeRedis();
    setLaneRedis(redis);
    const opts = { limit: 1, leaseMs: 60_000, maxWaitMs: 5000 };
    const order = [];
    const holder = await acquireLane('background', opts);
    const old = acquireLane('background', opts).then((rel) => { order.push('old'); return rel; });
    await sleep(600); // the old waiter is now polling at its slowest
    const fresh = acquireLane('background', opts).then((rel) => { order.push('fresh'); return rel; });
    await sleep(20);
    holder();
    // the releaser asks again at once (a batch job's next call): it queues behind both
    const again = acquireLane('background', opts).then((rel) => { order.push('again'); return rel; });
    (await old)();
    (await fresh)();
    (await again)();
    expect(order).toEqual(['old', 'fresh', 'again']);
    expect(redis.sets.get('hedwig:lane:background:queue').size).toBe(0);
  }, 10_000);

  it('a waiter that gives up leaves the queue, and one whose process died stops blocking it', async () => {
    const redis = fakeRedis();
    setLaneRedis(redis);
    const holder = await acquireLane('interactive', { limit: 1, leaseMs: 60_000 });
    await expect(acquireLane('interactive', { limit: 1, leaseMs: 60_000, maxWaitMs: 120 })).rejects.toMatchObject({ code: 'lane_busy' });
    await sleep(5);
    expect(redis.sets.get('hedwig:lane:interactive:queue').size).toBe(0);
    // a dead waiter: queued with an expired heartbeat
    redis.sets.get('hedwig:lane:interactive:queue').set('ghost', Date.now() - 10_000);
    redis.sets.get('hedwig:lane:interactive:alive').set('ghost', Date.now() - 1);
    holder();
    const rel = await acquireLane('interactive', { limit: 1, leaseMs: 60_000, maxWaitMs: 500 });
    expect(redis.sets.get('hedwig:lane:interactive:queue').has('ghost')).toBe(false);
    rel();
  });

  it('the per-process fallback honours maxWaitMs too', async () => {
    _resetLanes(); // default client: not ready → local
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const held = await acquireLane('background', { limit: 1, leaseMs: 60_000 });
    const started = Date.now();
    await expect(acquireLane('background', { limit: 1, leaseMs: 60_000, maxWaitMs: 150 })).rejects.toMatchObject({ code: 'lane_busy', status: 503 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    held();
    (await acquireLane('background', { limit: 1, leaseMs: 60_000, maxWaitMs: 150 }))();
    warn.mockRestore();
  });

  it('falls back to a per-process semaphore when Redis errors or is not connected', async () => {
    const redis = fakeRedis();
    redis.fail = true;
    setLaneRedis(redis);
    const a = await acquireLane('background', { limit: 1, leaseMs: 60_000 });
    let second = false;
    const p = acquireLane('background', { limit: 1, leaseMs: 60_000 }).then((rel) => { second = true; return rel; });
    await new Promise((r) => setTimeout(r, 30));
    expect(second).toBe(false);
    a();
    (await p)();
    expect(second).toBe(true);
    expect(redis.evals).toBe(1); // marked down, not hammered

    _resetLanes(); // default client: not ready → local
    const rel = await acquireLane('interactive', { limit: 1, leaseMs: 1000 });
    expect((await laneStats({ interactive: 1 })).interactive).toMatchObject({ active: 1, backend: 'local' });
    rel();
  });
});
