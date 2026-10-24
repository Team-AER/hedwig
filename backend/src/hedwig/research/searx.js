// Web search through SearXNG's JSON API. SearXNG is an admin-configured internal service (like the AI
// base URL), so it is called with plain fetch; the result pages it points at are untrusted and are only
// ever read through page.js (safeFetch). Nothing here throws: a failed search is simply no results.

const SNIPPET_CHARS = 400;

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function parseHttp(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Comparable form of a URL: lower-case scheme and host without `www.`, no fragment, no trailing slash
 * ('/' when the path is empty), query kept. Returns the input unchanged when it does not parse.
 * @param {string} url
 * @returns {string}
 */
export function canonicalUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return url; }
  const path = u.pathname.replace(/\/+$/, '') || '/';
  if (!u.host) return `${u.protocol}${path}${u.search}`;
  return `${u.protocol}//${u.host.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
}

/**
 * Host name of a URL without a leading `www.`, or '' when it does not parse.
 * @param {string} url
 * @returns {string}
 */
export function hostOf(url) {
  try {
    return new URL(String(url).trim()).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * @typedef {object} WebResult
 * @property {string} url
 * @property {string} title
 * @property {string} snippet
 * @property {string|null} published  YYYY-MM-DD (or a prefix of whatever SearXNG reported)
 * @property {string} host
 */

/**
 * Top web results for a query from SearXNG (http(s) pages only, deduplicated, site front pages last).
 * Never throws: no query, no search URL, a non-200, bad JSON, a timeout or an abort all give [].
 * @param {string} query
 * @param {{ searchUrl?: string, limit?: number, timeoutMs?: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<WebResult[]>}
 */
export async function searchWeb(query, { searchUrl, limit = 5, timeoutMs = 8000, signal, fetchImpl = fetch } = {}) {
  const q = collapse(query);
  if (!q || !searchUrl || signal?.aborted) return [];
  const params = new URLSearchParams({ q, format: 'json', safesearch: '0' });
  const url = `${String(searchUrl).replace(/\/+$/, '')}/search?${params}`;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let payload;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.any(signals) });
    if (res.status !== 200) {
      res.body?.cancel?.().catch(() => {});
      console.warn(`[hedwig] web search: SearXNG returned ${res.status}`);
      return [];
    }
    payload = await res.json();
  } catch (err) {
    if (!signal?.aborted) console.warn('[hedwig] web search failed:', err?.name === 'TimeoutError' ? 'timed out' : err?.message || err);
    return [];
  }

  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const link = String(row.url || '').trim();
    const parsed = parseHttp(link);
    if (!parsed) continue;
    const key = canonicalUrl(link);
    if (seen.has(key)) continue;
    seen.add(key);
    const result = {
      url: link,
      title: collapse(row.title) || link,
      snippet: collapse(row.content).slice(0, SNIPPET_CHARS),
      published: String(row.publishedDate || '').slice(0, 10) || null,
      host: hostOf(link),
    };
    out.push({ result, front: parsed.pathname === '/' || parsed.pathname === '' });
  }
  // A site's front page rarely answers anything (Bing likes to return them): keep those after real pages.
  out.sort((a, b) => Number(a.front) - Number(b.front));
  return out.slice(0, limit).map((x) => x.result);
}

/**
 * Round-robin merge of several result lists (first of each, then second of each, …), deduplicated by
 * canonical URL.
 * @param {WebResult[][]} lists
 * @param {number} [limit]
 * @returns {WebResult[]}
 */
export function interleave(lists, limit = Infinity) {
  const sources = (Array.isArray(lists) ? lists : []).filter(Array.isArray);
  const longest = Math.max(0, ...sources.map((l) => l.length));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of sources) {
      const r = list[i];
      if (!r?.url) continue;
      const key = canonicalUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}
