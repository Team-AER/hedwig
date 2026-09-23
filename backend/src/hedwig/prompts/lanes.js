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
//
// Slots are handed out first come, first served. Waiters queue in a second sorted set (score = the
// Redis time they first asked) with a heartbeat in a third (score = heartbeat expiry, so a waiter
// whose process died drops out within WAITER_HEARTBEAT_MS); a free slot goes to the earliest live
// waiter. Without the queue the lane was a race: a caller that released and immediately asked
// again (a batch job making call after call) or one that had just started polling (50 ms) beat a
// caller that had been waiting for minutes (polling at 500 ms), which is how a job could find the
// background lane "full for 240 s" while every slot turned over every 10-15 s. With it, a job that
// makes many calls in a row goes to the back of the queue between calls, so no job can hold the
// lane for a night. The in-process fallback semaphore was always FIFO.
import { randomUUID } from 'node:crypto';
import { redisClient } from '../../services/redis.js';

const KEY_PREFIX = 'hedwig:lane:';
const REDIS_RETRY_MS = 30_000;

const WAITER_HEARTBEAT_MS = 5_000;
const MAX_POLL_MS = 250;

// KEYS: leases, queue, alive. ARGV: limit, leaseMs, id, heartbeatMs.
const ACQUIRE_LUA = `
local leases = KEYS[1]
local queue = KEYS[2]
local alive = KEYS[3]
local limit = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local id = ARGV[3]
local heartbeatMs = tonumber(ARGV[4])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', leases, '-inf', now)
local ticket = tonumber(redis.call('ZSCORE', queue, id) or now)
local free = limit - redis.call('ZCARD', leases)
if free > 0 then
  redis.call('ZREMRANGEBYSCORE', alive, '-inf', now)
  local ahead = 0
  for _, w in ipairs(redis.call('ZRANGEBYSCORE', queue, '-inf', string.format('(%d', ticket))) do
    if redis.call('ZSCORE', alive, w) then ahead = ahead + 1 else redis.call('ZREM', queue, w) end
  end
  free = free - ahead
end
if free > 0 then
  redis.call('ZADD', leases, now + leaseMs, id)
  redis.call('PEXPIRE', leases, leaseMs * 2)
  redis.call('ZREM', queue, id)
  redis.call('ZREM', alive, id)
  return 1
end
redis.call('ZADD', queue, 'NX', ticket, id)
redis.call('ZADD', alive, now + heartbeatMs, id)
redis.call('PEXPIRE', queue, heartbeatMs * 4)
redis.call('PEXPIRE', alive, heartbeatMs * 4)
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

function laneBusy(lane, maxWaitMs) {
  const err = new Error(`the ${lane} model lane stayed full for ${Math.round(maxWaitMs / 1000)} s`);
  err.code = 'lane_busy';
  err.status = 503;
  return err;
}

function acquireLocal(lane, limit, signal, maxWaitMs) {
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
    let timer = null;
    const leave = (err) => {
      const i = s.queue.indexOf(go);
      if (i >= 0) { s.queue.splice(i, 1); clearTimeout(timer); reject(err); }
    };
    const go = () => { clearTimeout(timer); s.active++; resolve(once(release)); };
    s.queue.push(go);
    if (Number.isFinite(maxWaitMs)) timer = setTimeout(() => leave(laneBusy(lane, maxWaitMs)), Math.max(0, maxWaitMs));
    signal?.addEventListener('abort', () => leave(signal.reason || new Error('aborted')), { once: true });
  });
}

function once(fn) {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
}

/**
 * Take a slot in a lane, first come first served. Resolves to a release function (idempotent).
 * Rejects with code 'lane_busy' (status 503) when no slot came free within `maxWaitMs`.
 * @param {'interactive'|'background'} lane
 * @param {{ limit: number, leaseMs: number, maxWaitMs?: number, signal?: AbortSignal }} opts
 */
export async function acquireLane(lane, { limit, leaseMs, maxWaitMs = 300_000, signal } = {}) {
  const key = KEY_PREFIX + lane;
  const queueKey = `${key}:queue`;
  const aliveKey = `${key}:alive`;
  const id = randomUUID();
  const deadline = Date.now() + maxWaitMs;
  let delay = 50;
  let queued = null; // the client this caller queued on, so it can leave the queue when it gives up
  const leave = () => {
    if (!queued) return;
    const c = queued; queued = null;
    Promise.resolve().then(() => Promise.all([c.zRem(queueKey, id), c.zRem(aliveKey, id)])).catch(() => {});
  };
  try {
    for (;;) {
      const c = redis();
      if (!c) { leave(); return await acquireLocal(lane, limit, signal, Math.max(0, deadline - Date.now())); }
      let got;
      try {
        got = await c.eval(ACQUIRE_LUA, {
          keys: [key, queueKey, aliveKey],
          arguments: [String(limit), String(Math.round(leaseMs)), id, String(WAITER_HEARTBEAT_MS)],
        });
      } catch (err) {
        markRedisDown(err);
        leave();
        return await acquireLocal(lane, limit, signal, Math.max(0, deadline - Date.now()));
      }
      if (Number(got) === 1) {
        queued = null; // the script took it off the queue
        return once(() => { Promise.resolve(c.zRem(key, id)).catch(() => {}); });
      }
      queued = c;
      if (Date.now() + delay > deadline) throw laneBusy(lane, maxWaitMs);
      await sleep(delay + Math.floor(Math.random() * 25), signal);
      delay = Math.min(MAX_POLL_MS, delay * 2);
    }
  } catch (err) {
    leave();
    throw err;
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
