// The router a plugin gets from hedwig.router(). Deliberately not an Express router: a plugin never
// holds Express's req/res, because those reach the session (a plugin could rewrite
// req.session.userId), the socket and every other request. Handlers receive a frozen plain
// request and a small response builder; the runtime writes the real response. Content types are
// limited to data (no HTML, no SVG, no script) and every response carries nosniff and a
// default-src 'none' CSP, so a plugin route can never serve active content on the app's origin.
import { PermissionError, PluginInputError } from './errors.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const ALLOWED_TYPES = [
  /^application\/json\b/, /^text\/plain\b/, /^text\/csv\b/, /^application\/octet-stream\b/,
  /^image\/(png|jpeg|gif|webp)\b/, /^application\/pdf\b/,
];
const ALLOWED_HEADERS = new Set(['content-disposition', 'cache-control', 'etag', 'last-modified']);
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function compile(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 200) throw new PluginInputError(`route path must start with "/" (got ${JSON.stringify(path)})`);
  const keys = [];
  const re = path.replace(/\/+$/, '').split('/').map((seg) => {
    if (seg.startsWith(':')) {
      const k = seg.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new PluginInputError(`bad route parameter "${seg}"`);
      keys.push(k);
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp(`^${re || ''}/?$`), keys };
}

export function createPluginRouter() {
  const routes = [];
  const api = {};
  for (const m of METHODS) {
    api[m] = (path, handler) => {
      if (typeof handler !== 'function') throw new PluginInputError(`${m.toUpperCase()} ${path} needs a handler`);
      routes.push({ method: m.toUpperCase(), ...compile(path), handler });
      return api;
    };
  }
  Object.defineProperty(api, '__hedwigRoutes', { value: routes, enumerable: false });
  return Object.freeze(api);
}

export function isPluginRouter(v) {
  return Boolean(v && Array.isArray(v.__hedwigRoutes));
}

function makeResponse() {
  const state = { status: 200, type: null, headers: {}, body: undefined, sent: false };
  const res = {
    status(code) {
      if (!Number.isInteger(code) || code < 200 || code > 599) throw new PluginInputError('status must be 200-599');
      state.status = code; return res;
    },
    type(ct) { state.type = String(ct); return res; },
    header(name, value) {
      const k = String(name).toLowerCase();
      if (!ALLOWED_HEADERS.has(k) || /[\r\n\0]/.test(String(value))) throw new PluginInputError(`header ${name} is not allowed`);
      state.headers[k] = String(value).slice(0, 500);
      return res;
    },
    json(obj) { state.type = state.type || 'application/json; charset=utf-8'; state.body = JSON.stringify(obj ?? null); state.sent = true; return res; },
    send(body) {
      if (typeof body === 'string') state.type = state.type || 'text/plain; charset=utf-8';
      else if (Buffer.isBuffer(body) || body instanceof Uint8Array) state.type = state.type || 'application/octet-stream';
      else return res.json(body);
      state.body = body; state.sent = true; return res;
    },
    /** Send a file download: res.attachment('receipts.csv', csvText, 'text/csv'). */
    attachment(filename, body, type = 'application/octet-stream') {
      const safe = String(filename || 'download').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
      state.headers['content-disposition'] = `attachment; filename="${safe}"`;
      state.type = type;
      state.body = body; state.sent = true; return res;
    },
  };
  return { res: Object.freeze(res), state };
}

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freezeDeep(v); }
  return o;
}

/**
 * Dispatch an Express request to a plugin router and write the response.
 * @returns {Promise<boolean>} false when no route matched
 */
export async function dispatch(router, expressReq, expressRes, { userId, pluginId, logger }) {
  const path = (expressReq.path || '/').replace(/\/+/g, '/');
  const method = expressReq.method === 'HEAD' ? 'GET' : expressReq.method;
  let match = null;
  for (const r of router.__hedwigRoutes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) { match = { r, m }; break; }
  }
  if (!match) return false;
  const params = {};
  match.r.keys.forEach((k, i) => {
    try { params[k] = decodeURIComponent(match.m[i + 1]); } catch { params[k] = match.m[i + 1]; }
  });
  let body = expressReq.body;
  try { body = body === undefined ? undefined : JSON.parse(JSON.stringify(body)); } catch { body = undefined; }
  const headers = {};
  for (const h of ['accept', 'content-type', 'if-none-match', 'accept-language']) if (expressReq.headers[h]) headers[h] = String(expressReq.headers[h]);
  const req = freezeDeep({ userId, pluginId, method, path, params, query: JSON.parse(JSON.stringify(expressReq.query || {})), body, headers });
  const { res, state } = makeResponse();

  expressRes.set('X-Content-Type-Options', 'nosniff');
  expressRes.set('Content-Security-Policy', "default-src 'none'; sandbox");
  expressRes.set('Cache-Control', 'private, no-store');
  try {
    const out = await match.r.handler(req, res);
    if (!state.sent && out !== undefined) res.json(out);
  } catch (err) {
    if (err instanceof PermissionError) { expressRes.status(403).json({ error: err.message }); return true; }
    if (err instanceof PluginInputError || err?.status === 400) { expressRes.status(400).json({ error: err.message }); return true; }
    if (err?.code === 'budget_exceeded' || err?.code === 'llm_disabled') { expressRes.status(err.status || 503).json({ error: err.message }); return true; }
    logger?.warn(`route ${method} ${path} failed:`, err?.message || err);
    expressRes.status(500).json({ error: `Plugin ${pluginId} failed` });
    return true;
  }
  if (!state.sent) { expressRes.status(204).end(); return true; }
  const type = state.type || 'application/octet-stream';
  if (!ALLOWED_TYPES.some((re) => re.test(type))) {
    logger?.warn(`route ${method} ${path} tried to send ${type}`);
    expressRes.status(500).json({ error: `Plugin ${pluginId} sent a disallowed content type` });
    return true;
  }
  const payload = typeof state.body === 'string' ? state.body : Buffer.from(state.body ?? '');
  if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) { expressRes.status(500).json({ error: `Plugin ${pluginId} response too large` }); return true; }
  for (const [k, v] of Object.entries(state.headers)) expressRes.set(k, v);
  expressRes.status(state.status).type(type).send(payload);
  return true;
}
