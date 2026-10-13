// Connectors end to end over HTTP: discovery, client registration, the authorization request and
// the /connect approval, PKCE and the token endpoint, the MCP endpoint (initialize, tools/list per
// scope, tools/call), refresh, and disconnecting. The database is an in-memory stand-in that
// answers the statements in oauth.js; the mail services behind the tools are mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { createHash, randomBytes } from 'crypto';

const db = vi.hoisted(() => ({ clients: new Map(), requests: new Map(), grants: new Map(), tokens: new Map(), activity: [], offsetMs: 0, seq: 0 }));

vi.mock('../../services/db.js', () => {
  const now = () => Date.now() + db.offsetMs;
  const uuid = () => `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
  const live = (r) => r.expires_at > now();
  const sql = (s) => s.replace(/\s+/g, ' ').trim();
  async function query(text, p = []) {
    const s = sql(text);
    if (s.startsWith('DELETE FROM hedwig_mcp_clients c')) return { rows: [], rowCount: 0 };
    if (s.startsWith('INSERT INTO hedwig_mcp_clients')) {
      db.clients.set(p[0], { client_id: p[0], client_secret_hash: p[1], client_name: p[2], client_uri: p[3], redirect_uris: p[4], token_endpoint_auth_method: p[5], created_at: new Date(now()) });
      return { rows: [{ created_at: new Date(now()) }], rowCount: 1 };
    }
    if (s === 'SELECT * FROM hedwig_mcp_clients WHERE client_id = $1') return { rows: db.clients.has(p[0]) ? [db.clients.get(p[0])] : [] };
    if (s === 'DELETE FROM hedwig_mcp_requests WHERE expires_at < NOW()') {
      for (const [k, r] of db.requests) if (!live(r)) db.requests.delete(k);
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('INSERT INTO hedwig_mcp_requests')) {
      const id = uuid();
      db.requests.set(id, { id, client_id: p[0], redirect_uri: p[1], state: p[2], code_challenge: p[3], scopes: p[4], resource: p[5], expires_at: now() + p[6] * 60_000, user_id: null, code_hash: null, code_expires_at: null });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (s.startsWith('SELECT r.*, c.client_name')) {
      const r = db.requests.get(p[0]);
      if (!r || !live(r) || r.code_hash) return { rows: [] };
      const c = db.clients.get(r.client_id);
      return { rows: [{ ...r, expires_at: new Date(r.expires_at), client_name: c.client_name, client_uri: c.client_uri }] };
    }
    if (s.startsWith('UPDATE hedwig_mcp_requests SET user_id')) {
      const r = db.requests.get(p[0]);
      if (!r || r.code_hash || !live(r)) return { rows: [], rowCount: 0 };
      Object.assign(r, { user_id: p[1], scopes: p[2], code_hash: p[3], code_expires_at: now() + p[4] * 1000 });
      return { rows: [], rowCount: 1 };
    }
    if (s === 'DELETE FROM hedwig_mcp_requests WHERE id = $1') return { rows: [], rowCount: db.requests.delete(p[0]) ? 1 : 0 };
    if (s === 'DELETE FROM hedwig_mcp_requests WHERE code_hash = $1 RETURNING *') {
      const r = [...db.requests.values()].find((x) => x.code_hash === p[0]);
      if (!r) return { rows: [], rowCount: 0 };
      db.requests.delete(r.id);
      return { rows: [{ ...r, code_expires_at: new Date(r.code_expires_at) }], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO hedwig_mcp_tokens')) {
      db.tokens.set(p[0], { token_hash: p[0], grant_id: p[2], kind: 'access', expires_at: now() + p[3] * 1000 });
      db.tokens.set(p[1], { token_hash: p[1], grant_id: p[2], kind: 'refresh', expires_at: now() + p[4] * 86400_000 });
      return { rows: [], rowCount: 2 };
    }
    if (s.startsWith("DELETE FROM hedwig_mcp_tokens WHERE expires_at")) return { rows: [], rowCount: 0 };
    if (s.startsWith('INSERT INTO hedwig_mcp_grants')) {
      const id = uuid();
      db.grants.set(id, { id, user_id: p[0], client_id: p[1], scopes: p[2], resource: p[3], calls: 0, created_at: new Date(now()), last_used_at: null, revoked_at: null });
      return { rows: [{ id }], rowCount: 1 };
    }
    const tokenJoin = (kind) => {
      const t = db.tokens.get(p[0]);
      const g = t && db.grants.get(t.grant_id);
      if (!t || !g || (kind && (t.kind !== kind || !live(t) || g.revoked_at))) return null;
      return { t, g, c: db.clients.get(g.client_id) };
    };
    if (s.startsWith('SELECT t.token_hash, g.id AS grant_id')) {
      const j = tokenJoin('refresh');
      return { rows: j ? [{ token_hash: j.t.token_hash, grant_id: j.g.id, client_id: j.g.client_id, scopes: j.g.scopes }] : [] };
    }
    if (s.startsWith('UPDATE hedwig_mcp_tokens SET expires_at')) {
      const t = db.tokens.get(p[0]);
      if (t) t.expires_at = Math.min(t.expires_at, now() + p[1] * 1000);
      return { rows: [], rowCount: t ? 1 : 0 };
    }
    if (s.startsWith('SELECT t.token_hash, t.kind')) {
      const j = tokenJoin(null);
      return { rows: j ? [{ token_hash: j.t.token_hash, kind: j.t.kind, grant_id: j.g.id, client_id: j.g.client_id }] : [] };
    }
    if (s === 'DELETE FROM hedwig_mcp_tokens WHERE token_hash = $1') return { rows: [], rowCount: db.tokens.delete(p[0]) ? 1 : 0 };
    if (s.startsWith('SELECT g.id AS grant_id, g.user_id')) {
      const j = tokenJoin('access');
      return { rows: j ? [{ grant_id: j.g.id, user_id: j.g.user_id, scopes: j.g.scopes, resource: j.g.resource, client_id: j.c.client_id, client_name: j.c.client_name }] : [] };
    }
    if (s.startsWith('UPDATE hedwig_mcp_grants SET revoked_at = NOW() WHERE id = $1 AND user_id = $2')) {
      const g = db.grants.get(p[0]);
      if (!g || g.user_id !== p[1] || g.revoked_at) return { rows: [], rowCount: 0 };
      g.revoked_at = new Date(now());
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE hedwig_mcp_grants SET revoked_at')) {
      const g = db.grants.get(p[0]);
      if (g && !g.revoked_at) g.revoked_at = new Date(now());
      return { rows: [], rowCount: g ? 1 : 0 };
    }
    if (s === 'DELETE FROM hedwig_mcp_tokens WHERE grant_id = $1') {
      for (const [k, t] of db.tokens) if (t.grant_id === p[0]) db.tokens.delete(k);
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE hedwig_mcp_grants SET calls')) {
      const g = db.grants.get(p[0]);
      if (g) { g.calls += 1; g.last_used_at = new Date(now()); }
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('INSERT INTO hedwig_mcp_activity')) {
      db.activity.push({ id: db.activity.length + 1, grant_id: p[0], user_id: p[1], tool: p[2], summary: p[3], ok: p[4], created_at: new Date(now()) });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT g.id, g.scopes, g.calls')) {
      const rows = [...db.grants.values()].filter((g) => g.user_id === p[0] && !g.revoked_at)
        .map((g) => ({ ...g, ...db.clients.get(g.client_id) }));
      return { rows };
    }
    if (s.startsWith('SELECT a.id, a.tool')) {
      const rows = db.activity.filter((a) => a.user_id === p[0]).reverse()
        .map((a) => ({ ...a, client_name: db.clients.get(db.grants.get(a.grant_id).client_id).client_name }));
      return { rows };
    }
    throw new Error(`fake db: unexpected SQL: ${s.slice(0, 120)}`);
  }
  return { query: vi.fn(query), pool: {} };
});

const svc = vi.hoisted(() => ({
  registry: [],
  correct: null, streamList: null, searchIndexed: null, answerQuestion: null,
}));
vi.mock('../agent/access.js', () => ({ userTools: vi.fn(async () => svc.registry) }));
vi.mock('../agent/mailOps.js', () => {
  class ToolError extends Error { constructor(m) { super(m); this.name = 'ToolError'; this.status = 400; } }
  return { ToolError, loadOwnedMessage: vi.fn(async () => { throw new ToolError('message not found'); }) };
});
vi.mock('../sort/service.js', () => ({
  correct: vi.fn((...a) => svc.correct(...a)),
  streamList: vi.fn((...a) => svc.streamList(...a)),
}));
vi.mock('../work/summaries.js', () => ({ tldrFor: vi.fn(async (_u, ids) => new Map(ids.map((id) => [id, { text: `TL;DR of ${id}` }]))) }));
vi.mock('../context/search.js', () => ({ searchIndexed: vi.fn((...a) => svc.searchIndexed(...a)) }));
vi.mock('../context/service.js', () => ({ answerQuestion: vi.fn((...a) => svc.answerQuestion(...a)) }));

process.env.APP_URL = 'https://hedwig.test';
const { mountMcpPublic, mountMcpRoutes, _resetRegistrations } = await import('./routes.js');
const sortService = await import('../sort/service.js');

const USER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://hedwig.test';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const MSG = '33333333-3333-4333-8333-333333333333';
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => { req.session = { userId: USER }; next(); });
  const router = express.Router();
  mountMcpRoutes(router);
  app.use('/api/hedwig', router);
  mountMcpPublic(app);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

beforeEach(() => {
  for (const k of ['clients', 'requests', 'grants', 'tokens']) db[k].clear();
  db.activity.length = 0;
  db.offsetMs = 0;
  _resetRegistrations();
  svc.registry = [
    { name: 'list_accounts', description: 'List accounts', parameters: { type: 'object', properties: {} }, handler: vi.fn(async () => [{ id: 'a1', name: 'Work' }]) },
    { name: 'read_message', description: 'old reader', parameters: { type: 'object', properties: {} }, handler: vi.fn() },
    { name: 'set_triage', description: 'old triage', parameters: { type: 'object', properties: {} }, handler: vi.fn() },
    {
      name: 'archive_message', description: 'Archive a message', mutates: true,
      parameters: { type: 'object', properties: { messageId: { type: 'string', format: 'uuid' } }, required: ['messageId'] },
      prepare: vi.fn(async () => ({ summary: 'Archive “Invoice” from Ana' })),
      handler: vi.fn(async () => ({ ok: true, folder: 'Archive' })),
    },
    { name: 'aer_receipts__totals', pluginId: 'aer.receipts', description: 'Receipt totals', parameters: { type: 'object', properties: {} }, handler: vi.fn(async () => ({ total: 3 })) },
  ];
  svc.correct = vi.fn(async (_u, body) => ({ sort: { stream: body.stream, bundle: null, needsYou: false, spam: 'clean', reason: 'You moved it', subject: 'Invoice' }, logId: 41, ruleId: null }));
  svc.streamList = vi.fn(async () => ({ items: [{ threadId: 't1', messageId: MSG, from: { name: 'Ana', email: 'ana@example.com' }, subject: 'Lunch?', date: '2026-10-12T10:00:00Z', needsYou: true, reason: 'Asked you a question', unread: true }], next: null }));
  svc.searchIndexed = vi.fn(async () => ({ results: [{ id: MSG, subject: 'Lunch?', from_name: 'Ana', from_email: 'ana@example.com', snippet: 'Are you free' }] }));
  svc.answerQuestion = vi.fn(async () => ({ answer: 'Ana asked about lunch [1].', askLogId: '44444444-4444-4444-8444-444444444444', notFound: false, sources: [{ n: 1, message: { id: MSG, subject: 'Lunch?', from_name: 'Ana', from_email: 'ana@example.com', date: '2026-10-12' } }] }));
});

const json = (method, path, body, headers = {}) => fetch(base + path, {
  method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const formPost = (path, fields, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString(),
});
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(extra = {}) {
  const res = await json('POST', '/mcp/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none', ...extra });
  expect(res.status).toBe(201);
  return res.json();
}

/** Register, authorize, approve on /connect, exchange the code: a connection with these scopes. */
async function connect({ write = true, scope, client } = {}) {
  const c = client || await register();
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: 'code', client_id: c.client_id, redirect_uri: c.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256',
    state: 'xyz', resource: `${ORIGIN}/mcp`, ...(scope ? { scope } : {}),
  });
  const auth = await fetch(`${base}/mcp/oauth/authorize?${q}`, { redirect: 'manual' });
  expect(auth.status).toBe(302);
  const requestId = new URL(auth.headers.get('location')).searchParams.get('request');
  const approved = await (await json('POST', `/api/hedwig/mcp/requests/${requestId}/approve`, { write })).json();
  const back = new URL(approved.redirect);
  const tokenRes = await formPost('/mcp/oauth/token', {
    grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: c.redirect_uris[0], code_verifier: verifier, client_id: c.client_id,
    resource: `${ORIGIN}/mcp`, ...(c.client_secret ? { client_secret: c.client_secret } : {}),
  });
  expect(tokenRes.status).toBe(200);
  return { client: c, tokens: await tokenRes.json(), back };
}

let rpcId = 0;
const rpc = (token, method, params, headers = {}) => json('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }, { Authorization: `Bearer ${token}`, ...headers });
const call = async (token, name, args) => (await (await rpc(token, 'tools/call', { name, arguments: args })).json()).result;

describe('discovery', () => {
  it('answers an unauthenticated MCP request with 401 and the resource metadata link', async () => {
    const res = await json('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await json('POST', '/mcp', {}, { Authorization: 'Bearer hw_at_nope' });
    expect(bad.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
  });

  it('publishes protected-resource and authorization-server metadata', async () => {
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(pr).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], scopes_supported: ['mail.read', 'mail.write'] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/mcp/oauth/authorize`, token_endpoint: `${ORIGIN}/mcp/oauth/token`,
      registration_endpoint: `${ORIGIN}/mcp/oauth/register`, code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('registration', () => {
  it('registers a public client without a secret and a confidential one with', async () => {
    const pub = await register();
    expect(pub).toMatchObject({ client_name: 'Claude', token_endpoint_auth_method: 'none', redirect_uris: [CLAUDE] });
    expect(pub.client_secret).toBeUndefined();
    const conf = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'client_secret_post' });
    expect(conf.client_secret).toMatch(/^hws_/);
  });

  it('refuses redirect URIs that could leak a code', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://claude.ai/cb#frag', 'not a url']) {
      const res = await json('POST', '/mcp/oauth/register', { redirect_uris: [uri] });
      expect(res.status, uri).toBe(400);
      expect((await res.json()).error).toBe('invalid_redirect_uri');
    }
    expect((await json('POST', '/mcp/oauth/register', { redirect_uris: ['http://127.0.0.1:33418/callback'], token_endpoint_auth_method: 'none' })).status).toBe(201);
  });

  it('rate limits registration per address', async () => {
    for (let i = 0; i < 20; i++) await register();
    expect((await json('POST', '/mcp/oauth/register', { redirect_uris: [CLAUDE] })).status).toBe(429);
  });
});

