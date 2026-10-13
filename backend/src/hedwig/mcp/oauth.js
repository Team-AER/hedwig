// The OAuth 2.1 authorization server behind Hedwig's MCP endpoint, the part Claude, ChatGPT and other
// MCP clients go through before they may call a tool. Clients register themselves (RFC 7591), send
// the person to /mcp/oauth/authorize (PKCE S256 only), and the person allows or declines on
// Hedwig's /connect page while signed in to Hedwig. Allowing makes a grant; tokens are opaque random
// strings stored only as SHA-256 hashes, so a database dump holds nothing usable. Metadata follows
// RFC 8414 (the server) and RFC 9728 (the protected resource, /mcp).
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { query } from '../../services/db.js';

export const SCOPES = Object.freeze(['mail.read', 'mail.write']);
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_DAYS = 90;
const REQUEST_TTL_MIN = 15;
const CODE_TTL_S = 120;
// A rotated refresh token keeps working this long, so two refreshes racing each other (a client
// retrying, two workers) do not disconnect the person.
const ROTATION_GRACE_S = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

export class OAuthError extends Error {
  /** `show`: tell the person on a page instead of redirecting (the redirect URI is not trusted). */
  constructor(error, description, { status = 400, show = false } = {}) {
    super(description || error);
    this.error = error;
    this.description = description || null;
    this.status = status;
    this.show = show;
  }

