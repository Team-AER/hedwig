import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  OAUTH_PROVIDERS, MICROSOFT_SCOPE, getMicrosoftConfig, isOAuthConfigured,
  buildAuthorizeUrl, buildCodeExchangeBody, buildRefreshBody, microsoftLoginName, oauthProvider,
} from '../services/oauthProviders.js';

const ENV_KEYS = [
  'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI',
  'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_TENANT', 'MICROSOFT_TENANT_ID', 'MICROSOFT_REDIRECT_URI',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'APP_URL',
];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const parse = (url) => new URL(url);

describe('Microsoft config', () => {
  it('reads the MICROSOFT_* aliases, defaults the tenant to common and derives the redirect from APP_URL', () => {
    process.env.MICROSOFT_CLIENT_ID = 'ms-id';
    process.env.MICROSOFT_CLIENT_SECRET = 'ms-secret';
    process.env.APP_URL = 'https://hedwig.brainfc.uk/';
    expect(getMicrosoftConfig()).toEqual({
      clientId: 'ms-id',
      clientSecret: 'ms-secret',
      tenantId: 'common',
      redirectUri: 'https://hedwig.brainfc.uk/oauth/microsoft/callback',
    });
    expect(isOAuthConfigured('microsoft')).toBe(true);
  });

  it('prefers the upstream MS_* names (what the Integrations tab writes) over the aliases', () => {
    process.env.MICROSOFT_CLIENT_ID = 'alias-id';
    process.env.MS_CLIENT_ID = 'ui-id';
    process.env.MICROSOFT_TENANT = 'contoso.onmicrosoft.com';
    process.env.MS_TENANT_ID = 'tenant-guid';
    process.env.MICROSOFT_REDIRECT_URI = 'https://a.example/oauth/microsoft/callback';
    const cfg = getMicrosoftConfig();
    expect(cfg.clientId).toBe('ui-id');
    expect(cfg.tenantId).toBe('tenant-guid');
    expect(cfg.redirectUri).toBe('https://a.example/oauth/microsoft/callback');
  });

  it('uses MICROSOFT_TENANT when no MS_TENANT_ID is set', () => {
    process.env.MICROSOFT_TENANT = 'organizations';
    expect(getMicrosoftConfig().tenantId).toBe('organizations');
  });

  it('is not configured without a client ID, and has no redirect without APP_URL', () => {
    expect(isOAuthConfigured('microsoft')).toBe(false);
    expect(getMicrosoftConfig().redirectUri).toBeUndefined();
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the Microsoft v2.0 authorize URL for the tenant with IMAP/SMTP + offline scopes', () => {
    const url = parse(buildAuthorizeUrl('microsoft', {
      state: 'nonce-1',
      config: { clientId: 'ms-id', tenantId: 'contoso.onmicrosoft.com', redirectUri: 'https://h.example/oauth/microsoft/callback' },
    }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('ms-id');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('response_mode')).toBe('query');
    expect(q.get('redirect_uri')).toBe('https://h.example/oauth/microsoft/callback');
    expect(q.get('state')).toBe('nonce-1');
    const scopes = q.get('scope').split(' ');
    for (const s of ['offline_access', 'openid', 'email',
      'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send']) {
      expect(scopes).toContain(s);
    }
  });

  it('defaults the tenant segment to common from env config', () => {
    process.env.MICROSOFT_CLIENT_ID = 'ms-id';
    process.env.APP_URL = 'https://h.example';
    const url = parse(buildAuthorizeUrl('microsoft', { state: 's' }));
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://h.example/oauth/microsoft/callback');
  });

  it('builds the Google URL with offline access and forced consent (refresh token issuance)', () => {
    const url = parse(buildAuthorizeUrl('google', {
      state: 'g', config: { clientId: 'g-id', redirectUri: 'https://h.example/oauth/google/callback' },
    }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    expect(url.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(url.searchParams.has('response_mode')).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(() => oauthProvider('yahoo')).toThrow(/Unknown OAuth provider/);
  });
});

describe('token endpoint and request bodies per provider', () => {
  it('points each provider at its own token endpoint', () => {
    expect(OAUTH_PROVIDERS.microsoft.tokenUrl({ tenantId: 'common' }))
      .toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(OAUTH_PROVIDERS.microsoft.tokenUrl({ tenantId: 'tenant-guid' }))
      .toBe('https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token');
    expect(OAUTH_PROVIDERS.microsoft.deviceCodeUrl({ tenantId: 'consumers' }))
      .toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode');
    expect(OAUTH_PROVIDERS.google.tokenUrl({})).toBe('https://oauth2.googleapis.com/token');
  });

  it('Microsoft refresh: resource scopes only, secret for confidential clients', () => {
    const config = { clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'common' };
    const body = buildRefreshBody('microsoft', { refreshToken: 'rt', withSecret: true, config });
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('ms-id');
    expect(body.get('client_secret')).toBe('ms-secret');
    const scopes = body.get('scope').split(' ');
    expect(scopes).toContain('https://outlook.office.com/IMAP.AccessAsUser.All');
    expect(scopes).toContain('https://outlook.office.com/SMTP.Send');
    expect(scopes).toContain('offline_access');
    expect(scopes).not.toContain('openid');
  });

  it('Microsoft refresh: public (device-code) clients never send the secret (AADSTS90023)', () => {
    const config = { clientId: 'ms-id', clientSecret: 'ms-secret', tenantId: 'common' };
    expect(buildRefreshBody('microsoft', { refreshToken: 'rt', withSecret: false, config }).has('client_secret')).toBe(false);
  });

  it('Google refresh: no scope parameter, secret included', () => {
    const body = buildRefreshBody('google', { refreshToken: 'rt', config: { clientId: 'g-id', clientSecret: 'g-secret' } });
    expect(body.get('client_secret')).toBe('g-secret');
    expect(body.has('scope')).toBe(false);
    expect(body.get('grant_type')).toBe('refresh_token');
  });

  it('never sends the literal string "undefined" when no secret is configured', () => {
    const body = buildRefreshBody('google', { refreshToken: 'rt', config: { clientId: 'g-id' } });
    expect(body.has('client_secret')).toBe(false);
    const code = buildCodeExchangeBody('microsoft', { code: 'c', config: { clientId: 'ms-id', redirectUri: 'https://h/cb' } });
    expect(code.has('client_secret')).toBe(false);
    expect(code.get('grant_type')).toBe('authorization_code');
    expect(code.get('redirect_uri')).toBe('https://h/cb');
  });

  it('device-code and authorize flows request the same Microsoft scope set', () => {
    expect(OAUTH_PROVIDERS.microsoft.scope).toBe(MICROSOFT_SCOPE);
  });
});

describe('Microsoft mailbox + login name', () => {
  it('targets the Exchange Online endpoints', () => {
    expect(OAUTH_PROVIDERS.microsoft.mailbox).toMatchObject({
      imap_host: 'outlook.office365.com', imap_port: 993, imap_tls: true,
      smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'STARTTLS',
    });
  });

  it('logs in as the UPN (preferred_username), not an email alias', () => {
    expect(microsoftLoginName({ preferred_username: 'jane@contoso.onmicrosoft.com', email: 'jane@contoso.com' }, 'jane@contoso.com'))
      .toBe('jane@contoso.onmicrosoft.com');
  });

  it('falls back to the email when there is no UPN-shaped claim', () => {
    expect(microsoftLoginName({ preferred_username: 'jane' }, 'jane@outlook.com')).toBe('jane@outlook.com');
    expect(microsoftLoginName({}, 'jane@outlook.com')).toBe('jane@outlook.com');
  });
});
