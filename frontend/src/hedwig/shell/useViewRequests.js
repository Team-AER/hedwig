import { useEffect, useRef } from 'react';
import { useHedwig } from '../store.js';
import { useShell } from './state.js';

// useHedwig.openView → focus or open a pane for the requested view. Requests made while the
// shell was not mounted (classic mode) are not replayed when it mounts.
let handledNonce = null;
export function useViewRequests({ phone = false } = {}) {
  const req = useHedwig((s) => s.viewRequest);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; handledNonce = req?.nonce ?? null; return; }
    if (!req || handledNonce === req.nonce) return;
    handledNonce = req.nonce;
    useShell.getState().handleViewRequest(req, { phone });
  }, [req, phone]);
}
