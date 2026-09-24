// OAuth provider table for mailboxes reached over IMAP/SMTP with SASL XOAUTH2.
//
// Microsoft switched off basic auth (a password on IMAP/SMTP) for Exchange Online /
// Microsoft 365 in 2022 and for personal Outlook.com accounts in September 2024, and
// Google Workspace admins can disable app passwords, so these mailboxes need an OAuth
// access token. routes/oauth.js runs the browser flows; imapManager (makeClientCfg) and
// smtpTransport consume the stored tokens. Everything provider-specific about the
// endpoints lives here so the flows and the token refresh build their requests one way.
//
// Pure: no DB, no network, no imports from index.js. Config is read from process.env at
// call time because the Integrations tab writes saved values into process.env at runtime
// (routes/integrations.js applyConfigToEnv).

export const MICROSOFT_LOGIN_BASE = 'https://login.microsoftonline.com';

// IMAP.AccessAsUser.All / SMTP.Send are the Exchange Online (outlook.office.com) delegated
// permissions. offline_access yields a refresh token; openid/email/profile give the
// id_token the callback reads the mailbox address and display name from.
export const MICROSOFT_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile';
// A refresh may only ask for resource scopes of one resource; the OIDC scopes are dropped.
export const MICROSOFT_REFRESH_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// https://mail.google.com/ is the full IMAP/SMTP scope, and it is *restricted*,
// which constrains how the consent screen must be configured:
//   - User Type "Internal" (project owned by a Workspace org): no verification,
//     refresh tokens do not expire. This is the practical option for self-hosting.
//   - "External" + Testing: works immediately, but Google revokes refresh tokens
//     after 7 days, so the account must be reconnected weekly.
//   - "External" + In production: needs full verification including a security
//     audit before restricted scopes are granted long-lived tokens.
export const GOOGLE_SCOPE = 'https://mail.google.com/ openid email profile';

// First non-empty env var wins. The MS_* names are upstream's (and what the Integrations
// tab writes), so they take precedence; MICROSOFT_* are the documented .env aliases.
function envFirst(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

function appUrl() {
  return (process.env.APP_URL || '').trim().replace(/\/+$/, '');
}

export function getMicrosoftConfig() {
  const base = appUrl();
  return {
    clientId: envFirst('MS_CLIENT_ID', 'MICROSOFT_CLIENT_ID'),
    clientSecret: envFirst('MS_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET'),
    tenantId: envFirst('MS_TENANT_ID', 'MICROSOFT_TENANT', 'MICROSOFT_TENANT_ID') || 'common',
    // The routes are mounted at /oauth (index.js), outside /api.
    redirectUri: envFirst('MS_REDIRECT_URI', 'MICROSOFT_REDIRECT_URI')
      || (base ? `${base}/oauth/microsoft/callback` : undefined),
  };
}

export function getGoogleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
  };
}

const microsoftTenantUrl = (cfg, leaf) =>
  `${MICROSOFT_LOGIN_BASE}/${encodeURIComponent(cfg.tenantId || 'common')}/oauth2/v2.0/${leaf}`;

export const OAUTH_PROVIDERS = Object.freeze({
  microsoft: Object.freeze({
    id: 'microsoft',
    label: 'Microsoft',
    getConfig: getMicrosoftConfig,
    authorizeUrl: (cfg) => microsoftTenantUrl(cfg, 'authorize'),
    tokenUrl: (cfg) => microsoftTenantUrl(cfg, 'token'),
    deviceCodeUrl: (cfg) => microsoftTenantUrl(cfg, 'devicecode'),
    scope: MICROSOFT_SCOPE,
    refreshScope: MICROSOFT_REFRESH_SCOPE,
    authorizeParams: Object.freeze({ response_mode: 'query', prompt: 'select_account' }),
    // Exchange Online / Outlook.com endpoints; XOAUTH2 works on both.
    mailbox: Object.freeze({
      imap_host: 'outlook.office365.com', imap_port: 993, imap_tls: true,
      smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'STARTTLS',
    }),
  }),
  google: Object.freeze({
    id: 'google',
    label: 'Google',
    getConfig: getGoogleConfig,
    authorizeUrl: () => GOOGLE_AUTH_URL,
    tokenUrl: () => GOOGLE_TOKEN_URL,
    deviceCodeUrl: null,
    scope: GOOGLE_SCOPE,
    refreshScope: null,
    // Google only issues a refresh token when both of these are set, and only on
    // the first consent unless prompt=consent forces re-issue. Without them a
    // reconnect silently yields an access-token-only grant that dies in an hour.
    authorizeParams: Object.freeze({ access_type: 'offline', prompt: 'consent select_account' }),
    mailbox: Object.freeze({
      imap_host: 'imap.gmail.com', imap_port: 993, imap_tls: true,
      smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_tls: 'STARTTLS',
    }),
  }),
});

export function oauthProvider(id) {
  const p = OAUTH_PROVIDERS[id];
  if (!p) throw new Error(`Unknown OAuth provider: ${id}`);
  return p;
}

/** True when the provider has a client ID (from .env or the Integrations tab). */
export function isOAuthConfigured(id) {
  return !!oauthProvider(id).getConfig().clientId;
}

/** Browser redirect URL for the authorization-code flow. */
export function buildAuthorizeUrl(id, { state, config } = {}) {
  const p = oauthProvider(id);
  const cfg = config || p.getConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    scope: p.scope,
    state,
    ...p.authorizeParams,
  });
  return `${p.authorizeUrl(cfg)}?${params}`;
}

/** POST body exchanging an authorization code for tokens (confidential client). */
export function buildCodeExchangeBody(id, { code, config } = {}) {
  const p = oauthProvider(id);
  const cfg = config || p.getConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  });
  if (cfg.clientSecret) params.set('client_secret', cfg.clientSecret);
  return params;
}

/**
 * POST body for a refresh_token grant. withSecret=false for public clients (Microsoft
 * device-code accounts), which Microsoft rejects if they send a secret (AADSTS90023).
 */
export function buildRefreshBody(id, { refreshToken, withSecret = true, config } = {}) {
  const p = oauthProvider(id);
  const cfg = config || p.getConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (p.refreshScope) params.set('scope', p.refreshScope);
  if (withSecret && cfg.clientSecret) params.set('client_secret', cfg.clientSecret);
  return params;
}

/**
 * The IMAP/SMTP login name for a Microsoft mailbox, from verified id_token claims. XOAUTH2
 * authenticates the token's principal, so the UPN (preferred_username) is the safe user=
 * value; the `email` claim can be an alias. Personal accounts carry the sign-in address
 * in preferred_username too. Falls back to the email when no UPN-shaped value exists.
 */
export function microsoftLoginName(claims = {}, email = null) {
  const upn = typeof claims.preferred_username === 'string' ? claims.preferred_username.trim() : '';
  if (upn && upn.includes('@')) return upn;
  return email || claims.email || null;
}