describe('authorization', () => {
  it('shows a page, never redirects, for an unknown client or an unregistered redirect URI', async () => {
    const unknown = await fetch(`${base}/mcp/oauth/authorize?client_id=hwc_nope&response_type=code`, { redirect: 'manual' });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toMatch(/not registered with Hedwig/);
    const c = await register();
    const evil = await fetch(`${base}/mcp/oauth/authorize?client_id=${c.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`, { redirect: 'manual' });
    expect(evil.status).toBe(400);
  });

  it('redirects protocol errors back to the client with the state', async () => {
    const c = await register();
    const res = await fetch(`${base}/mcp/oauth/authorize?client_id=${c.client_id}&redirect_uri=${encodeURIComponent(CLAUDE)}&response_type=code&state=s1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location'));
    expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ error: 'invalid_request', state: 's1', iss: ORIGIN });
    const { challenge } = pkce();
    const wrongResource = await fetch(`${base}/mcp/oauth/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CLAUDE, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' })}`, { redirect: 'manual' });
    expect(new URL(wrongResource.headers.get('location')).searchParams.get('error')).toBe('invalid_target');
  });

  it('accepts a loopback redirect on another port (RFC 8252)', async () => {
    const c = await register({ redirect_uris: ['http://localhost:33418/callback'] });
    const { challenge } = pkce();
    const res = await fetch(`${base}/mcp/oauth/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: 'http://localhost:51234/callback', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    expect(res.headers.get('location')).toMatch(/\/connect\?request=/);
  });

  it('describes the request for the /connect page and lets the person decline', async () => {
    const c = await register();
    const { challenge } = pkce();
    const auth = await fetch(`${base}/mcp/oauth/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CLAUDE, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'abc', scope: 'mail.read' })}`, { redirect: 'manual' });
    const id = new URL(auth.headers.get('location')).searchParams.get('request');
    const desc = await (await json('GET', `/api/hedwig/mcp/requests/${id}`)).json();
    expect(desc).toMatchObject({ client: { name: 'Claude' }, redirectHost: 'claude.ai', scopes: ['mail.read'] });
    const denied = await (await json('POST', `/api/hedwig/mcp/requests/${id}/deny`)).json();
    expect(Object.fromEntries(new URL(denied.redirect).searchParams)).toMatchObject({ error: 'access_denied', state: 'abc' });
    expect((await json('GET', `/api/hedwig/mcp/requests/${id}`)).status).toBe(404);
  });

  it('expires an unanswered request', async () => {
    const c = await register();
    const { challenge } = pkce();
    const auth = await fetch(`${base}/mcp/oauth/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CLAUDE, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' })}`, { redirect: 'manual' });
    const id = new URL(auth.headers.get('location')).searchParams.get('request');
    db.offsetMs = 16 * 60_000;
    expect((await json('POST', `/api/hedwig/mcp/requests/${id}/approve`, {})).status).toBe(404);
  });
});

