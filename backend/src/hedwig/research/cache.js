// Redis cache for pages Ask has read, keyed by canonical URL. Fails open: no Redis (the worker does not
// connect the shared client), or a Redis error, just means the page is read again.
import { createHash } from 'node:crypto';
import { redisClient } from '../../services/redis.js';
import { canonicalUrl } from './searx.js';

/**
 * The cached result for `url` when there is one; otherwise `await load()`, cached for `hours` when it
 * succeeded (`ok: true`). `client` overrides the shared Redis client (anything with async get/set).
 * @template T
 * @param {string} url
 * @param {() => Promise<T>} load
 * @param {{ hours?: number, keyPrefix?: string, client?: { get: Function, set: Function } }} [opts]
 * @returns {Promise<T>}
 */
export async function cachedPage(url, load, { hours = 24, keyPrefix = 'hedwig:research:page:', client } = {}) {
  const redis = client || (redisClient?.isReady ? redisClient : null);
  if (!redis) return load();
  const key = keyPrefix + createHash('sha256').update(String(canonicalUrl(url))).digest('hex');
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) {
    console.warn('[hedwig] research cache read failed:', err?.message || err);
  }
  const value = await load();
  if (value?.ok === true) {
    try {
      await redis.set(key, JSON.stringify(value), { EX: Math.max(1, Math.round(hours * 3600)) });
    } catch (err) {
      console.warn('[hedwig] research cache write failed:', err?.message || err);
    }
  }
  return value;
}
