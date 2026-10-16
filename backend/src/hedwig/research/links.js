// Link policy for links found inside mail. Ask may read the pages a thread links to, but opening some
// links acts for the user (unsubscribe, confirm, sign in, RSVP, pay) and click-tracking redirects tell the
// sender the mail was read, so every link is classified before anything is fetched. Pure, no I/O.
import { Parser } from 'htmlparser2';
import { canonicalUrl } from './searx.js';

const MAX_LINKS = 100;
const MAX_CANDIDATES = 40;
const TEXT_CHARS = 200;
const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function httpUrl(raw) {
  try {
    const u = new URL(String(raw ?? '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * `<a href>` links in an HTML mail body: http(s) only, deduplicated by URL (keeping the first non-empty
 * anchor text), at most 100.
 * @param {string} html
 * @returns {{ url: string, text: string }[]}
 */
export function extractLinks(html) {
  if (!html) return [];
  const links = [];
  const byUrl = new Map();
  let anchor = null;
  let skip = 0;
  const add = (a) => {
    const u = httpUrl(a.href);
    if (!u) return;
    const text = collapse(a.text).slice(0, TEXT_CHARS);
    const seen = byUrl.get(u.href);
    if (seen) {
      if (!seen.text && text) seen.text = text;
      return;
    }
    if (links.length >= MAX_LINKS) return;
    const link = { url: u.href, text };
    byUrl.set(u.href, link);
    links.push(link);
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (SKIP.has(name)) skip++;
      if (name !== 'a') return;
      if (anchor) add(anchor);
      anchor = attrs.href ? { href: attrs.href, text: '' } : null;
    },
    ontext(text) {
      if (anchor && !skip) anchor.text += text;
    },
    onclosetag(name) {
      if (SKIP.has(name)) skip = Math.max(0, skip - 1);
      if (name === 'a' && anchor) {
        add(anchor);
        anchor = null;
      }
    },
  }, { decodeEntities: true });
  parser.write(String(html));
  parser.end();
  if (anchor) add(anchor);
  return links;
}

const TRAILING = new Set([')', '.', ',', ';', ':', '!', '?', '\'', '"', ']', '>']);
const count = (s, ch) => s.split(ch).length - 1;

/**
 * Bare http(s) URLs in a plain-text mail body, trailing punctuation stripped (a closing parenthesis is
 * kept when the URL opened one), deduplicated, at most 100.
 * @param {string} text
 * @returns {{ url: string, text: string }[]}
 */
export function extractTextLinks(text) {
  const links = [];
  const seen = new Set();
  for (const [match] of String(text ?? '').matchAll(/\bhttps?:\/\/[^\s<>"]+/gi)) {
    let url = match;
    while (url && TRAILING.has(url.at(-1))) {
      if (url.at(-1) === ')' && count(url, '(') >= count(url, ')')) break;
      url = url.slice(0, -1);
    }
    const u = httpUrl(url);
    if (!u || seen.has(u.href)) continue;
    seen.add(u.href);
    links.push({ url: u.href, text: '' });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

const V3_RUNS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Proofpoint v3 replaces characters of the target with `*` (one character) or `**X` (a run whose length
// X encodes) and carries the removed characters base64url-encoded after `__;`.
function urldefenseV3(raw) {
  const m = /^https?:\/\/urldefense\.com\/v3\/__(.+?)__;([^!]*)!/i.exec(raw);
  if (!m) return null;
  const removed = [...Buffer.from(m[2], 'base64url').toString('utf8')];
  let at = 0;
  return safeDecode(m[1]).replace(/\*(\*.)?/g, (_, run) => {
    const len = run ? V3_RUNS.indexOf(run[1]) + 2 : 1;
    const chars = removed.slice(at, at + len).join('');
    at += len;
    return chars;
  });
}

function unwrapOnce(raw) {
  const u = httpUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const param = (k) => u.searchParams.get(k);
  if (host.endsWith('.safelinks.protection.outlook.com')) return param('url');
  if (host === 'urldefense.proofpoint.com') {
    if (path.startsWith('/v2/url')) {
      const v = param('u');
      return v && safeDecode(v.replace(/_/g, '/').replace(/-/g, '%'));
    }
    if (path.startsWith('/v1/url')) return param('u');
  }
  if (host === 'urldefense.com' && path.startsWith('/v3/__')) return urldefenseV3(String(raw).trim());
  if ((host === 'www.google.com' || host === 'google.com') && path === '/url') return param('q') || param('url');
  if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && path === '/l.php') return param('u');
  if ((host === 'www.linkedin.com' || host === 'linkedin.com') && path === '/redir/redirect') return param('url');
  return null;
}

/**
 * The destination of a known redirect wrapper (Outlook SafeLinks, Proofpoint urldefense v1-v3, Google,
 * Facebook and LinkedIn redirects), unwrapped up to three levels; the input when it is not wrapped or the
 * destination is not http(s).
 * @param {string} url
 * @returns {string}
 */
export function unwrapLink(url) {
  let current = url;
  for (let i = 0; i < 3; i++) {
    const next = httpUrl(unwrapOnce(current));
    if (!next) break;
    current = next.href;
  }
  return current;
}

/**
 * Click-tracking redirect services, as host (and optional path) patterns on the lower-case host name.
 * @type {{ host: RegExp, path?: RegExp }[]}
 */
export const TRACKER_HOSTS = [
  { host: /(^|\.)list-manage\.com$/, path: /^\/track\/click/ },
  { host: /(^|\.)sendgrid\.net$/, path: /^\/ls\/click/ },
  { host: /\.ct\.sendgrid\.net$/ },
  { host: /(^|\.)hubspotlinks\.com$/ },
  { host: /(^|\.)hs-sites\.com$/, path: /\/e3t\// },
  { host: /(^|\.)mailchimp\.com$/, path: /\/track\// },
  { host: /(^|\.)substack\.com$/, path: /^\/redirect\// },
  { host: /^mailchi\.mp$/ },
  { host: /(^|\.)mailgun\.org$/ },
  { host: /^email\.mg\./ },
  { host: /(^|\.)rs6\.net$/ },
  { host: /(^|\.)cmail(19|20)\.com$/ },
  { host: /(^|\.)createsend1\.com$/ },
  { host: /^(t\.co|lnkd\.in|bit\.ly|ow\.ly|buff\.ly)$/ },
  { host: /(^|\.)awstrack\.me$/ },
  { host: /(^|\.)sparkpostmail\.com$/ },
  { host: /(^|\.)mandrillapp\.com$/, path: /^\/track\// },
  { host: /(^|\.)exacttarget\.com$/ },
  { host: /(^|\.)klclick1?\.com$/ },
  { host: /(^|\.)beehiiv\.com$/, path: /^\/ss\/c\// },
  { host: /^link\.mail\.beehiiv\.com$/ },
];

/** First host labels that mark a sender's own click-tracking subdomain (click.example.com/<opaque>). */
export const TRACKER_PREFIXES = new Set([
  'click', 'clicks', 'link', 'links', 'email', 'mail', 'e', 't', 'trk', 'track', 'tracking', 'r', 'go', 'ablink', 'url',
]);

function isTracker(u) {
  const host = u.hostname.toLowerCase();
  if (TRACKER_HOSTS.some((p) => p.host.test(host) && (!p.path || p.path.test(u.pathname)))) return true;
  const labels = host.split('.');
  if (labels.length < 3 || !TRACKER_PREFIXES.has(labels[0])) return false;
  if (u.pathname.split('/').some((seg) => /^[A-Za-z0-9_=-]{20,}$/.test(seg))) return true;
  for (const [, v] of u.searchParams) if (v.length >= 30) return true;
  return false;
}

// Matched against lower-case words joined by single spaces (see words()). URL patterns are prefix
// matches, so camelCase and suffixed forms count (resetPassword, verification); anchor text needs whole
// words. Order matters: the first rule that matches names the reason.
const ACTION_RULES = [
  {
    reason: 'unsubscribe',
    url: /\bunsub|\bopt ?out\b|\boptout|\b(?:email|manage|mail|subscription)s? ?pref|\bpref(?:erence)?s? ?cent(?:er|re)\b/,
    text: /\b(?:unsubscribe|opt ?out|(?:manage|update|change|email) (?:your |my )?(?:email |mail |subscription )?preferences?)\b/,
  },
  {
    reason: 'confirm',
    url: /\b(?:confirm|verif|activat|validat)/,
    text: /\b(?:confirm|verify|verification|activate|validate)\b/,
  },
  {
    reason: 'password',
    url: /(?<![0-9])pass(?:word|wd)|\bpass (?:word|wd)\b|\breset|\bpw ?reset/,
    text: /\b(?:reset|password)\b/,
  },
  {
    reason: 'sign-in',
    url: /\b(?:log|sign)(?:in|on)(?!g)|\b(?:log|sign) (?:in|on)\b|\b(?:o?auth\d*|authori[sz]e|sso|saml|magic ?link|magic|one ?time|otp|mfa|2fa)\b/,
    text: /\b(?:log ?(?:in|on)|sign ?(?:in|on)|magic ?link|one ?time (?:code|link|login|password|passcode)|otp)\b/,
  },
  {
    reason: 'respond',
    url: /\b(?:approv|accept|declin|reject|rsvp|respond)/,
    text: /\b(?:approve|accept|decline|reject|rsvp|respond|tentative)\b/,
    // A calendar invitation's Yes / No / Maybe buttons.
    also: (u) => (u.pathname.includes('/calendar') || u.hostname.startsWith('calendar.'))
      && (u.searchParams.has('action') || u.searchParams.has('rst')),
  },
  {
    reason: 'payment',
    url: /\bpay(?:ment|ments| ?now)?\b|\bcheckout|\bbilling/,
    text: /\b(?:pay|payment|pay now|checkout|billing)\b/,
  },
];

const TOKEN_PARAM = /^(?:.*[-_.])?(?:token|auth|key|code|sig|signature|hash|session|sid|otp|ticket)$|(?:token|signature|ticket|sessionid)$/i;

// Words of a string, lower-cased and space-joined. camelCase is split, except in tokens with digits or
// long ones, which are opaque ids where a split would only find accidental words.
function words(s) {
  const out = [];
  for (const tok of String(s ?? '').split(/[^A-Za-z0-9]+/)) {
    if (!tok) continue;
    if (/\d/.test(tok) || tok.length > 40) out.push(tok);
    else out.push(...tok.replace(/([a-z])([A-Z])/g, '$1 $2').split(' '));
  }
  return out.join(' ').toLowerCase();
}

function paramsOf(u) {
  const params = [...u.searchParams];
  if (u.hash.includes('=')) params.push(...new URLSearchParams(u.hash.slice(1)));
  return params;
}

// utm_* parameters name the sender's campaign ("payment-reminder"), never what the link does.
function urlWords(u) {
  const parts = [u.hostname.replace(/\./g, ' '), safeDecode(u.pathname)];
  for (const [k, v] of paramsOf(u)) if (!/^utm_/i.test(k)) parts.push(k, v);
  return words(parts.join(' '));
}

function unsubscribeUrls(list) {
  const items = Array.isArray(list) ? list : String(list ?? '').match(/<[^>]*>|[^,\s]+/g) || [];
  return items.map((s) => String(s).trim().replace(/^<|>$/g, '')).filter((s) => httpUrl(s)).map(canonicalUrl);
}

function actionReason(urls, text, listUnsubscribe) {
  const unsubscribe = new Set(unsubscribeUrls(listUnsubscribe));
  if (urls.some((u) => unsubscribe.has(canonicalUrl(u.href)))) return 'unsubscribe';
  const urlText = urls.map(urlWords);
  const anchor = words(text);
  for (const rule of ACTION_RULES) {
    if (urlText.some((w) => rule.url.test(w)) || rule.text.test(anchor) || urls.some((u) => rule.also?.(u))) return rule.reason;
  }
  for (const u of urls) {
    if (paramsOf(u).some(([k, v]) => TOKEN_PARAM.test(k) && v.length >= 16)) return 'token';
  }
  return null;
}

/**
 * How Ask may treat a link from mail. `url` is the unwrapped destination.
 * - 'skip'    (reason 'scheme'): not http(s), or unparsable.
 * - 'action'  (reason 'unsubscribe' | 'confirm' | 'password' | 'sign-in' | 'respond' | 'payment' | 'token'):
 *   opening it could act for the user, so Hedwig never opens it. Checked first, on the raw URL, the
 *   unwrapped URL and the anchor text.
 * - 'tracked' (reason 'tracker'): a click-tracking redirect.
 * - 'open'    (reason null).
 * @param {string} rawUrl
 * @param {{ text?: string, listUnsubscribe?: string[]|string }} [opts]  listUnsubscribe: the List-Unsubscribe URLs
 * @returns {{ kind: 'skip'|'action'|'tracked'|'open', url: string, reason: string|null }}
 */
export function classifyLink(rawUrl, { text = '', listUnsubscribe = [] } = {}) {
  const raw = String(rawUrl ?? '').trim();
  const outer = httpUrl(raw);
  if (!outer) return { kind: 'skip', url: raw, reason: 'scheme' };
  const inner = httpUrl(unwrapLink(raw)) || outer;
  const url = inner.href;
  const urls = url === outer.href ? [outer] : [outer, inner];
  const reason = actionReason(urls, text, listUnsubscribe);
  if (reason) return { kind: 'action', url, reason };
  if (isTracker(inner)) return { kind: 'tracked', url, reason: 'tracker' };
  return { kind: 'open', url, reason: null };
}

/**
 * Numbered link candidates (L1, L2, …) from an email thread (oldest first) for Ask's planner:
 * deduplicated by unwrapped canonical URL, 'skip' links left out, at most 40 (links with anchor text
 * preferred), in thread order. A link that is an action anywhere in the thread stays an action.
 * @param {{ id: any, body_html?: string, body_text?: string }[]} messages
 * @param {{ listUnsubscribe?: string[]|string }} [opts]
 * @returns {{ id: string, url: string, text: string, kind: string, reason: string|null, messageId: any }[]}
 */
export function emailLinks(messages, { listUnsubscribe = [] } = {}) {
  const byKey = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    let found = m.body_html ? extractLinks(m.body_html) : [];
    if (!found.length && m.body_text) found = extractTextLinks(m.body_text);
    for (const link of found) {
      const c = classifyLink(link.url, { text: link.text, listUnsubscribe });
      if (c.kind === 'skip') continue;
      const key = canonicalUrl(c.url);
      const seen = byKey.get(key);
      if (seen) {
        if (!seen.text && link.text) seen.text = link.text;
        if (c.kind === 'action' && seen.kind !== 'action') Object.assign(seen, { kind: c.kind, reason: c.reason });
        continue;
      }
      byKey.set(key, { order: byKey.size, url: c.url, text: link.text, kind: c.kind, reason: c.reason, messageId: m.id ?? null });
    }
  }
  let picked = [...byKey.values()];
  if (picked.length > MAX_CANDIDATES) {
    picked = [...picked.filter((l) => l.text), ...picked.filter((l) => !l.text)]
      .slice(0, MAX_CANDIDATES)
      .sort((a, b) => a.order - b.order);
  }
  return picked.map((l, i) => ({ id: `L${i + 1}`, url: l.url, text: l.text, kind: l.kind, reason: l.reason, messageId: l.messageId }));
}
