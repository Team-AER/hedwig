// React hooks and side-effecting helpers shared by the Hedwig views.
import { useCallback, useEffect, useRef, useState } from 'react';
import { hedwigApi } from '../api.js';
import { useHedwig } from '../store.js';
import { useStore } from '../../store/index.js';
import { api } from '../../utils/api.js';

/**
 * GET a Hedwig path and keep { data, error, loading } for it. `path` null skips the request.
 * Options: pollMs (refresh interval), refreshOn (window event names that trigger a reload),
 * keepData (keep the previous data while reloading; default true).
 */
export function useResource(path, { pollMs, refreshOn, keepData = true } = {}) {
  const [state, setState] = useState({ data: undefined, error: null, loading: Boolean(path) });
  const seq = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!path) { setState({ data: undefined, error: null, loading: false }); return undefined; }
    const my = ++seq.current;
    if (!quiet) setState((s) => ({ data: keepData ? s.data : undefined, error: null, loading: true }));
    try {
      const data = await hedwigApi.get(path);
      if (my === seq.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (my === seq.current) setState((s) => ({ data: quiet ? s.data : (keepData ? s.data : undefined), error: quiet && s.data !== undefined ? s.error : error, loading: false }));
      return undefined;
    }
  }, [path, keepData]);

  useEffect(() => {
    // Drop the previous path's data so a view never shows one entity's card under another's id.
    setState({ data: undefined, error: null, loading: Boolean(path) });
    load();
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!path || !pollMs) return undefined;
    const t = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, pollMs);
    return () => clearInterval(t);
  }, [path, pollMs, load]);

  const events = (refreshOn || []).join('|');
  useEffect(() => {
    if (!path || !events) return undefined;
    const names = events.split('|');
    const h = () => load({ quiet: true });
    for (const n of names) window.addEventListener(n, h);
    return () => { for (const n of names) window.removeEventListener(n, h); };
  }, [path, events, load]);

  const setData = useCallback((updater) => {
    setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater }));
  }, []);

  return { ...state, reload: load, setData };
}

/** Run an async mutation with busy/error state. `run(...args)` resolves to the result or undefined. */
export function useAction(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const run = useCallback(async (...args) => {
    setBusy(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, clearError: () => setError(null) };
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useIsAdmin() {
  return useStore((s) => Boolean(s.user?.isAdmin));
}

let openSeq = 0;

/**
 * Open a message in upstream's reading pane without switching folders: fetch the row, park it
 * under a deep-link thread key (the same pattern MailApp's deep links and GTD use) and select it.
 * MessagePane handles mark-as-read. Also announces the open so the Hedwig shell can reveal the
 * reader pane.
 */
export async function openMessage(id, { lite } = {}) {
  if (!id) return null;
  const my = ++openSeq;
  const st = useStore.getState();
  const msg = await api.getMessage(id).catch(() => null);
  if (my !== openSeq) return null;
  const row = msg || (lite?.id ? lite : null); // a MessageLite still lets the pane load the body
  if (!row) {
    st.addNotification?.({ type: 'error', title: 'Message not found', body: 'It may have been moved or deleted.' });
    return null;
  }
  st.setThreadMessages(`__dl_${row.id}`, [row]);
  st.setSelectedMessage(row.id);
  window.dispatchEvent(new CustomEvent('hedwig:open-message', { detail: { id: row.id } }));
  return row;
}

/** Resolve a sender email to an entity and publish it as the selected entity (404 ignored). */
export async function selectSenderEntity(email) {
  if (!email) return null;
  try {
    const card = await hedwigApi.get(`/context/entities/by-email/${encodeURIComponent(email)}`);
    const id = card?.entity?.id;
    if (id) useHedwig.getState().setSelectedEntity(id);
    return card;
  } catch {
    return null;
  }
}

export function openSettings(view = 'hedwig.settings.personal') {
  useHedwig.getState().openView(view, {});
}

/** Close a popover on Escape or a click outside `ref`. */
export function useDismiss(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [ref, open, onClose]);
}

/** True when a keyboard event comes from a text field (so list shortcuts stay out of the way). */
export function isTypingTarget(e) {
  const t = e.target;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
