import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// The sign-in starts in its own window (Settings → Accounts → Add account). Every way out of
// the start route has to be a redirect, so the window lands on the app and reports back; a JSON
// error would leave the user on a blank page. Same inert mocks as oauth.refresh.test.js.
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../services/encryption.js', () => ({ encrypt: (v) => v, decrypt: (v) => v }));

const { default: express } = await import('express');
const { default: oauthRoutes } = await import('./oauth.js');

const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'MS_CLIENT_ID', 'MS_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'APP_URL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let signedIn = true;
let sessionPopup = false; // what a start route stored for the callback
let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = signedIn ? { userId: 'u1', oauthPopup: sessionPopup, save: (cb) => cb() } : {};
    next();
  });
  app.use('/oauth', oauthRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
afterEach(() => {
  signedIn = true;
  sessionPopup = false;
  for (const k of ENV_KEYS) delete process.env[k];
});

const start = async (path) => {
  const res = await fetch(`${base}${path}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') || '' };
};
const appError = (location) => new URL(location, 'https://app.example').searchParams.get('oauth_error');

describe('GET /oauth/:provider (start)', () => {
  it('redirects an unconfigured provider back to the app with a readable oauth_error', async () => {
    for (const [path, label] of [['/oauth/google', 'Google'], ['/oauth/microsoft', 'Microsoft']]) {
      const { status, location } = await start(path);
      expect(status).toBe(302);
      expect(location.startsWith('/?')).toBe(true);
      expect(appError(location)).toBe(`${label} sign-in is not set up on this Hedwig yet.`);
    }
  });

  it('redirects a signed-out request back to the app too', async () => {
    signedIn = false;
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.APP_URL = 'https://mail.example.org';
    const { status, location } = await start('/oauth/google');
    expect(status).toBe(302);
    expect(appError(location)).toBe('Sign in to Hedwig first, then try again.');
  });

  it('sends a configured Google sign-in to Google with the address pre-filled', async () => {
    process.env.GOOGLE_CLIENT_ID = 'g-id';
    process.env.APP_URL = 'https://mail.example.org';
    const { status, location } = await start('/oauth/google?login_hint=ana%40example.org');
    expect(status).toBe(302);
    const url = new URL(location);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('login_hint')).toBe('ana@example.org');
    expect(url.searchParams.get('redirect_uri')).toBe('https://mail.example.org/oauth/google/callback');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sends a configured Microsoft sign-in to the tenant, without a hint when none is given', async () => {
    process.env.MS_CLIENT_ID = 'ms-id';
    process.env.APP_URL = 'https://mail.example.org';
    const { location } = await start('/oauth/microsoft');
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.has('login_hint')).toBe(false);
  });
});

describe('the sign-in window marker (oauth_popup=1)', () => {
  it('rides along on a start failure in the sign-in window, and not in a same-tab flow', async () => {
    const popup = await start('/oauth/google?popup=1');
    expect(new URL(popup.location, 'https://app.example').searchParams.get('oauth_popup')).toBe('1');
    const sameTab = await start('/oauth/google');
    expect(new URL(sameTab.location, 'https://app.example').searchParams.has('oauth_popup')).toBe(false);
  });
});

describe('GET /oauth/:provider/callback', () => {
  it('reports a cancelled consent to the app', async () => {
    const { status, location } = await start('/oauth/google/callback?error=access_denied');
    expect(status).toBe(302);
    expect(appError(location)).toBe('Sign-in was cancelled.');
  });

  it('marks the result for the sign-in window when the start recorded one', async () => {
    sessionPopup = true;
    const { location } = await start('/oauth/microsoft/callback?error=access_denied');
    const q = new URL(location, 'https://app.example').searchParams;
    expect(q.get('oauth_error')).toBe('Sign-in was cancelled.');
    expect(q.get('oauth_popup')).toBe('1');
  });

  it('rejects a callback whose state does not match the session nonce, still as a redirect', async () => {
    const { status, location } = await start('/oauth/google/callback?code=c&state=forged');
    expect(status).toBe(302);
    expect(appError(location)).toBe('Invalid OAuth state — please try again');
  });
});
