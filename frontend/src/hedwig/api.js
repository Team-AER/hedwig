// Client for /api/hedwig. Same CSRF header and session semantics as utils/api.js.
import { CSRF_HEADER, CSRF_VALUE } from '../utils/api.js';

const BASE = '/api/hedwig';

async function request(method, path, body) {
  const opts = { method, credentials: 'include', headers: { [CSRF_HEADER]: CSRF_VALUE } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('mailflow:session_expired'));
    const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
    const e = new Error(err.error || 'Request failed');
    e.status = res.status;
    throw e;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export const hedwigApi = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  patch: (path, body = {}) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

/**
 * POST and read a Server-Sent Events stream. Each `data:` line is JSON; `onEvent` receives it.
 * Resolves when the stream ends. Throws on HTTP errors.
 */
export async function hedwigStream(path, body, { onEvent, signal } = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE, Accept: 'text/event-stream' },
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `Request failed (${res.status})` }));
    throw new Error(err.error || 'Request failed');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onEvent?.(JSON.parse(data)); } catch { /* ignore malformed event */ }
      }
    }
  }
}
