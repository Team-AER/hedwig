import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { cachedPage } from './cache.js';

const shared = vi.hoisted(() => ({ redisClient: { isReady: false, get: vi.fn(), set: vi.fn() } }));
vi.mock('../../services/redis.js', () => shared);

function fakeRedis() {
  const store = new Map();
  return {
    store,
    get: vi.fn(async (key) => store.get(key) ?? null),
    set: vi.fn(async (key, value) => { store.set(key, value); return 'OK'; }),
  };
}

const PAGE = { ok: true, url: 'https://example.com/a', title: 'A', text: 'Hello', links: [] };

describe('cachedPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads and stores a successful page under the canonical URL key', async () => {
    const client = fakeRedis();
    const load = vi.fn(async () => PAGE);
    expect(await cachedPage('https://example.com/a', load, { client, hours: 2 })).toEqual(PAGE);
    const key = `hedwig:research:page:${createHash('sha256').update('https://example.com/a').digest('hex')}`;
    expect(client.set).toHaveBeenCalledWith(key, JSON.stringify(PAGE), { EX: 7200 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves a hit without loading, whatever the www / trailing slash / fragment', async () => {
    const client = fakeRedis();
    await cachedPage('https://www.example.com/a/', async () => PAGE, { client });
    const load = vi.fn();
    expect(await cachedPage('https://example.com/a#top', load, { client })).toEqual(PAGE);
    expect(load).not.toHaveBeenCalled();
    expect(client.store.size).toBe(1);
  });

  it('does not cache failures', async () => {
    const client = fakeRedis();
    const failed = { ok: false, url: 'https://example.com/b', reason: 'timeout' };
    expect(await cachedPage('https://example.com/b', async () => failed, { client })).toEqual(failed);
    expect(client.set).not.toHaveBeenCalled();
  });

  it('falls back to loading when Redis fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = {
      get: vi.fn(async () => { throw new Error('connection lost'); }),
      set: vi.fn(async () => { throw new Error('connection lost'); }),
    };
    const load = vi.fn(async () => PAGE);
    expect(await cachedPage('https://example.com/a', load, { client })).toEqual(PAGE);
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('treats unreadable cache entries as a miss', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = { get: vi.fn(async () => '{not json'), set: vi.fn(async () => 'OK') };
    expect(await cachedPage('https://example.com/a', async () => PAGE, { client })).toEqual(PAGE);
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('skips the shared client until it is connected', async () => {
    const load = vi.fn(async () => PAGE);
    expect(await cachedPage('https://example.com/a', load)).toEqual(PAGE);
    expect(shared.redisClient.get).not.toHaveBeenCalled();

    shared.redisClient.isReady = true;
    shared.redisClient.get.mockResolvedValueOnce(JSON.stringify({ ...PAGE, title: 'cached' }));
    expect((await cachedPage('https://example.com/a', load)).title).toBe('cached');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
