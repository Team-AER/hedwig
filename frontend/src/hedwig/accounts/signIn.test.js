// The sign-in window's result channel. Run with node --test src/hedwig/accounts/signIn.test.js
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://mail.example.invalid';
let opened;
let opener;
beforeEach(() => {
  opened = [];
  opener = null;
  const win = new EventTarget();
  Object.assign(win, {
    location: { origin: ORIGIN },
    screenX: 0, screenY: 0, outerWidth: 1200, outerHeight: 900,
    open: (url, name, features) => { opened.push({ url, name, features }); return { focus() {} }; },
    get opener() { return opener; },
  });
  globalThis.window = win;
});
afterEach(() => { delete globalThis.window; });

const { openSignIn, listenForSignIn, signInResultFromUrl, reportSignInResult } = await import('./signIn.js');
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('signInResultFromUrl', () => {
  test('reads a result on the sign-in window, marked or with an opener', () => {
    assert.deepEqual(signInResultFromUrl('?oauth_success=google&oauth_popup=1'), { type: 'oauth_success', provider: 'google' });
    assert.deepEqual(signInResultFromUrl('?oauth_error=Sign-in+was+cancelled.', { hasOpener: true }), { type: 'oauth_error', error: 'Sign-in was cancelled.' });
  });

  test('leaves a same-tab flow (no marker, no opener) and ordinary pages to the app', () => {
    assert.equal(signInResultFromUrl('?oauth_success=microsoft'), null);
    assert.equal(signInResultFromUrl('?oauth_popup=1'), null);
    assert.equal(signInResultFromUrl(''), null);
  });
});

describe('openSignIn', () => {
  test('opens a sized window at the start route', () => {
    assert.equal(openSignIn('microsoft', { loginHint: 'ana@contoso.example' }), true);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, '/oauth/microsoft?popup=1&login_hint=ana%40contoso.example');
    assert.equal(opened[0].name, 'hedwig-signin');
    assert.match(opened[0].features, /popup=yes,width=520,height=680/);
  });
});

describe('listenForSignIn + reportSignInResult', () => {
  test('hears a result once even though it arrives by postMessage and BroadcastChannel', async () => {
    const results = [];
    // The opener is this same window: the postMessage lands on our own listener.
    opener = { postMessage: (data, origin) => window.dispatchEvent(Object.assign(new Event('message'), { data, origin })) };
    const stop = listenForSignIn((r) => results.push(r));
    reportSignInResult({ type: 'oauth_success', provider: 'google' });
    await tick();
    stop();
    assert.deepEqual(results, [{ ok: true, provider: 'google', error: null }]);
  });

  test('hears a result over BroadcastChannel alone (a provider page cut window.opener)', async () => {
    const results = [];
    const stop = listenForSignIn((r) => results.push(r));
    reportSignInResult({ type: 'oauth_error', error: 'AADSTS65001: consent required' });
    await tick();
    stop();
    assert.deepEqual(results, [{ ok: false, provider: null, error: 'AADSTS65001: consent required' }]);
  });

  test('ignores messages from other origins and other kinds of message', async () => {
    const results = [];
    const stop = listenForSignIn((r) => results.push(r));
    window.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'oauth_success', provider: 'google' }, origin: 'https://evil.example' }));
    window.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'something_else' }, origin: ORIGIN }));
    await tick();
    stop();
    assert.equal(results.length, 0);
  });
});
