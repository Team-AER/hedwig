import { describe, it, expect, vi, afterEach } from 'vitest';
import { canonicalUrl, hostOf, searchWeb, interleave } from './searx.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PAYLOAD = {
  results: [
    { url: 'https://example.com/', title: 'Example home', content: 'Front page' },
    { url: 'https://www.infoq.com/news/2026/10/pizza-bot/', title: '  Pizza\n bot ', content: 'A   bot that\norders pizza', publishedDate: '2026-10-12T08:00:00Z' },
    { url: 'https://infoq.com/news/2026/10/pizza-bot', title: 'Duplicate (no www, no slash)' },
    { url: 'https://infoq.com/news/2026/10/pizza-bot/#comments', title: 'Duplicate (fragment)' },
    { url: 'ftp://files.example.com/x', title: 'Not http' },
    { url: 'javascript:alert(1)', title: 'Not http either' },
    { url: 'https://blog.example.org/post?id=7', title: '', content: 'x'.repeat(500), publishedDate: null },
    null,
    { url: 'http://news.example.net/story', title: 'Story' },
  ],
};

describe('canonicalUrl / hostOf', () => {
  it('normalizes scheme, host, www, fragment and trailing slash but keeps the query', () => {
    expect(canonicalUrl('HTTPS://WWW.Example.COM/a/b/?x=1#frag')).toBe('https://example.com/a/b?x=1');
    expect(canonicalUrl('https://example.com')).toBe('https://example.com/');
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com/');
    expect(canonicalUrl('https://example.com/path/')).toBe(canonicalUrl('https://www.example.com/path'));
    expect(canonicalUrl('http://example.com:8080/x/')).toBe('http://example.com:8080/x');
    expect(canonicalUrl('not a url')).toBe('not a url');
  });

  it('gives the host without www, or empty', () => {
    expect(hostOf('https://www.InfoQ.com/news')).toBe('infoq.com');
    expect(hostOf('https://blog.example.org/')).toBe('blog.example.org');
    expect(hostOf('nope')).toBe('');
  });
});

describe('searchWeb', () => {
  afterEach(() => vi.restoreAllMocks());

  it('queries SearXNG and parses, dedupes and orders the results', async () => {
    const fetchImpl = vi.fn(async () => json(PAYLOAD));
    const out = await searchWeb('  pizza   bot ', { searchUrl: 'http://search:8080/', fetchImpl, limit: 10 });

    const [url, init] = fetchImpl.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('http://search:8080/search');
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: 'pizza bot', format: 'json', safesearch: '0' });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(out.map((r) => r.url)).toEqual([
      'https://www.infoq.com/news/2026/10/pizza-bot/',
      'https://blog.example.org/post?id=7',
      'http://news.example.net/story',
      'https://example.com/',
    ]);
    expect(out[0]).toEqual({
      url: 'https://www.infoq.com/news/2026/10/pizza-bot/',
      title: 'Pizza bot',
      snippet: 'A bot that orders pizza',
      published: '2026-10-12',
      host: 'infoq.com',
    });
    expect(out[1].title).toBe('https://blog.example.org/post?id=7');
    expect(out[1].snippet).toHaveLength(400);
    expect(out[1].published).toBeNull();
  });

  it('applies the limit after putting front pages last', async () => {
    const out = await searchWeb('pizza', { searchUrl: 'http://search', fetchImpl: async () => json(PAYLOAD), limit: 2 });
    expect(out.map((r) => r.host)).toEqual(['infoq.com', 'blog.example.org']);
  });

  it('returns [] without a query or a search URL, and does not call out', async () => {
    const fetchImpl = vi.fn();
    expect(await searchWeb('   ', { searchUrl: 'http://search', fetchImpl })).toEqual([]);
    expect(await searchWeb('pizza', { searchUrl: '', fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns [] on a non-200, bad JSON, a thrown error or a timeout, with one warning each', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { searchUrl: 'http://search' };
    expect(await searchWeb('q', { ...opts, fetchImpl: async () => json({ error: 'x' }, 502) })).toEqual([]);
    expect(await searchWeb('q', { ...opts, fetchImpl: async () => new Response('<html>not json', { status: 200 }) })).toEqual([]);
    expect(await searchWeb('q', { ...opts, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).toEqual([]);
    const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    expect(await searchWeb('q', { ...opts, timeoutMs: 20, fetchImpl: hang })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.every(([msg]) => msg.startsWith('[hedwig] web search'))).toBe(true);
  });

  it('returns [] quietly when the caller aborts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctrl = new AbortController();
    const hang = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const pending = searchWeb('q', { searchUrl: 'http://search', fetchImpl: hang, signal: ctrl.signal });
    ctrl.abort();
    expect(await pending).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a payload without a results array', async () => {
    expect(await searchWeb('q', { searchUrl: 'http://search', fetchImpl: async () => json({ answers: [] }) })).toEqual([]);
  });
});

describe('interleave', () => {
  const r = (url) => ({ url, title: url });

  it('takes the first of each list, then the second, deduplicated by canonical URL', () => {
    const a = [r('https://a.com/1'), r('https://a.com/2'), r('https://a.com/3')];
    const b = [r('https://www.a.com/1/'), r('https://b.com/2')];
    const c = [r('https://c.com/1')];
    expect(interleave([a, b, c]).map((x) => x.url)).toEqual([
      'https://a.com/1', 'https://c.com/1', 'https://a.com/2', 'https://b.com/2', 'https://a.com/3',
    ]);
  });

  it('stops at the limit and tolerates junk', () => {
    const a = [r('https://a.com/1'), r('https://a.com/2')];
    const b = [r('https://b.com/1'), null];
    expect(interleave([a, null, b], 3).map((x) => x.url)).toEqual(['https://a.com/1', 'https://b.com/1', 'https://a.com/2']);
    expect(interleave(undefined)).toEqual([]);
  });
});
