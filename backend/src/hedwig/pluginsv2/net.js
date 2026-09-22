// net.fetch for plugins: only to hosts the manifest lists in `net` AND the user granted as
// `net:<host>` (or `net:$settings.<key>`, which means "the host of that per-user setting"). Every
// request goes through upstream's SSRF-safe fetch (private/reserved addresses refused unless the
// admin allows them, HTTPS required for public hosts). Redirects are not followed: a redirect to
// another host would otherwise leave the allowlist, so the plugin sees the 3xx and decides.
import { safeFetch } from '../../services/safeFetch.js';
import { getConfig } from '../config.js';
import { PermissionError, PluginInputError } from './errors.js';
import { settingRef } from './manifest.js';

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_HEADERS = new Set(['host', 'cookie', 'proxy-authorization', 'connection', 'transfer-encoding']);

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Which permission covers `host` for this plugin and user, or null.
 * @param {object} manifest
 * @param {string} host
 * @param {object} settings the user's settings for this plugin
 */
export function netPermissionFor(manifest, host, settings) {
  for (const entry of manifest.net || []) {
    const ref = settingRef(entry);
    if (ref) {
      const configured = settings?.[ref];
      const h = configured ? (hostOf(configured) || String(configured).toLowerCase()) : null;
      if (h && h === host) return `net:${entry}`;
    } else if (entry === host) {
      return `net:${entry}`;
    }
  }
  return null;
}

/** Perform the request once the facade has resolved and checked the permission. */
export async function pluginFetch(pluginId, url, init = {}) {
  let u;
  try { u = new URL(url); } catch { throw new PluginInputError('net.fetch needs an absolute URL'); }
  if (u.username || u.password) throw new PluginInputError('credentials in the URL are not allowed; send an Authorization header');
  const method = String(init.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new PluginInputError(`method ${method} is not allowed`);
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) {
    const key = String(k).toLowerCase();
    if (FORBIDDEN_HEADERS.has(key) || /[\r\n\0]/.test(String(v))) continue;
    headers[key] = String(v);
  }
  headers['user-agent'] = `Hedwig-Plugin/${pluginId}`;
  let body = init.body;
  if (body !== undefined && body !== null) {
    if (typeof body === 'object' && !(body instanceof URLSearchParams)) {
      body = JSON.stringify(body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    } else body = String(body);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new PluginInputError('request body too large');
  } else body = undefined;

  const cfg = await getConfig();
  const allowPrivate = cfg['plugins.netAllowPrivate'] === true;
  const timeoutMs = Math.max(1000, Math.min(60_000, Number(init.timeoutMs) || 15_000));
  const res = await safeFetch(u.toString(), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }, { allowPrivate });

  const reader = res.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw new PluginInputError(`response larger than ${MAX_RESPONSE_BYTES} bytes`); }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  const outHeaders = {};
  res.headers.forEach((v, k) => { if (k !== 'set-cookie') outHeaders[k] = v; });
  return Object.freeze({
    ok: res.ok,
    status: res.status,
    headers: Object.freeze(outHeaders),
    text: async () => text,
    json: async () => JSON.parse(text),
  });
}

export function assertNetHost(plugin, url, settings) {
  const host = hostOf(url);
  if (!host) throw new PluginInputError('net.fetch needs an absolute URL');
  const perm = netPermissionFor(plugin.manifest, host, settings);
  if (!perm) throw new PermissionError(plugin.id, `net:${host}`, 'is not declared in the manifest net list');
  return perm;
}
