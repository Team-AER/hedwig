import { hiddenElement } from '../../services/emailContent.js';
// Read one web page for Ask's research: fetch it through safeFetch (the URL comes from search results or
// from mail, so it is untrusted), keep only its main text, and report a short reason when that fails.
import { Parser } from 'htmlparser2';
import { safeFetch } from '../../services/safeFetch.js';

// Blocks end a line; paragraph-like ones also leave a blank line around them.
const BLOCK = new Set([
  'p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'section', 'article',
  'header', 'footer', 'ul', 'ol', 'figure', 'figcaption', 'pre', 'dd', 'dt',
]);
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'ul', 'ol', 'figure', 'pre']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);
const CHROME = new Set(['nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'iframe']);
const MAX_LINKS = 200;
const LINK_TEXT_CHARS = 200;
// An <article> or <main> shorter than this is a teaser card or an empty shell, not the page's content.
const MIN_REGION_CHARS = 200;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Hedwig/1.0)',
  Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
};
const BLOCKED_CODES = new Set(['ERR_BLOCKED_PRIVATE_IP', 'ERR_INSECURE_TRANSPORT', 'ERR_UNSUPPORTED_SCHEME', 'ERR_INVALID_URL']);

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function tidy(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveHttp(href, base) {
  try {
    const u = new URL(String(href).trim(), base || undefined);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Main text of an HTML page. Scripts, styles and page chrome (nav, header, footer, aside, forms) are
 * dropped; when the page has <article> elements the longest one is used, else the longest <main> /
 * [role=main], else the whole body.
 * @param {string} html
 * @param {string} [baseUrl]  resolves relative links
 * @returns {{ title: string, text: string, links: { url: string, text: string }[] }}
 */
export function extractMainText(html, baseUrl) {
  let out = '';
  let title = '';
  let inTitle = false;
  let titleDone = false;
  let base = baseUrl;
  let baseSeen = false;
  let hidden = 0;
  let svg = 0;
  let pre = 0;
  let articles = 0;
  const stack = [];
  const regions = [];
  const anchors = [];

  // Ensure the output ends with n line breaks (trailing spaces ignored), without stacking more.
  const lineBreak = (name) => {
    if (name === 'br') { out += '\n'; return; }
    const n = PARAGRAPH.has(name) ? 2 : 1;
    let have = 0;
    for (let i = out.length - 1; i >= 0 && have < n; i--) {
      if (out[i] === '\n') have++;
      else if (out[i] !== ' ') break;
    }
    if (out) out += '\n'.repeat(n - have);
  };

  const parser = new Parser({
    onopentag(name, attrs) {
      const entry = { name };
      stack.push(entry);
      if (name === 'svg') svg++;
      if (name === 'title' && !svg && !titleDone) { inTitle = true; entry.title = true; }
      if (name === 'base' && attrs.href && !baseSeen) { baseSeen = true; base = resolveHttp(attrs.href, base) || base; }
      // A <header> inside an <article> is that article's headline and byline, not the site banner.
      const chrome = CHROME.has(name) && !(name === 'header' && articles);
      if (!hidden && (SKIP.has(name) || chrome || hiddenElement(attrs))) { entry.hidden = true; hidden++; }
      if (hidden) return;
      if (BLOCK.has(name)) lineBreak(name);
      if (name === 'li') out += '- ';
      if (name === 'pre') { entry.pre = true; pre++; }
      const role = String(attrs.role || '').trim().toLowerCase();
      if (name === 'article') { entry.region = 'article'; articles++; }
      else if (name === 'main' || role === 'main') entry.region = 'main';
      if (entry.region) entry.start = out.length;
      if (name === 'a' && attrs.href) entry.anchor = { href: attrs.href, at: out.length };
    },
    ontext(text) {
      if (inTitle) { title += text; return; }
      if (hidden) return;
      out += pre ? text.replace(/\r\n?/g, '\n') : text.replace(/\s+/g, ' ');
    },
    onclosetag(name) {
      const entry = stack.pop();
      if (!entry) return;
      if (entry.name === 'svg') svg--;
      if (entry.title) { inTitle = false; titleDone = true; }
      if (entry.hidden) { hidden--; return; }
      if (hidden) return;
      if (entry.anchor) anchors.push({ ...entry.anchor, text: out.slice(entry.anchor.at) });
      if (entry.region) {
        regions.push({ kind: entry.region, start: entry.start, end: out.length });
        if (entry.region === 'article') articles--;
      }
      if (entry.pre) pre--;
      if (BLOCK.has(name) && name !== 'br') lineBreak(name);
      else if (name === 'td' || name === 'th') out += ' | ';
    },
  }, { decodeEntities: true });
  parser.write(String(html ?? ''));
  parser.end();

  let chosen = { start: 0, end: out.length };
  let text = tidy(out);
  for (const kind of ['article', 'main']) {
    let best = null;
    for (const r of regions) {
      if (r.kind !== kind) continue;
      const t = tidy(out.slice(r.start, r.end));
      if (!best || t.length > best.text.length) best = { ...r, text: t };
    }
    if (best && best.text.length >= MIN_REGION_CHARS) {
      chosen = best;
      text = best.text;
      break;
    }
  }

  const links = [];
  const byUrl = new Map();
  for (const a of anchors) {
    if (a.at < chosen.start || a.at > chosen.end) continue;
    const url = resolveHttp(a.href, base);
    if (!url) continue;
    const label = collapse(a.text).slice(0, LINK_TEXT_CHARS);
    const seen = byUrl.get(url);
    if (seen) {
      if (!seen.text && label) seen.text = label;
      continue;
    }
    if (links.length >= MAX_LINKS) continue;
    const link = { url, text: label };
    byUrl.set(url, link);
    links.push(link);
  }
  return { title: collapse(title), text, links };
}

function charsetOf(contentType, bytes) {
  const declared = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType || '');
  if (declared) return declared[1];
  if (!bytes) return 'utf-8';
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 2048)).toString('latin1');
  const meta = /<meta[^>]{0,200}?charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return meta ? meta[1] : 'utf-8';
}

