// The mailbox sign-in window and how its result gets back to the page that opened it.
//
// The window runs /oauth/<provider>?popup=1 → the provider → /oauth/<provider>/callback → the app
// at /?oauth_success=<provider> (or ?oauth_error=…) with oauth_popup=1, where App.jsx calls
// reportSignInResult(). Google's and Microsoft's pages may set Cross-Origin-Opener-Policy, which
// cuts window.opener for good, so the result goes out twice: postMessage to the opener when there
// still is one (the shape upstream's Integrations tab listens for), and a same-origin
// BroadcastChannel, which does not depend on the opener at all.
import { signInPath } from './providers.js';

const CHANNEL = 'hedwig-oauth';

/** Open the sign-in window from a click handler. Returns false when the browser blocked it. */
export function openSignIn(signIn, { loginHint } = {}) {
  const url = signInPath(signIn, loginHint);
  const w = 520;
  const h = 680;
  const left = Math.round((window.screenX || 0) + Math.max(0, ((window.outerWidth || w) - w) / 2));
  const top = Math.round((window.screenY || 0) + Math.max(0, ((window.outerHeight || h) - h) / 2));
  let popup;
  try {
    popup = window.open(url, 'hedwig-signin', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  } catch {
    popup = null;
  }
  if (popup) {
    try { popup.focus(); } catch { /* cross-origin already */ }
    return true;
  }
  // Blocked, or an extension swallowed window.open: a real link click opens a tab instead,
  // which reports back the same way.
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'opener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return false;
}

/** Listen for sign-in results: onResult({ ok, provider, error }). Returns the unsubscribe. */
export function listenForSignIn(onResult) {
  const seen = new Set();
  const handle = (data) => {
    if (!data || (data.type !== 'oauth_success' && data.type !== 'oauth_error')) return;
    // Both channels deliver the same result; the id makes the second one a no-op.
    if (data.id) {
      if (seen.has(data.id)) return;
      seen.add(data.id);
    }
    onResult(data.type === 'oauth_success'
      ? { ok: true, provider: data.provider || null, error: null }
      : { ok: false, provider: data.provider || null, error: String(data.error || '') });
  };
  const onMessage = (e) => {
    if (e.origin !== window.location.origin) return;
    handle(e.data);
  };
  window.addEventListener('message', onMessage);
  let channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => handle(e.data);
  } catch {
    channel = null;
  }
  return () => {
    window.removeEventListener('message', onMessage);
    if (channel) channel.close();
  };
}

/**
 * The callback page's side: the result in the URL, if this page is a sign-in window's last stop.
 * A same-tab flow (no oauth_popup marker and no opener) returns null and MailApp handles it.
 */
export function signInResultFromUrl(search, { hasOpener = false } = {}) {
  const params = new URLSearchParams(search);
  const success = params.get('oauth_success');
  const error = params.get('oauth_error');
  if (!success && error == null) return null;
  if (params.get('oauth_popup') !== '1' && !hasOpener) return null;
  return success
    ? { type: 'oauth_success', provider: success }
    : { type: 'oauth_error', error: error || '' };
}

/** Send the result to the page that opened this window, by every route still open. */
export function reportSignInResult(result) {
  const message = { ...result, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  try {
    if (window.opener) window.opener.postMessage(message, window.location.origin);
  } catch { /* opener gone */ }
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch { /* no BroadcastChannel: the opener message is all there is */ }
}
