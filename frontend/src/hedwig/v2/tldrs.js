// TL;DRs for rows that do not carry their own (Screener, Reading, Records): GET /work/tldr?ids=…
// (at most 200 ids a call) → { tldr: { [messageId]: { text, model, tier, lighter, … } } }. People
// rows come with `tldr` from /sort/stream/people. Answers are cached per message id; a message
// with no TL;DR yet is asked again after a few minutes (eager summaries fill in over time).
import { useEffect, useMemo, useState } from 'react';
import { v2Api } from './client.js';

const MAX_IDS = 200;
const MISS_TTL_MS = 5 * 60_000;
const cache = new Map(); // messageId → { value: tldr | null, at }
const inflight = new Set();
const listeners = new Set(); // every mounted useTldrs re-reads the cache when an answer lands

// Message ids are uuids; anything id-like is let through (the server drops the rest).
const ID = /^[\w-]{1,64}$/;

function fresh(id, now = Date.now()) {
  const hit = cache.get(id);
  return Boolean(hit) && (hit.value || now - hit.at < MISS_TTL_MS);
}

/** Forget every cached TL;DR (sign-out, tests). */
export function resetTldrCache() { cache.clear(); inflight.clear(); }

async function fetchTldrs(ids) {
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const chunk = ids.slice(i, i + MAX_IDS);
    chunk.forEach((id) => inflight.add(id));
    try {
      // A failed call counts as "none yet" for these ids, so they are not asked again at once.
      const d = await v2Api.get(`/work/tldr?ids=${chunk.join(',')}`).catch(() => null);
      const map = d?.tldr && typeof d.tldr === 'object' ? d.tldr : {};
      const now = Date.now();
      for (const id of chunk) cache.set(id, { value: map[id] || null, at: now });
    } finally {
      chunk.forEach((id) => inflight.delete(id));
      for (const fn of listeners) fn();
    }
  }
}

/**
 * TL;DRs for these message ids when `enabled` (the work routes are there). Returns a Map
 * messageId → tldr for the ids that have one.
 */
export function useTldrs(ids, enabled = true) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const fn = () => setVersion((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  const wanted = useMemo(() => [...new Set((ids || []).filter((id) => typeof id === 'string' && ID.test(id)))].sort(), [ids]);
  const missingKey = enabled ? wanted.filter((id) => !fresh(id) && !inflight.has(id)).join(',') : '';
  useEffect(() => {
    if (missingKey) fetchTldrs(missingKey.split(',')).catch(() => {});
  }, [missingKey]);
  return useMemo(() => {
    const out = new Map();
    for (const id of wanted) { const v = cache.get(id)?.value; if (v) out.set(id, v); }
    return out;
  }, [wanted, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Items with `tldr` filled in from the map where they have none of their own. */
export function withTldrs(items, map, idOf = (i) => i.messageId) {
  if (!map?.size) return items;
  return items.map((i) => (i.tldr || !map.has(idOf(i)) ? i : { ...i, tldr: map.get(idOf(i)) }));
}
