// Layer 1b: headers. Pure functions over a message row (MESSAGE_COLUMNS plus the optional extras
// listed below); every signal names what actually fired so "why" can show it.
//
// MailFlow does not store raw headers, so this layer reads what ingest kept: is_bulk (List-Id,
// List-Unsubscribe, List-Post, Precedence), list_unsubscribe, category (automated / newsletter /
// promotion / social, from Auto-Submitted, calendar Content-Type, marketing headers), attachments
// (text/calendar, .ics), spam_details (Authentication-Results as judged by upstream against the
// account's trusted authserv-id) and the folder. When a row carries `headers` (an object or an
// array of "Name: value" lines, e.g. from a future ingest column), those are read first.
import { addressesOf, domainOf } from '../text.js';
import { senderKind } from '../triage/signals.js';

const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

/** Lower-cased header map from row.headers plus what ingest derived. */
export function headerMap(row) {
  const out = {};
  const h = row?.headers;
  if (Array.isArray(h)) {
    for (const line of h) {
      const m = /^([^:]+):\s*(.*)$/s.exec(String(line));
      if (m) {
        const k = m[1].trim().toLowerCase();
        out[k] = out[k] ? `${out[k]}\n${m[2]}` : m[2];
      }
    }
  } else if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = Array.isArray(v) ? v.join('\n') : String(v ?? '');
  }
  if (!out['list-unsubscribe'] && row?.list_unsubscribe) out['list-unsubscribe'] = String(row.list_unsubscribe);
  return out;
}

/** Sender keys a decision can be made at: address, list (List-Id) and domain. */
export function senderKeys(row, headers = headerMap(row)) {
  const address = String(row?.from_email || '').trim().toLowerCase() || null;
  const domain = address ? domainOf(address) : null;
  const listId = /<([^<>\s]+)>/.exec(headers['list-id'] || '')?.[1] || String(headers['list-id'] || '').trim() || null;
  return { address, domain, list: listId ? listId.toLowerCase().slice(0, 200) : null };
}

/** The key a held message is grouped under in the Screener: the list when there is one. */
export function screenerKey(keys) {
  if (keys.list) return { key: keys.list, scope: 'list' };
  if (keys.address) return { key: keys.address, scope: 'address' };
  return null;
}

/**
 * Authentication results. Trusted results come from upstream's spam analysis (it honours only the
 * account's trusted authserv-id); a raw header on the row is used but marked untrusted.
 * Each of spf/dkim/dmarc is 'pass' | 'fail' | null (unknown).
 */
export function authResults(row, headers = headerMap(row)) {
  const res = { spf: null, dkim: null, dmarc: null, trusted: false };
  const details = row?.spam_details && typeof row.spam_details === 'object' ? row.spam_details : null;
  if (details) {
    const fired = new Set((details.rulesFired || []).map((r) => r?.name).filter(Boolean));
    if (details.authTrusted) {
      res.trusted = true;
      res.spf = fired.has('AUTH_SPF_FAIL') ? 'fail' : 'pass';
      res.dkim = fired.has('AUTH_DKIM_FAIL') ? 'fail' : 'pass';
      res.dmarc = fired.has('AUTH_DMARC_FAIL') ? 'fail' : 'pass';
      return res;
    }
    if (fired.has('AUTH_SPF_FAIL')) res.spf = 'fail';
    if (fired.has('AUTH_DKIM_FAIL')) res.dkim = 'fail';
    if (fired.has('AUTH_DMARC_FAIL')) res.dmarc = 'fail';
  }
  const raw = headers['authentication-results'];
  if (raw) {
    for (const mech of ['spf', 'dkim', 'dmarc']) {
      if (res[mech]) continue;
      const m = new RegExp(`\\b${mech}=(\\w+)`, 'i').exec(raw);
      if (!m) continue;
      const v = m[1].toLowerCase();
      res[mech] = v === 'pass' ? 'pass' : ['fail', 'softfail', 'permerror', 'reject', 'quarantine'].includes(v) ? 'fail' : null;
    }
  }
  return res;
}

const SPAM_FOLDER_RE = /(^|\/)(spam|junk|junk e-?mail|bulk mail)$/i;

export function inSpamFolder(row) {
  return row?.special_use === '\\Junk' || SPAM_FOLDER_RE.test(String(row?.folder || ''));
}

export function isCalendar(row, headers = headerMap(row)) {
  const ct = String(headers['content-type'] || '').toLowerCase();
  if (ct.includes('text/calendar') || ct.includes('application/ics')) return true;
  const atts = Array.isArray(row?.attachments) ? row.attachments : [];
  return atts.some((a) => {
    const type = String(a?.contentType || a?.content_type || a?.mimeType || a?.type || '').toLowerCase();
    const name = String(a?.filename || a?.name || '').toLowerCase();
    return type.includes('calendar') || type.includes('ics') || name.endsWith('.ics') || name.endsWith('.vcs');
  });
}

