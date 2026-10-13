// HTTP for connectors. Public (no session): the MCP endpoint itself (POST /mcp, Streamable HTTP with
// JSON responses, bearer tokens), OAuth discovery under /.well-known, and the OAuth endpoints under
// /mcp/oauth. Signed in (mounted by the module under /api/hedwig): the /connect page's request API
// and Settings → Connectors.
import express, { Router } from 'express';
import { readFileSync } from 'fs';
import {
  OAuthError, publicOrigin, resourceUrl, authServerMetadata, resourceMetadata, registerClient, startAuthorization,
  clientCredentials, exchangeCode, refreshTokens, revokeToken, verifyAccessToken, describeRequest, approveRequest,
  denyRequest, listGrants, revokeGrant, recentActivity,
} from './oauth.js';
import { handleMessage, PROTOCOL_VERSIONS, RPC } from './server.js';

let appVersion = '1.0.0';
try { appVersion = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || appVersion; } catch { /* keep the default */ }

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function errorPage(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hedwig</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;box-sizing:border-box;background:#f5f5f7;color:#1d1d1f}
main{max-width:380px;text-align:center}h1{font-size:17px;margin:0 0 6px}p{margin:0;color:#6e6e73}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}p{color:#a1a1a6}}</style></head>
<body><main><h1>Hedwig could not connect this app</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

// Registration is open (that is how Claude and ChatGPT add a connector), so it is rate limited.
const REGISTER_LIMIT = 20;
const registrations = new Map();
function registerAllowed(ip, now = Date.now()) {
  for (const [k, v] of registrations) if (v.resetAt <= now) registrations.delete(k);
  const entry = registrations.get(ip) || { count: 0, resetAt: now + 3600_000 };
  entry.count += 1;
  registrations.set(ip, entry);
  return entry.count <= REGISTER_LIMIT;
}
export function _resetRegistrations() { registrations.clear(); }

function oauthFail(res, err) {
  if (!(err instanceof OAuthError)) throw err;
  if (err.status === 401) res.set('WWW-Authenticate', 'Basic realm="hedwig"');
  return res.status(err.status).set('Cache-Control', 'no-store').json(err.toJSON());
}

const form = express.urlencoded({ extended: false, limit: '64kb' });

/** The public routes. Called from mountHedwig, before the API's 404 and error handlers. */
export function mountMcpPublic(app) {
  const r = Router();

  r.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(resourceMetadata(publicOrigin(req)));
  });
  r.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(authServerMetadata(publicOrigin(req)));
  });

  r.post('/mcp/oauth/register', async (req, res) => {
    if (!registerAllowed(req.ip)) return res.status(429).json({ error: 'too_many_requests', error_description: 'Too many registrations from this address; try again in an hour' });
    try {
      return res.status(201).set('Cache-Control', 'no-store').json(await registerClient(req.body));
    } catch (err) {
      return oauthFail(res, err);
    }
  });

  r.get('/mcp/oauth/authorize', async (req, res) => {
    const origin = publicOrigin(req);
    try {
      const { requestId } = await startAuthorization(req.query, { origin });
      return res.redirect(302, `${origin}/connect?request=${requestId}`);
    } catch (err) {
      if (err instanceof OAuthError && err.redirect) return res.redirect(302, err.redirect);
      if (err instanceof OAuthError) return res.status(400).type('html').send(errorPage(err.description || err.error));
      throw err;
    }
  });

  r.post('/mcp/oauth/token', form, async (req, res) => {
    const body = req.body || {};
    const origin = publicOrigin(req);
    try {
      const creds = clientCredentials(req);
      let tokens;
      if (body.grant_type === 'authorization_code') tokens = await exchangeCode(body, creds, { origin });
      else if (body.grant_type === 'refresh_token') tokens = await refreshTokens(body, creds);
      else throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
      return res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(tokens);
    } catch (err) {
      return oauthFail(res, err);
    }
  });

  r.post('/mcp/oauth/revoke', form, async (req, res) => {
    try {
      await revokeToken(req.body || {}, clientCredentials(req));
      return res.status(200).set('Cache-Control', 'no-store').json({});
    } catch (err) {
      return oauthFail(res, err);
    }
  });

  r.all('/mcp', async (req, res) => {
    const origin = publicOrigin(req);
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const auth = bearer ? await verifyAccessToken(bearer[1], { origin }) : null;
    if (!auth) {
      // The 401 and its resource_metadata link are how a client discovers it must sign in (RFC 9728).
      const challenge = [`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`];
      if (bearer) challenge.push('error="invalid_token"', 'error_description="The access token is invalid, expired or revoked"');
      return res.status(401).set('WWW-Authenticate', challenge.join(', '))
        .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in to Hedwig to use this connector' } });
    }
    if (req.method !== 'POST') {
      // No server-initiated stream and no sessions to end: every answer comes back on its POST.
      return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: RPC.INVALID_REQUEST, message: 'Use POST' } });
    }
    const version = req.get('mcp-protocol-version');
    if (version && !PROTOCOL_VERSIONS.includes(version)) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: RPC.INVALID_REQUEST, message: `Unsupported MCP-Protocol-Version ${version}; supported: ${PROTOCOL_VERSIONS.join(', ')}` } });
    }
    const body = req.body;
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (!body || typeof body !== 'object' || !messages.length) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE, message: 'Expected a JSON-RPC message' } });
    }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const ctx = { auth, origin, appVersion, signal: controller.signal };
    const responses = [];
    for (const m of messages.slice(0, 50)) {
      const out = await handleMessage(m, ctx);
      if (out) responses.push(out);
    }
    if (!responses.length) return res.status(202).end();
    return res.set('Cache-Control', 'no-store').json(batch ? responses : responses[0]);
  });

  app.use(r);
}

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req, req.session.userId, publicOrigin(req)));
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[hedwig] ${req.method} ${req.originalUrl} failed:`, err);
      res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
    }
  };
}

/** Signed-in routes under /api/hedwig: the /connect page and Settings → Connectors. */
export function mountMcpRoutes(r) {
  r.get('/mcp/requests/:id', handle((req) => describeRequest(req.params.id)));
  r.post('/mcp/requests/:id/approve', handle((req, userId, origin) => approveRequest(userId, req.params.id, { write: req.body?.write !== false }, { origin })));
  r.post('/mcp/requests/:id/deny', handle((req, _userId, origin) => denyRequest(req.params.id, { origin })));
  r.get('/mcp/connections', handle(async (req, userId, origin) => {
    const [connections, activity] = await Promise.all([listGrants(userId), recentActivity(userId)]);
    return { endpoint: resourceUrl(origin), connections, activity };
  }));
  r.delete('/mcp/connections/:id', handle((req, userId) => revokeGrant(userId, req.params.id)));
}
