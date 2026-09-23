// The v2 views' API client. Real calls go through hedwigApi (/api/hedwig/...). With
// VITE_HEDWIG_MOCK=1 (or setMockMode(true) in tests) every call is answered by mock.js instead,
// using the response shapes in docs/hedwig/V2-BUILD.md, so the views can be built and checked
// before the sorting, labels and index routes land.
import { hedwigApi, hedwigStream } from '../api.js';

const env = import.meta.env || {};
let mock = env.VITE_HEDWIG_MOCK === '1' || env.VITE_HEDWIG_MOCK === 'true';

export function isMockMode() { return mock; }
export function setMockMode(on) { mock = Boolean(on); }

function call(method, path, body) {
  if (mock) return import('./mock.js').then((m) => m.mockRequest(method, path, body));
  if (method === 'GET') return hedwigApi.get(path);
  if (method === 'POST') return hedwigApi.post(path, body);
  if (method === 'PATCH') return hedwigApi.patch(path, body);
  if (method === 'PUT') return hedwigApi.put(path, body);
  return hedwigApi.del(path);
}

// Identical GETs in flight at the same moment share one request: a sort change wakes the counts
// and every mounted view on the same debounce tick, and several of them ask for the same list.
const inflight = new Map();
function get(path) {
  const hit = inflight.get(path);
  if (hit) return hit;
  const p = Promise.resolve().then(() => call('GET', path)).finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

export const v2Api = {
  get,
  post: (path, body = {}) => call('POST', path, body),
  patch: (path, body = {}) => call('PATCH', path, body),
  put: (path, body = {}) => call('PUT', path, body),
  del: (path) => call('DELETE', path),
};

/**
 * A streaming POST (SSE, one JSON event per `data:` line) through hedwigStream; the mock answers
 * it with the same events. Resolves when the stream ends.
 */
export function v2Stream(path, body, { onEvent, signal } = {}) {
  if (mock) return import('./mock.js').then((m) => m.mockStream(path, body, { onEvent, signal }));
  return hedwigStream(path, body, { onEvent, signal });
}

// Some routes answer with a bare array, some wrap it; views accept either.
export function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[key])) return data[key];
  return [];
}

let lastLocalChange = 0;
/** When the user last changed sorting from this tab (ms since epoch); the counts toast skips it. */
export function lastLocalSortChange() { return lastLocalChange; }

/** Tell every v2 view and the counts that sorting changed (a decision, a correction, an undo). */
export function announceSortChange(detail) {
  lastLocalChange = Date.now();
  inflight.clear(); // a GET that started before the change must not answer for after it
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hedwig:sort-changed', { detail }));
}

export const SORT_EVENTS = ['hedwig:sort-changed'];
// Fired by the background counts poll when a count moved without the user doing anything here
// (new mail sorted on the server): the stream lists reload on it, so a "needs you" toast never
// points at a list that does not show the message yet.
export const COUNTS_EVENT = 'hedwig:counts-changed';
// Every listener waits the same short beat after an event, so the reloads it triggers land on
// one tick and identical GETs share a request.
export const REFRESH_DEBOUNCE_MS = 300;
