import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/redis.js', () => ({ redisClient: { isReady: false, isOpen: false } }));
const { acquireLane, laneStats, setLaneRedis, _resetLanes } = await import('./lanes.js');

/** A fake Redis that runs the lease script's semantics over in-memory sorted sets. */
function fakeRedis() {
  const sets = new Map(); // key -> Map(member -> score)
  const r = {
    isReady: true,
    evals: 0,
    fail: false,
    async eval(script, { keys: [key], arguments: [limit, leaseMs, id] }) {
      r.evals++;
      if (r.fail) throw new Error('connection lost');
      const now = Date.now();
      const set = sets.get(key) || new Map();
      sets.set(key, set);
      for (const [m, score] of set) if (score <= now) set.delete(m);
      if (set.size < Number(limit)) { set.set(id, now + Number(leaseMs)); return 1; }
      return 0;
    },
    async zRem(key, id) { sets.get(key)?.delete(id); return 1; },
    async zCount(key, min) { return [...(sets.get(key)?.values() || [])].filter((s) => s >= min).length; },
    sets,
  };
  return r;
}

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
