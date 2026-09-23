// Lanes: how many model calls may run at once, per kind of work, across every process.
//
//   interactive  a person is waiting (ask, agent, assistant, on-demand summaries)
//   background   jobs, pipeline steps, schedules
//
// Slots are leases in a Redis sorted set (member = lease id, score = expiry), taken and released
// atomically by a small Lua script, so the API and the worker share one limit. A lease left by a
// crashed process expires on its own. When Redis is not connected (tests, a dev box without it, a
// Redis outage) each process falls back to an in-process semaphore with the same limit, and says
// so once in the log.
import { randomUUID } from 'node:crypto';
import { redisClient } from '../../services/redis.js';

const KEY_PREFIX = 'hedwig:lane:';
const REDIS_RETRY_MS = 30_000;

const ACQUIRE_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local id = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, now + leaseMs, id)
  redis.call('PEXPIRE', key, leaseMs * 2)
  return 1
end
return 0
`;

let injected = null;          // tests: setLaneRedis(mock)
let connectTried = false;
let redisDownUntil = 0;
let warnedLocal = false;
const local = new Map();      // lane -> { active, queue: [] }

/** Tests (or an embedding host) can hand in a client; null restores services/redis.js. */
export function setLaneRedis(client) {
  injected = client;
  redisDownUntil = 0;
}

function redis() {
  if (Date.now() < redisDownUntil) return null;
  const c = injected || redisClient;
  if (!c) return null;
  if (c.isReady) return c;
  // The API connects the shared client at boot; the worker does not, so connect it on first use
  // when REDIS_URL says where Redis is. Never in tests (no REDIS_URL).
  if (c === redisClient && !c.isOpen && !connectTried && process.env.REDIS_URL && typeof c.connect === 'function') {
    connectTried = true;
    Promise.resolve()
      .then(() => c.connect())
      .catch((err) => console.warn('[hedwig] lanes: redis connect failed, using per-process limits:', err?.message || err));
  }
  return null;
}

function markRedisDown(err) {
  redisDownUntil = Date.now() + REDIS_RETRY_MS;
  console.warn('[hedwig] lanes: redis unavailable, using per-process limits for 30 s:', err?.message || err);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); }, { once: true });
});

function acquireLocal(lane, limit, signal) {
  if (!warnedLocal) {
    warnedLocal = true;
    console.warn('[hedwig] lanes: redis not connected; lane limits apply per process');
  }
  let s = local.get(lane);
  if (!s) { s = { active: 0, queue: [] }; local.set(lane, s); }
  const release = () => {
    s.active = Math.max(0, s.active - 1);
    const next = s.queue.shift();
    if (next) next();
  };
  if (s.active < limit) { s.active++; return Promise.resolve(once(release)); }
  return new Promise((resolve, reject) => {
    const go = () => { s.active++; resolve(once(release)); };
    s.queue.push(go);
    signal?.addEventListener('abort', () => {
      const i = s.queue.indexOf(go);
      if (i >= 0) { s.queue.splice(i, 1); reject(signal.reason || new Error('aborted')); }
    }, { once: true });
  });
}

function once(fn) {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
}

/**
 * Take a slot in a lane. Resolves to a release function (idempotent).
 * @param {'interactive'|'background'} lane
 * @param {{ limit: number, leaseMs: number, maxWaitMs?: number, signal?: AbortSignal }} opts
 */
export async function acquireLane(lane, { limit, leaseMs, maxWaitMs = 300_000, signal } = {}) {
  const key = KEY_PREFIX + lane;
  const id = randomUUID();
  const deadline = Date.now() + maxWaitMs;
  let delay = 50;
  for (;;) {
    const c = redis();
    if (!c) return acquireLocal(lane, limit, signal);
    let got;
    try {
      got = await c.eval(ACQUIRE_LUA, { keys: [key], arguments: [String(limit), String(Math.round(leaseMs)), id] });
    } catch (err) {
      markRedisDown(err);
      return acquireLocal(lane, limit, signal);
    }
    if (Number(got) === 1) {
      return once(() => { Promise.resolve(c.zRem(key, id)).catch(() => {}); });
    }
    if (Date.now() + delay > deadline) {
      const err = new Error(`the ${lane} model lane stayed full for ${Math.round(maxWaitMs / 1000)} s`);
      err.code = 'lane_busy';
      err.status = 503;
      throw err;
    }
    await sleep(delay + Math.floor(Math.random() * 25), signal);
    delay = Math.min(500, delay * 2);
  }
}

/** Current occupancy, for the admin health page. */
export async function laneStats(limits = {}) {
  const out = {};
  const c = redis();
  for (const lane of Object.keys(limits)) {
    let active = local.get(lane)?.active || 0;
    let backend = 'local';
    if (c) {
      try {
        active = Number(await c.zCount(KEY_PREFIX + lane, Date.now(), '+inf'));
        backend = 'redis';
      } catch { /* report the local view */ }
    }
    out[lane] = { limit: limits[lane], active, backend };
  }
  return out;
}

export function _resetLanes() {
  local.clear();
  injected = null;
  connectTried = false;
  redisDownUntil = 0;
  warnedLocal = false;
}