  toJSON() {
    return { error: this.error, ...(this.description ? { error_description: this.description } : {}) };
  }
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const newToken = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The public origin: APP_URL (required in production), else what the request says. */
export function publicOrigin(req) {
  const app = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (app) return app;
  return `${req.protocol}://${req.get('host')}`;
}

export const resourceUrl = (origin) => `${origin}/mcp`;
const sameResource = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

export function authServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/mcp/oauth/authorize`,
    token_endpoint: `${origin}/mcp/oauth/token`,
    registration_endpoint: `${origin}/mcp/oauth/register`,
    revocation_endpoint: `${origin}/mcp/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/connect`,
  };
}

export function resourceMetadata(origin) {
  return {
    resource: resourceUrl(origin),
    resource_name: 'Hedwig',
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
  };
}

// ── Clients ─────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A redirect URI a client may register: https anywhere, http only back to this machine (CLI clients
 * such as Claude Code listen on a loopback port), or a private-use scheme of a native app
 * (cursor://…). Never javascript:, data:, file: or a fragment.
 */
export function redirectUriProblem(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return 'must be a URL';
  let u;
  try { u = new URL(raw); } catch { return 'must be an absolute URL'; }
  if (u.hash) return 'must not have a fragment';
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return null;
  if (scheme === 'http') return LOOPBACK.has(u.hostname.toLowerCase()) ? null : 'http is allowed only for localhost';
  if (['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ws', 'wss', 'ftp'].includes(scheme)) return `the ${scheme} scheme is not allowed`;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? null : 'has an invalid scheme';
}

/** Loopback redirects may come back on any port (RFC 8252 §7.3); everything else must match exactly. */
export function redirectMatches(registered, given) {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    return a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK.has(a.hostname) && a.hostname === b.hostname
      && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  // Control characters become spaces (a name is shown on the /connect page).
  const s = [...v].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** RFC 7591 dynamic client registration. */
export async function registerClient(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URLs');
  for (const u of uris) {
    const problem = redirectUriProblem(u);
    if (problem) throw new OAuthError('invalid_redirect_uri', `${String(u).slice(0, 200)} ${problem}`);
  }
  const grantTypes = b.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code') || grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
    throw new OAuthError('invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token');
  }
  if (b.response_types !== undefined && (!Array.isArray(b.response_types) || b.response_types.some((t) => t !== 'code'))) {
    throw new OAuthError('invalid_client_metadata', 'response_types may only be code');
  }
  // RFC 7591's default is client_secret_basic; a public client says 'none'.
  const method = b.token_endpoint_auth_method ?? 'client_secret_basic';
  if (!AUTH_METHODS.includes(method)) throw new OAuthError('invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`);
  const name = cleanText(b.client_name, 100) || 'MCP client';
  const clientUri = typeof b.client_uri === 'string' && /^https:\/\//i.test(b.client_uri) ? b.client_uri.slice(0, 500) : null;

  const clientId = `hwc_${randomBytes(16).toString('base64url')}`;
  const secret = method === 'none' ? null : newToken('hws');
  // Clients that registered but never connected anyone are dropped after a week.
  await query(
    `DELETE FROM hedwig_mcp_clients c WHERE c.created_at < NOW() - INTERVAL '7 days'
        AND NOT EXISTS (SELECT 1 FROM hedwig_mcp_grants g WHERE g.client_id = c.client_id)`,
  ).catch(() => {});
  const { rows: [row] } = await query(
    `INSERT INTO hedwig_mcp_clients (client_id, client_secret_hash, client_name, client_uri, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
    [clientId, secret ? sha(secret) : null, name, clientUri, uris, method],
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(new Date(row?.created_at || Date.now()).getTime() / 1000),
    client_name: name,
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: uris,
    grant_types: grantTypes,
    response_types: ['code'],
    token_endpoint_auth_method: method,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  };
}

export async function getClient(clientId) {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 200) return null;
  const { rows } = await query('SELECT * FROM hedwig_mcp_clients WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

/** Client credentials from a token or revocation request: HTTP Basic, or the form body. */
export function clientCredentials(req) {
  const h = String(req.get?.('authorization') || '');
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      try {
        return { clientId: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)), via: 'basic' };
      } catch {
        return { clientId: decoded.slice(0, i), secret: decoded.slice(i + 1), via: 'basic' };
      }
    }
  }
  const body = req.body || {};
  return { clientId: body.client_id || null, secret: body.client_secret || null, via: body.client_secret ? 'post' : 'none' };
}

async function authenticateClient({ clientId, secret }) {
  const client = await getClient(clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client', { status: 401 });
  if (client.token_endpoint_auth_method !== 'none') {
    if (!secret || !sameHash(sha(secret), client.client_secret_hash)) throw new OAuthError('invalid_client', 'Client authentication failed', { status: 401 });
  }
  return client;
}

// ── Authorization ───────────────────────────────────────────────────────────

/** The scopes asked for: known ones only; none named means everything. mail.read always comes along. */
export function parseScopes(raw) {
  const asked = String(raw || '').split(/\s+/).filter((s) => SCOPES.includes(s));
  const set = new Set(asked.length ? asked : SCOPES);
  set.add('mail.read');
  return SCOPES.filter((s) => set.has(s));
}

export function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

/**
 * GET /mcp/oauth/authorize. Returns { requestId } for the /connect page. Throws OAuthError: with
 * `show` when the client or redirect URI is wrong (that is said on a page), otherwise with
 * `redirect` set to the client's redirect URI carrying the error.
 */
export async function startAuthorization(params = {}, { origin }) {
  const client = await getClient(params.client_id);
  if (!client) throw new OAuthError('invalid_client', 'This app is not registered with Hedwig. Remove the connector and add it again.', { show: true });
  let redirectUri = params.redirect_uri;
  if (!redirectUri) {
    if (client.redirect_uris.length !== 1) throw new OAuthError('invalid_request', 'redirect_uri is required', { show: true });
    redirectUri = client.redirect_uris[0];
  }
  if (!client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) {
    throw new OAuthError('invalid_request', 'The redirect URI is not one this app registered.', { show: true });
  }
  const fail = (error, description) => {
    const err = new OAuthError(error, description);
    err.redirect = withParams(redirectUri, { error, error_description: description, state: params.state, iss: origin });
    return err;
  };
  if (params.response_type !== 'code') throw fail('unsupported_response_type', 'Only response_type=code is supported');
  if (!params.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(params.code_challenge)) throw fail('invalid_request', 'A PKCE code_challenge is required');
  if ((params.code_challenge_method || 'plain') !== 'S256') throw fail('invalid_request', 'code_challenge_method must be S256');
  if (params.resource && !sameResource(params.resource, resourceUrl(origin))) throw fail('invalid_target', `resource must be ${resourceUrl(origin)}`);

  await query('DELETE FROM hedwig_mcp_requests WHERE expires_at < NOW()').catch(() => {});
  const { rows: [row] } = await query(
    `INSERT INTO hedwig_mcp_requests (client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(mins => $7)) RETURNING id`,
    [client.client_id, redirectUri, typeof params.state === 'string' ? params.state.slice(0, 2000) : null, params.code_challenge,
      parseScopes(params.scope), params.resource || null, REQUEST_TTL_MIN],
  );
  return { requestId: row.id };
}

function notFound(message = 'This connection request has expired. Start again from the app you were connecting.') {
  const err = new Error(message);
  err.status = 404;
  return err;
}

async function openRequest(id) {
  if (!UUID_RE.test(String(id || ''))) throw notFound();
  const { rows } = await query(
    `SELECT r.*, c.client_name, c.client_uri FROM hedwig_mcp_requests r JOIN hedwig_mcp_clients c ON c.client_id = r.client_id
      WHERE r.id = $1 AND r.expires_at > NOW() AND r.code_hash IS NULL`,
    [id],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

const hostOf = (uri) => {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : `${u.protocol}//`;
  } catch {
    return null;
  }
};