export function isAutoSubmitted(row, headers = headerMap(row)) {
  const v = String(headers['auto-submitted'] || '').trim().toLowerCase();
  if (v && v !== 'no') return true;
  return row?.category === 'automated';
}

export function isListMail(row, headers = headerMap(row)) {
  const prec = String(headers.precedence || '').trim().toLowerCase();
  return Boolean(headers['list-id'] || headers['list-unsubscribe'] || headers['list-post'] || prec === 'bulk' || prec === 'list'
    || row?.is_bulk || row?.list_unsubscribe);
}

/**
 * The header layer for one message.
 * @param {object} row
 * @param {object} ctx
 * @param {Set<string>} [ctx.userAddresses]
 * @param {boolean} [ctx.replyToOwn]  the message answers a message or thread the user wrote in
 * @returns {{ keys, auth, own, replyToOwn, list, auto, calendar, spamFolder, kind,
 *   hard: null|{stream, confidence, reason, needsYou?}, prior: null|{stream, bundle?, confidence, reason}, signals: Array }}
 */
export function headerLayer(row, { userAddresses = new Set(), replyToOwn = false } = {}) {
  const headers = headerMap(row);
  const keys = senderKeys(row, headers);
  const auth = authResults(row, headers);
  const from = keys.address || '';
  const own = Boolean(row?.is_outgoing) || row?.special_use === '\\Sent' || (from && userAddresses.has(from));
  const list = isListMail(row, headers);
  const auto = isAutoSubmitted(row, headers);
  const calendar = isCalendar(row, headers);
  const spamFolder = inSpamFolder(row);
  const kind = senderKind(from);
  const category = row?.category || null;
  const signals = [];
  const add = (name, label, weight = 0) => signals.push({ name, label, weight: round(weight) });

  if (own) add('own', 'You sent this', 1);
  if (replyToOwn) add('replyToOwn', 'A reply in a thread you wrote in', 1);
  if (list) add('list', headers['list-id'] ? `Mailing list ${keys.list}` : 'Mailing list or bulk headers (List-Unsubscribe / Precedence)', 0.6);
  if (auto) add('auto', 'Sent automatically (Auto-Submitted or a system sender)', 0.5);
  if (calendar) add('calendar', 'Calendar invitation', 0.8);
  if (spamFolder) add('spamFolder', 'Your provider filed this as spam', 0.4);
  if (category === 'promotion') add('promotion', 'Marketing platform headers', 0.5);
  if (category === 'social') add('social', 'Social network notification', 0.5);
  if (kind !== 'person') add('senderKind', kind === 'notification' ? 'Automated sender address (no-reply, notifications)' : 'Newsletter sender address', 0.4);
  for (const mech of ['dmarc', 'spf', 'dkim']) {
    if (auth[mech] === 'fail') add(`auth:${mech}`, `${mech.toUpperCase()} failed${auth.trusted ? '' : ' (unverified header)'}`, auth.trusted ? 0.4 : 0.15);
  }
  if (auth.trusted && auth.dmarc === 'pass') add('auth:dmarcPass', 'Passed DMARC', 0.3);

  let hard = null;
  if (own) hard = { stream: 'people', confidence: 1, reason: 'You sent this', needsYou: false };
  else if (replyToOwn && !spamFolder) hard = { stream: 'people', confidence: 0.97, reason: 'A reply in a thread you wrote in' };

  let prior = null;
  if (!hard) {
    const to = addressesOf(row?.to_addresses).map((a) => a.email);
    const direct = to.some((e) => userAddresses.has(e));
    if (calendar) prior = { stream: 'records', bundle: 'calendar', confidence: 0.85, reason: 'A calendar invitation' };
    else if (category === 'social') prior = { stream: 'records', bundle: 'social', confidence: 0.78, reason: 'A social network notification' };
    else if (category === 'promotion') prior = { stream: 'reading', bundle: 'promotions', confidence: 0.78, reason: 'Marketing mail' };
    else if (auto || kind === 'notification') prior = { stream: 'records', confidence: list ? 0.74 : 0.7, reason: 'Sent automatically, not by a person' };
    else if (list || kind === 'newsletter') prior = { stream: 'reading', confidence: 0.72, reason: 'A newsletter or mailing list' };
    else if (kind === 'person' && direct) prior = { stream: 'people', confidence: 0.6, reason: 'A person writing to you directly' };
  }
  return { keys, headers, auth, own, replyToOwn, list, auto, calendar, spamFolder, kind, hard, prior, signals };
}