describe('tokens', () => {
  it('exchanges a code once, with the right PKCE verifier only', async () => {
    const c = await register();
    const { verifier, challenge } = pkce();
    const start = async () => {
      const auth = await fetch(`${base}/mcp/oauth/authorize?${new URLSearchParams({ client_id: c.client_id, redirect_uri: CLAUDE, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st' })}`, { redirect: 'manual' });
      const id = new URL(auth.headers.get('location')).searchParams.get('request');
      const { redirect } = await (await json('POST', `/api/hedwig/mcp/requests/${id}/approve`, {})).json();
      return new URL(redirect).searchParams;
    };
    const first = await start();
    expect(first.get('state')).toBe('st');
    expect(first.get('iss')).toBe(ORIGIN);
    const wrong = await formPost('/mcp/oauth/token', { grant_type: 'authorization_code', code: first.get('code'), code_verifier: pkce().verifier, client_id: c.client_id, redirect_uri: CLAUDE });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('invalid_grant');

    const second = await start();
    const good = await formPost('/mcp/oauth/token', { grant_type: 'authorization_code', code: second.get('code'), code_verifier: verifier, client_id: c.client_id, redirect_uri: CLAUDE });
    expect(good.status).toBe(200);
    expect(good.headers.get('cache-control')).toBe('no-store');
    const tokens = await good.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mail.read mail.write' });
    expect(tokens.access_token).toMatch(/^hw_at_/);
    expect([...db.tokens.keys()]).not.toContain(tokens.access_token); // stored hashed
    const replay = await formPost('/mcp/oauth/token', { grant_type: 'authorization_code', code: second.get('code'), code_verifier: verifier, client_id: c.client_id });
    expect((await replay.json()).error).toBe('invalid_grant');
  });

  it('requires a confidential client to authenticate, by form or HTTP Basic', async () => {
    const client = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'client_secret_basic' });
    const { tokens } = await connect({ client });
    const noSecret = await formPost('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(noSecret.status).toBe(401);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const ok = await formPost('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, { Authorization: `Basic ${basic}` });
    expect(ok.status).toBe(200);
  });

  it('rotates refresh tokens and keeps the old one only briefly', async () => {
    const { client, tokens } = await connect();
    const r1 = await (await formPost('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).json();
    expect(r1.access_token).toMatch(/^hw_at_/);
    expect(r1.refresh_token).not.toBe(tokens.refresh_token);
    expect((await rpc(r1.access_token, 'ping')).status).toBe(200);
    db.offsetMs = 61_000;
    const stale = await formPost('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect((await stale.json()).error).toBe('invalid_grant');
    const fresh = await formPost('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: client.client_id });
    expect(fresh.status).toBe(200);
  });

  it('ends the connection when the refresh token is revoked', async () => {
    const { client, tokens } = await connect();
    expect((await formPost('/mcp/oauth/revoke', { token: tokens.refresh_token, client_id: client.client_id })).status).toBe(200);
    expect((await rpc(tokens.access_token, 'ping')).status).toBe(401);
  });
});

describe('the MCP endpoint', () => {
  it('negotiates the protocol version and says what the server is', async () => {
    const { tokens } = await connect();
    const init = await (await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } })).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hedwig', title: 'Hedwig' } });
    expect(init.result.instructions).toMatch(/draft_reply saves a draft/);
    const future = await (await rpc(tokens.access_token, 'initialize', { protocolVersion: '2099-01-01' })).json();
    expect(future.result.protocolVersion).toBe('2025-11-25');
    expect((await rpc(tokens.access_token, 'ping', undefined, { 'MCP-Protocol-Version': '1999-01-01' })).status).toBe(400);
  });

  it('accepts notifications with 202 and refuses GET', async () => {
    const { tokens } = await connect();
    const note = await json('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: `Bearer ${tokens.access_token}` });
    expect(note.status).toBe(202);
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(get.status).toBe(405);
    expect((await (await rpc(tokens.access_token, 'sampling/whatever')).json()).error.code).toBe(-32601);
  });

  it('lists read tools only on a read-only connection', async () => {
    const { tokens } = await connect({ write: false });
    expect(tokens.scope).toBe('mail.read');
    const { result } = await (await rpc(tokens.access_token, 'tools/list')).json();
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search', 'fetch', 'ask', 'list_mail', 'summarize_thread', 'list_accounts', 'aer_receipts__totals']));
    for (const hidden of ['categorize', 'archive_message', 'snooze', 'read_message', 'set_triage']) expect(names).not.toContain(hidden);
    expect(result.tools.find((t) => t.name === 'search').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const refused = await (await rpc(tokens.access_token, 'tools/call', { name: 'categorize', arguments: { id: MSG, category: 'reading' } })).json();
    expect(refused.error.code).toBe(-32602);
    expect(svc.correct).not.toHaveBeenCalled();
  });

  it('answers search and fetch in the shapes ChatGPT expects', async () => {
    const { tokens } = await connect({ write: false });
    const found = await call(tokens.access_token, 'search', { query: 'lunch' });
    expect(JSON.parse(found.content[0].text)).toEqual({ results: [{ id: MSG, title: 'Lunch? — Ana', url: `${ORIGIN}/?m=${MSG}`, snippet: 'Are you free' }] });
    const missing = await call(tokens.access_token, 'fetch', { id: MSG });
    expect(missing).toMatchObject({ isError: true, content: [{ text: 'message not found' }] });
  });

  it('lists sorted mail with summaries and asks Hedwig', async () => {
    const { tokens } = await connect({ write: false });
    const list = JSON.parse((await call(tokens.access_token, 'list_mail', {})).content[0].text);
    expect(sortService.streamList).toHaveBeenCalledWith(USER, 'people', expect.objectContaining({ needsYou: true, limit: 20 }));
    expect(list.items[0]).toMatchObject({ id: MSG, from: 'Ana <ana@example.com>', needs_you: true, why: 'Asked you a question', summary: `TL;DR of ${MSG}` });
    const answer = JSON.parse((await call(tokens.access_token, 'ask', { question: 'what did Ana want?' })).content[0].text);
    expect(answer).toMatchObject({ answer: 'Ana asked about lunch [1].', answer_id: '44444444-4444-4444-8444-444444444444', sources: [{ n: 1, id: MSG, url: `${ORIGIN}/?m=${MSG}` }] });
  });

  it('runs write tools on a read-write connection and records what they did', async () => {
    const { tokens } = await connect();
    const sorted = await call(tokens.access_token, 'categorize', { id: MSG, category: 'reading', apply_to: 'sender' });
    expect(svc.correct).toHaveBeenCalledWith(USER, expect.objectContaining({ messageId: MSG, stream: 'reading', always: 'sender' }));
    expect(JSON.parse(sorted.content[0].text)).toMatchObject({ category: 'reading', log_id: 41 });
    expect(JSON.parse(sorted.content[0].text)._summary).toBeUndefined();
    const archived = await call(tokens.access_token, 'archive_message', { messageId: MSG });
    expect(JSON.parse(archived.content[0].text)).toEqual({ ok: true, folder: 'Archive' });
    expect(db.activity.map((a) => [a.tool, a.summary, a.ok])).toEqual([
      ['categorize', 'Sorted “Invoice” into Reading, with everything like it (sender)', true],
      ['archive_message', 'Archive “Invoice” from Ana', true],
    ]);
    const settings = await (await json('GET', '/api/hedwig/mcp/connections')).json();
    expect(settings.endpoint).toBe(`${ORIGIN}/mcp`);
    expect(settings.connections).toEqual([expect.objectContaining({ name: 'Claude', host: 'claude.ai', scopes: ['mail.read', 'mail.write'], calls: 2 })]);
    expect(settings.activity[0]).toMatchObject({ app: 'Claude', tool: 'archive_message', ok: true });
  });

  it('turns bad arguments and failures into tool errors the model can read', async () => {
    const { tokens } = await connect();
    const bad = await call(tokens.access_token, 'categorize', { id: 'not-a-uuid' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^Invalid arguments/);
    svc.correct = vi.fn(async () => { throw Object.assign(new Error('Message not found'), { status: 404 }); });
    expect(await call(tokens.access_token, 'categorize', { id: MSG, category: 'people' })).toMatchObject({ isError: true, content: [{ text: 'Message not found' }] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.correct = vi.fn(async () => { throw new Error('connection reset'); });
    const crash = await call(tokens.access_token, 'categorize', { id: MSG, category: 'people' });
    expect(crash.isError).toBe(true);
    expect(crash.content[0].text).not.toMatch(/connection reset/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(db.activity.map((a) => a.ok)).toEqual([false, false]);
  });

  it('stops working the moment the person disconnects the app', async () => {
    const { tokens } = await connect();
    const [conn] = (await (await json('GET', '/api/hedwig/mcp/connections')).json()).connections;
    expect((await json('DELETE', `/api/hedwig/mcp/connections/${conn.id}`)).status).toBe(200);
    const res = await rpc(tokens.access_token, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/invalid_token/);
    expect((await json('GET', '/api/hedwig/mcp/connections')).ok).toBe(true);
    expect((await json('DELETE', `/api/hedwig/mcp/connections/${conn.id}`)).status).toBe(404);
  });
});