/** What the /connect page shows: who is asking, where the person goes back to, what for. */
export async function describeRequest(id) {
  const r = await openRequest(id);
  return {
    id: r.id,
    client: { name: r.client_name, uri: r.client_uri || null },
    redirectHost: hostOf(r.redirect_uri),
    scopes: r.scopes,
    expiresAt: r.expires_at,
  };
}

/** The person allows it. `write: false` connects read-only even when the app asked for more. */
export async function approveRequest(userId, id, { write = true } = {}, { origin }) {
  const r = await openRequest(id);
  const scopes = r.scopes.filter((s) => s !== 'mail.write' || write);
  const code = newToken('hwk');
  const { rowCount } = await query(
    `UPDATE hedwig_mcp_requests SET user_id = $2, scopes = $3, code_hash = $4, code_expires_at = NOW() + make_interval(secs => $5)
      WHERE id = $1 AND code_hash IS NULL AND expires_at > NOW()`,
    [r.id, userId, scopes, sha(code), CODE_TTL_S],
  );
  if (!rowCount) throw notFound();
  return { redirect: withParams(r.redirect_uri, { code, state: r.state, iss: origin }) };
}

export async function denyRequest(id, { origin }) {
  const r = await openRequest(id);
  await query('DELETE FROM hedwig_mcp_requests WHERE id = $1', [r.id]);
  return { redirect: withParams(r.redirect_uri, { error: 'access_denied', error_description: 'The person declined the connection', state: r.state, iss: origin }) };
}

// ── Tokens ──────────────────────────────────────────────────────────────────

async function issueTokens(grantId, scopes) {
  const access = newToken('hw_at');
  const refresh = newToken('hw_rt');
  await query(
    `INSERT INTO hedwig_mcp_tokens (token_hash, grant_id, kind, expires_at) VALUES
       ($1, $3, 'access', NOW() + make_interval(secs => $4)),
       ($2, $3, 'refresh', NOW() + make_interval(days => $5))`,
    [sha(access), sha(refresh), grantId, ACCESS_TTL_S, REFRESH_TTL_DAYS],
  );
  // Expired tokens are kept a day (a late refresh says invalid_grant, not "unknown"), then dropped.
  query("DELETE FROM hedwig_mcp_tokens WHERE expires_at < NOW() - INTERVAL '1 day'").catch(() => {});
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(' ') };
}

export function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return sameHash(computed, String(challenge || ''));
}

