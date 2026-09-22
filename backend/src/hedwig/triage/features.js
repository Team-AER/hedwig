// Stage-2 features. A message becomes a sparse map of named features (name → value); the model
// hashes names into a fixed-size weight space. Names are kept (not only their hashes) so feedback
// rows can be retrained after the hashing changes and explanations can say which features fired.
import { addressesOf, domainOf } from '../text.js';

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'from', 'this', 'that', 'are', 'was', 'our', 'has', 'have',
  'will', 'new', 'now', 'all', 'can', 'not', 'but', 'its', 'about', 'what', 'who', 'how', 'out', 'get', 'more', 'fwd', 're', 'fw']);

/** FNV-1a, 32-bit. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashIndex(name, bits = 18) {
  return fnv1a(name) & ((1 << bits) - 1);
}

/** Collapse a sparse named feature map onto hashed indices (collisions add). */
export function hashFeatures(features, bits = 18) {
  const out = new Map();
  for (const [name, value] of Object.entries(features || {})) {
    const v = Number(value);
    if (!v || !Number.isFinite(v)) continue;
    const idx = hashIndex(name, bits);
    out.set(idx, (out.get(idx) || 0) + v);
  }
  return out;
}

export function subjectTokens(subject, max = 12) {
  const words = String(subject || '').toLowerCase()
    .replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:\s*)+/i, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && w.length <= 24 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, max);
}

function rateBucket(num, den) {
  if (!den || den < 2) return 'new';
  const r = num / den;
  if (r === 0) return '0';
  if (r < 0.2) return 'low';
  if (r < 0.5) return 'mid';
  return 'high';
}

function countBucket(n) {
  if (n <= 1) return '1';
  if (n <= 3) return '2-3';
  if (n <= 10) return '4-10';
  if (n <= 50) return '11-50';
  return '50+';
}

function hourBucket(date) {
  if (!date) return 'unknown';
  const h = new Date(date).getUTCHours();
  if (h < 6) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/**
 * Build the feature map for one message.
 * @param {object} input
 * @param {object} input.row      message row
 * @param {object} input.s1       stage-1 result (flags are reused, so the two stages agree)
 * @param {object|null} input.sender  hedwig_sender_stats row
 * @param {object} input.thread   threadFacts()
 * @param {Record<string, number>} [input.extra]  plugin features (beforeTriage)
 */
export function buildFeatures({ row, s1, sender = null, thread = null, extra = null }) {
  const f = { bias: 1 };
  const from = String(row.from_email || '').toLowerCase();
  if (from) f[`s:${from}`] = 1;
  const domain = domainOf(from);
  if (domain) f[`d:${domain}`] = 1;
  for (const [flag, on] of Object.entries(s1?.flags || {})) if (on) f[`f:${flag}`] = 1;
  if (s1?.senderKind) f[`k:${s1.senderKind}`] = 1;
  if (row.is_bulk) f.bulk = 1;
  f[`cat:${row.category || 'none'}`] = 1;
  const recipients = addressesOf(row.to_addresses).length + addressesOf(row.cc_addresses).length;
  f[`rc:${countBucket(recipients)}`] = 1;
  if (row.has_attachments) f.att = 1;
  for (const w of subjectTokens(row.subject)) f[`w:${w}`] = 1;
  const received = Number(sender?.received || 0);
  f[`rr:${rateBucket(Number(sender?.replied || 0), received)}`] = 1;
  f[`or:${rateBucket(Number(sender?.opened || 0), received)}`] = 1;
  f[`au:${rateBucket(Number(sender?.archived_unread || 0) + Number(sender?.deleted_unread || 0), received)}`] = 1;
  f[`n:${countBucket(received)}`] = 1;
  if (thread?.userRepliedBefore) f['thr:replied'] = 1;
  f[`thr:len:${countBucket(thread?.length || 1)}`] = 1;
  f[`h:${hourBucket(row.date)}`] = 1;
  for (const [name, value] of Object.entries(extra || {})) {
    const v = Number(value);
    if (Number.isFinite(v) && v !== 0 && /^[\w.:-]{1,64}$/.test(name)) f[`p:${name}`] = Math.max(-5, Math.min(5, v));
  }
  return f;
}

const FLAG_TEXT = {
  question: 'asks you a question', request: 'asks you to do something', deadline: 'mentions a deadline',
  deadlineSoon: 'deadline within 3 days', urgent: 'marked urgent', money: 'mentions money',
  moneyConflict: 'amount conflicts with the thread', askedTwice: 'sender asked more than once',
  to: 'sent to you directly', ccOnly: 'you are only in Cc', notAddressed: 'not addressed to you',
  repliedInThread: 'you replied in this thread', youReplyToSender: 'you usually reply to this sender',
  firstTime: 'first message from this sender', manyRecipients: 'many recipients', attachment: 'has an attachment',
  authFail: 'sender authentication failed', bulk: 'bulk mail', notification: 'notification sender',
};

const RATE_TEXT = { new: 'too few to tell', 0: 'never', low: 'rarely', mid: 'sometimes', high: 'often' };

/** Human wording for one feature name, for "why" explanations. */
export function describeFeature(name) {
  const [kind, ...rest] = name.split(':');
  const v = rest.join(':');
  switch (kind) {
    case 'bias': return 'baseline';
    case 's': return `mail from ${v}`;
    case 'd': return `mail from ${v}`;
    case 'f': return FLAG_TEXT[v] || v;
    case 'k': return v === 'person' ? 'sent by a person' : `${v} sender`;
    case 'bulk': return 'bulk mail';
    case 'cat': return v === 'none' ? 'uncategorised' : `category ${v}`;
    case 'rc': return `${v} recipient${v === '1' ? '' : 's'}`;
    case 'att': return 'has an attachment';
    case 'w': return `subject mentions “${v}”`;
    case 'rr': return `you ${RATE_TEXT[v] || v} reply to this sender`;
    case 'or': return `you ${RATE_TEXT[v] || v} open this sender's mail`;
    case 'au': return `you ${RATE_TEXT[v] || v} archive this sender unread`;
    case 'n': return `${v} message${v === '1' ? '' : 's'} from this sender`;
    case 'thr': return v === 'replied' ? 'you replied in this thread' : `thread of ${v.replace('len:', '')}`;
    case 'h': return `arrived in the ${v}`;
    case 'p': return `plugin signal ${v}`;
    default: return name;
  }
}

/** Features that describe the sender's history rather than the message itself. */
export function isSenderFeature(name) {
  return /^(?:s|d|rr|or|au|n):/.test(name);
}
