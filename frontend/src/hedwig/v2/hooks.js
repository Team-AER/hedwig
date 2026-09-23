// Data hooks for the v2 views: the same { data, error, loading, reload, setData } contract as the
// v1 views' useResource, but through v2Api so the mock can answer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { v2Api, SORT_EVENTS, REFRESH_DEBOUNCE_MS } from './client.js';
import { useV2 } from './state.js';

/** Listen for the named window events and call `fn` once per burst, after the shared debounce. */
function useDebouncedEvents(events, fn, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled || !events) return undefined;
    const names = events.split('|');
    let t = null;
    const h = () => { clearTimeout(t); t = setTimeout(() => ref.current(), REFRESH_DEBOUNCE_MS); };
    for (const n of names) window.addEventListener(n, h);
    return () => { clearTimeout(t); for (const n of names) window.removeEventListener(n, h); };
  }, [events, enabled]);
}

export function useV2Resource(path, { refreshOn = SORT_EVENTS, pollMs } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: Boolean(path) });
  const seq = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!path) { setState({ data: undefined, error: null, loading: false }); return undefined; }
    const my = ++seq.current;
    if (!quiet) setState((s) => ({ data: s.data, error: null, loading: true }));
    try {
      const data = await v2Api.get(path);
      if (my === seq.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (my === seq.current) setState((s) => ({ data: s.data, error: quiet && s.data !== undefined ? s.error : error, loading: false }));
      return undefined;
    }
  }, [path]);

  useEffect(() => {
    setState({ data: undefined, error: null, loading: Boolean(path) });
    load();
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useDebouncedEvents((refreshOn || []).join('|'), () => load({ quiet: true }), Boolean(path));

  useEffect(() => {
    if (!path || !pollMs) return undefined;
    const t = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, pollMs);
    return () => clearInterval(t);
  }, [path, pollMs, load]);

  const setData = useCallback((updater) => {
    setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater }));
  }, []);

  return { ...state, reload: load, setData };
}

function withCursor(path, cursor) {
  return `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
}

const timeOf = (i) => { const t = Date.parse(i?.date || ''); return Number.isFinite(t) ? t : 0; };

/**
 * A paged list (`{ items, next }`, `next` the cursor for the following page). `loadMore()` appends
 * the next page. A quiet refresh (an event, the poll) reloads the first page and keeps the older
 * pages already loaded below it, so a refresh never shrinks what the user scrolled to.
 */
export function useV2Pages(path, { refreshOn = SORT_EVENTS, pollMs, key = 'items' } = {}) {
  const empty = { items: [], next: null, pages: 0, error: null, loading: Boolean(path), loadingMore: false, loaded: false };
  const [state, setState] = useState(empty);
  const seq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const pick = (d) => ({ items: Array.isArray(d) ? d : (Array.isArray(d?.[key]) ? d[key] : []), next: d?.next || null });

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!path) { setState({ ...empty, loading: false }); return; }
    const my = ++seq.current;
    if (!quiet) setState((s) => ({ ...s, error: null, loading: true }));
    try {
      const page = pick(await v2Api.get(path));
      if (my !== seq.current) return;
      setState((s) => {
        if (!quiet || s.pages <= 1) return { ...s, ...page, pages: 1, error: null, loading: false, loaded: true };
        const ids = new Set(page.items.map((i) => i.messageId || i.threadId));
        const floor = page.items.length ? timeOf(page.items[page.items.length - 1]) : Infinity;
        const tail = s.items.filter((i) => !ids.has(i.messageId || i.threadId) && timeOf(i) <= floor);
        return { ...s, items: [...page.items, ...tail], next: page.next ? s.next : null, error: null, loading: false, loaded: true };
      });
    } catch (error) {
      if (my === seq.current) setState((s) => ({ ...s, error: quiet && s.loaded ? s.error : error, loading: false }));
    }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(async () => {
    const s = stateRef.current;
    if (!path || !s.next || s.loadingMore) return;
    const my = seq.current;
    setState((x) => ({ ...x, loadingMore: true }));
    try {
      const page = pick(await v2Api.get(withCursor(path, s.next)));
      if (my !== seq.current) { setState((x) => ({ ...x, loadingMore: false })); return; }
      setState((x) => {
        const ids = new Set(x.items.map((i) => i.messageId || i.threadId));
        return { ...x, items: [...x.items, ...page.items.filter((i) => !ids.has(i.messageId || i.threadId))], next: page.next, pages: x.pages + 1, loadingMore: false };
      });
    } catch (error) {
      setState((x) => ({ ...x, loadingMore: false, error }));
    }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setState({ ...empty, loading: Boolean(path) });
    load();
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useDebouncedEvents((refreshOn || []).join('|'), () => load({ quiet: true }), Boolean(path));

  useEffect(() => {
    if (!path || !pollMs) return undefined;
    const t = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, pollMs);
    return () => clearInterval(t);
  }, [path, pollMs, load]);

  const setItems = useCallback((updater) => {
    setState((s) => ({ ...s, items: typeof updater === 'function' ? updater(s.items) : updater }));
  }, []);

  return { ...state, reload: load, loadMore, setItems };
}

/**
 * Whether the work routes (Reply Later, Set Aside, Snoozed, the thread story, drafting, the send
 * guard) are there. Asked once per session (GET /work/lists, cached in useV2); until the answer
 * is in, and after a 404, the controls that need them stay hidden rather than failing.
 */
export function useWork() {
  const work = useV2((s) => s.caps.work);
  useEffect(() => { if (work === null) useV2.getState().probeWork(); }, [work]);
  return work === true;
}

/** Run an async action with busy/error state; resolves to the result or undefined on error. */
export function useRun() {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = useCallback(async (key, fn) => {
    setBusy(key);
    setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(null); }
  }, []);
  return { run, busy, error, clear: () => setError(null) };
}

/** True when an error means "this route is not there yet" (the owning stream has not shipped it). */
export function isMissing(err) {
  return Boolean(err) && (err.status === 404 || err.status === 501);
}