/** POST /mcp/oauth/token, grant_type=authorization_code. */
export async function exchangeCode(body, creds, { origin }) {
  const client = await authenticateClient(creds);
  if (typeof body.code !== 'string' || !body.code) throw new OAuthError('invalid_request', 'code is required');
  // Deleting it is what makes the code single-use, even under concurrent requests.
  const { rows: [r] } = await query('DELETE FROM hedwig_mcp_requests WHERE code_hash = $1 RETURNING *', [sha(body.code)]);
  if (!r || !r.user_id || new Date(r.code_expires_at) <= new Date()) throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired');
  if (r.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'The code was issued to another client');
  if (body.redirect_uri && body.redirect_uri !== r.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
  if (!pkceMatches(body.code_verifier, r.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
  if (body.resource && !sameResource(body.resource, resourceUrl(origin))) throw new OAuthError('invalid_target', `resource must be ${resourceUrl(origin)}`);
  const { rows: [g] } = await query(
    'INSERT INTO hedwig_mcp_grants (user_id, client_id, scopes, resource) VALUES ($1, $2, $3, $4) RETURNING id',
    [r.user_id, client.client_id, r.scopes, r.resource || body.resource || null],
  );
  return issueTokens(g.id, r.scopes);
}

/** POST /mcp/oauth/token, grant_type=refresh_token. Rotates the refresh token. */
export async function refreshTokens(body, creds) {
  const client = await authenticateClient(creds);
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required');
  const { rows: [t] } = await query(
    `SELECT t.token_hash, g.id AS grant_id, g.client_id, g.scopes FROM hedwig_mcp_tokens t JOIN hedwig_mcp_grants g ON g.id = t.grant_id
      WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.expires_at > NOW() AND g.revoked_at IS NULL`,
    [sha(body.refresh_token)],
  );
  if (!t || t.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'The refresh token is invalid, expired or revoked');
  await query(
    'UPDATE hedwig_mcp_tokens SET expires_at = LEAST(expires_at, NOW() + make_interval(secs => $2)) WHERE token_hash = $1',
    [t.token_hash, ROTATION_GRACE_S],
  );
  return issueTokens(t.grant_id, t.scopes);
}

/** RFC 7009. A refresh token ends the whole connection; an access token only itself. */
export async function revokeToken(body, creds) {
  const client = await authenticateClient(creds);
  if (typeof body.token !== 'string' || !body.token) return;
  const { rows: [t] } = await query(
    `SELECT t.token_hash, t.kind, t.grant_id, g.client_id FROM hedwig_mcp_tokens t JOIN hedwig_mcp_grants g ON g.id = t.grant_id
      WHERE t.token_hash = $1`,
    [sha(body.token)],
  );
  if (!t || t.client_id !== client.client_id) return;
  if (t.kind === 'refresh') await endGrant(t.grant_id);
  else await query('DELETE FROM hedwig_mcp_tokens WHERE token_hash = $1', [t.token_hash]);
}

/** The connection behind a bearer token, or null. */
export async function verifyAccessToken(token, { origin }) {
  if (typeof token !== 'string' || !token.startsWith('hw_at_') || token.length > 200) return null;
  const { rows: [row] } = await query(
    `SELECT g.id AS grant_id, g.user_id, g.scopes, g.resource, c.client_id, c.client_name
       FROM hedwig_mcp_tokens t JOIN hedwig_mcp_grants g ON g.id = t.grant_id JOIN hedwig_mcp_clients c ON c.client_id = g.client_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > NOW() AND g.revoked_at IS NULL`,
    [sha(token)],
  );
  if (!row) return null;
  if (row.resource && !sameResource(row.resource, resourceUrl(origin))) return null;
  return { grantId: row.grant_id, userId: row.user_id, scopes: row.scopes, clientId: row.client_id, clientName: row.client_name };
}

// ── Connections (Settings → Connectors) ─────────────────────────────────────

async function endGrant(grantId) {
  await query('UPDATE hedwig_mcp_grants SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [grantId]);
  await query('DELETE FROM hedwig_mcp_tokens WHERE grant_id = $1', [grantId]);
}

export async function listGrants(userId) {
  const { rows } = await query(
    `SELECT g.id, g.scopes, g.calls, g.created_at, g.last_used_at, c.client_name, c.client_uri, c.redirect_uris
       FROM hedwig_mcp_grants g JOIN hedwig_mcp_clients c ON c.client_id = g.client_id
      WHERE g.user_id = $1 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.client_name,
    host: hostOf(r.client_uri || r.redirect_uris?.[0]),
    scopes: r.scopes,
    calls: Number(r.calls) || 0,
    connectedAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export async function revokeGrant(userId, grantId) {
  if (!UUID_RE.test(String(grantId || ''))) throw notFound('Connection not found');
  const { rowCount } = await query('UPDATE hedwig_mcp_grants SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [grantId, userId]);
  if (!rowCount) throw notFound('Connection not found');
  await query('DELETE FROM hedwig_mcp_tokens WHERE grant_id = $1', [grantId]);
  return { ok: true };
}

export async function recordUse(grantId) {
  await query('UPDATE hedwig_mcp_grants SET calls = calls + 1, last_used_at = NOW() WHERE id = $1', [grantId]).catch(() => {});
}

export async function recordActivity({ grantId, userId, tool, summary, ok }) {
  await query(
    'INSERT INTO hedwig_mcp_activity (grant_id, user_id, tool, summary, ok) VALUES ($1, $2, $3, $4, $5)',
    [grantId, userId, tool, summary ? String(summary).slice(0, 300) : null, Boolean(ok)],
  ).catch((err) => console.warn('[hedwig] mcp: could not record activity:', err.message));
}

export async function recentActivity(userId, { limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT a.id, a.tool, a.summary, a.ok, a.created_at, c.client_name
       FROM hedwig_mcp_activity a JOIN hedwig_mcp_grants g ON g.id = a.grant_id JOIN hedwig_mcp_clients c ON c.client_id = g.client_id
      WHERE a.user_id = $1 AND a.created_at > NOW() - INTERVAL '30 days' ORDER BY a.created_at DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(100, Number(limit) || 20))],
  );
  return rows.map((r) => ({ id: Number(r.id), app: r.client_name, tool: r.tool, summary: r.summary, ok: r.ok, at: r.created_at }));
}