function decode(bytes, label) {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Reads the body but gives up (cancelling the stream) as soon as it passes maxBytes; null = too big.
async function readCapped(res, maxBytes) {
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(0, maxChars - 1));
  const at = cut.search(/\s\S*$/);
  return `${(at > maxChars / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

function abortError(signal) {
  const reason = signal.reason;
  return reason instanceof Error && reason.name === 'AbortError'
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function failure(err, timeout) {
  if (timeout.aborted) return 'timeout';
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    if (BLOCKED_CODES.has(e.code) || e.message === 'Invalid URL') return 'blocked';
    if (e.name === 'TimeoutError') return 'timeout';
  }
  return 'error';
}

/**
 * Fetch one untrusted page (SSRF-guarded on every redirect hop, no cookies) and return its main text.
 * Never throws, except with an AbortError when the caller's own `signal` aborted.
 * reason: 'blocked' | 'status' | 'type' | 'size' | 'timeout' | 'empty' | 'error'.
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, maxChars?: number, signal?: AbortSignal, fetcher?: Function }} [opts]
 * @returns {Promise<{ ok: true, url: string, title: string, text: string, links: { url: string, text: string }[] }
 *   | { ok: false, url: string, reason: string }>}
 */
export async function readPage(url, { timeoutMs = 8000, maxBytes = 3 * 1024 * 1024, maxChars = 6000, signal, fetcher = safeFetch } = {}) {
  if (signal?.aborted) throw abortError(signal);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const fail = (reason) => ({ ok: false, url, reason });
  try {
    const res = await fetcher(url, { headers: HEADERS, redirect: 'follow', credentials: 'omit', signal: combined }, { allowPrivate: false });
    const finalUrl = res.url || url;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return fail('status');
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const mime = contentType.split(';')[0].trim();
    const plain = mime === 'text/plain';
    if (mime && !plain && !mime.includes('html')) {
      await res.body?.cancel().catch(() => {});
      return fail('type');
    }
    const bytes = await readCapped(res, maxBytes);
    if (!bytes) return fail('size');
    const body = decode(bytes, charsetOf(contentType, plain ? null : bytes));
    const page = plain ? { title: '', text: tidy(body), links: [] } : extractMainText(body, finalUrl);
    if (!page.text) return fail('empty');
    return { ok: true, url: finalUrl, title: page.title, text: clip(page.text, maxChars), links: page.links };
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    return fail(failure(err, timeout));
  }
}
