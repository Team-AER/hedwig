// A connector's authorization request (/connect?request=<id>) survives signing in: the request id
// waits in sessionStorage while the person signs in (password, SSO round trip or screen lock), and
// App.jsx sends them back to /connect afterwards. Pure apart from the storage passed in, so
// node --test can pin it.
const KEY = 'hedwig_connect_request';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request id in a /connect URL, or null. */
export function requestFromUrl(pathname, search) {
  if (pathname !== '/connect') return null;
  const id = new URLSearchParams(search || '').get('request');
  return id && ID_RE.test(id) ? id : null;
}

export function rememberRequest(storage, id) {
  try { if (id) storage.setItem(KEY, id); } catch { /* storage unavailable: the person starts again */ }
}

export function pendingRequest(storage) {
  try {
    const id = storage.getItem(KEY);
    return id && ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function forgetRequest(storage) {
  try { storage.removeItem(KEY); } catch { /* nothing to forget */ }
}

/** Where to show the request: /connect?request=<id>. */
export const connectPath = (id) => `/connect?request=${encodeURIComponent(id)}`;
