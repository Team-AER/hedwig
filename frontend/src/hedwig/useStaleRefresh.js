// Model pickers re-read the gateway's list when the pointer or focus reaches them and the list is
// older than gapMs, so a model added to the gateway since the page opened is there by the time the
// menu opens. Returns the handler for onMouseEnter / onFocus.
import { useCallback, useRef } from 'react';

export function useStaleRefresh(reload, gapMs = 10_000) {
  const loadedAt = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    if (now - loadedAt.current < gapMs) return;
    loadedAt.current = now;
    reload();
  }, [reload, gapMs]);
}
