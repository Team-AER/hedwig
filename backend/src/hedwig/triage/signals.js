// Stage 1: deterministic triage. Pure functions only — everything a decision depends on is passed
// in, so the rules are unit-testable and every reason names a signal that actually fired.
import { scoreRules } from '../../services/spamRules.js';
import { addressesOf, domainOf } from '../text.js';

export const CATEGORIES = Object.freeze(['needs_you', 'waiting_on', 'digest', 'notifications', 'everything', 'spam']);

// Upstream's verdict threshold (services/spamPipeline.js SPAM_THRESHOLD). Kept as a literal so this
// module stays free of the pipeline's database imports.
export const UPSTREAM_SPAM_THRESHOLD = 0.85;

const DAY = 86400_000;
const MAX_TEXT = 4000;

// ── Text analysis ────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_RE = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
// Words that turn a following date into a deadline ("by Friday", "due 30 Sep", "release them on Friday").
const TRIGGER_RE = '(?:by|before|until|no later than|due(?: on| by)?|deadline(?: is| of)?|expires?(?: on)?|(?:release|cancel|close)s? (?:them|it|the \\w+) on)';

const DEADLINE_PATTERNS = [
  { re: new RegExp(`\\b${TRIGGER_RE}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'i'), kind: 'dayMonth' },
  { re: new RegExp(`\\b${TRIGGER_RE}\\s+${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), kind: 'monthDay' },
  { re: new RegExp(`\\b${TRIGGER_RE}\\s+(?:this\\s+|next\\s+)?${WEEKDAY_RE}\\b`, 'i'), kind: 'weekday' },
  { re: new RegExp(`\\b${TRIGGER_RE}\\s+(tomorrow|today|tonight|end of (?:the )?day|eod|end of (?:the )?week|next week)\\b`, 'i'), kind: 'relative' },
  { re: /\bwithin\s+(\d{1,3})\s+(?:business\s+|working\s+)?days\b/i, kind: 'withinDays' },
  { re: /\b(?:in|within)\s+(\d{1,2})\s+weeks?\b/i, kind: 'withinWeeks' },
];

const GREETING_RE = /^(?:hi|hello|hey|dear|morning|afternoon|evening)\b[^,.!?]{0,40}[,.!]\s*/i;
const QUESTION_START = /^(?:can|could|would|will|do|does|did|is|are|was|were|have|has|which|when|what|where|who|how|shall|should|may|any)\b/i;
const REQUEST_RE = /\b(?:(?:can|could|would|will) you|please (?:send|confirm|reply|review|sign|let|check|call|advise|approve|pay|complete|fill|submit|provide|share|update|book|arrange)|let me know|need(?:s)? you to|waiting (?:for|on) your|get back to (?:me|us)|your (?:approval|signature|confirmation) (?:is )?(?:needed|required))\b/i;
const FOLLOW_UP_RE = /\b(?:just checking in|checking in|following up|follow(?:ing)? up on|gentle reminder|friendly reminder|a reminder|any update|bumping this|circling back)\b/i;
const URGENT_RE = /\b(?:asap|urgent(?:ly)?|immediately|time[- ]sensitive|as soon as possible)\b/i;
const INVOICE_RE = /\b(?:invoice|due|total|amount|balance|pay(?:ment)?|owe|fee|quote|price|cost|refund)\b/i;
const AMOUNT_RE = /(?:([£€$₹])\s?|\b(usd|eur|gbp|inr|chf)\s?)(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?/gi;
const CURRENCY_BY_CODE = { usd: '$', eur: '€', gbp: '£', inr: '₹', chf: 'CHF' };

function endOfDayUtc(y, m, d) {
  return new Date(Date.UTC(y, m, d, 23, 59, 0));
}

function addDays(ref, n) {
  const d = new Date(ref.getTime() + n * DAY);
  return endOfDayUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function monthIndex(word) {
  return MONTHS.indexOf(String(word).slice(0, 3).toLowerCase());
}

/** Resolve a date mentioned in a message relative to when the message was sent. */
function resolveDeadline(kind, m, ref) {
  const year = ref.getUTCFullYear();
  const withYearRoll = (mi, day) => {
    if (mi < 0 || day < 1 || day > 31) return null;
    let d = endOfDayUtc(year, mi, day);
    // A date well before the message was written means next year ("by 5 Jan" sent in December).
    if (d.getTime() < ref.getTime() - 30 * DAY) d = endOfDayUtc(year + 1, mi, day);
    return d;
  };
  switch (kind) {
    case 'dayMonth': return withYearRoll(monthIndex(m[2]), Number(m[1]));
    case 'monthDay': return withYearRoll(monthIndex(m[1]), Number(m[2]));
    case 'weekday': {
      const target = WEEKDAYS.indexOf(m[1].toLowerCase());
      const ahead = (target - ref.getUTCDay() + 7) % 7;
      return addDays(ref, ahead);
    }
    case 'relative': {
      const w = m[1].toLowerCase();
      if (w === 'tomorrow') return addDays(ref, 1);
      if (w === 'next week') return addDays(ref, 7);
      if (w.includes('week')) return addDays(ref, (5 - ref.getUTCDay() + 7) % 7);
      return addDays(ref, 0);
    }
    case 'withinDays': return addDays(ref, Math.min(365, Number(m[1])));
    case 'withinWeeks': return addDays(ref, Math.min(52, Number(m[1])) * 7);
    default: return null;
  }
}

export function parseAmounts(text) {
  const out = [];
  const s = String(text || '').slice(0, MAX_TEXT);
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(s)) && out.length < 20) {
    const currency = m[1] || CURRENCY_BY_CODE[m[2].toLowerCase()];
    const value = Number(m[3].replace(/,/g, '')) + (m[4] ? Number(`0.${m[4]}`) : 0);
    if (Number.isFinite(value) && value > 0) out.push({ currency, value, raw: m[0].trim() });
  }
  return out;
}

/**
 * What the text of one message asks for.
 * @param {string} text  stripped message text (no quoted history)
 * @param {Date} ref     when the message was sent (dates are relative to it)
 */
export function analyseText(text, ref = new Date()) {
  const s = String(text || '').slice(0, MAX_TEXT);
  const sentences = s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  // A question is a sentence ending in "?" that reads like one once a greeting is dropped ("Hi Ops,
  // can we …?"), or that is addressed to the reader.
  const questions = sentences.filter((x) => {
    if (!x.endsWith('?')) return false;
    const body = x.replace(GREETING_RE, '');
    return QUESTION_START.test(body) || /\b(?:you|your|someone|anyone|we)\b/i.test(body);
  });
  let deadline = null;
  for (const { re, kind } of DEADLINE_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const at = resolveDeadline(kind, m, ref);
    if (at && (!deadline || at < deadline.at)) deadline = { at, phrase: m[0].trim() };
  }
  return {
    question: questions.length > 0,
    questionText: questions[0] || null,
    request: REQUEST_RE.test(s),
    urgent: URGENT_RE.test(s),
    deadline,
    amounts: parseAmounts(s),
    moneyContext: INVOICE_RE.test(s),
    followUp: FOLLOW_UP_RE.test(s),
  };
}

// ── Sender kinds ─────────────────────────────────────────────────────────────

const NOTIFY_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|receipts?|orders?|order-updates?|shipping|shipment|security|automated|system|bounces?)$/;
const NOTIFY_LOCAL_PART = /(?:^|[-_.+])(?:no-?reply|noreply|donotreply|notifications?)(?:$|[-_.+])/;
const NEWSLETTER_LOCAL = /^(?:newsletters?|news|digest|weekly|updates?|marketing|promo(?:tions?)?|offers?|deals)$/;

export function senderKind(email) {
  const addr = String(email || '').toLowerCase();
  const local = addr.split('@')[0] || '';
  if (NOTIFY_LOCAL.test(local) || NOTIFY_LOCAL_PART.test(local)) return 'notification';
  if (NEWSLETTER_LOCAL.test(local)) return 'newsletter';
  return 'person';
}

// ── Spam ─────────────────────────────────────────────────────────────────────

const SCAM_PATTERNS = [
  ['verify your account', /\bverify (?:your )?(?:wallet|account|identity|password|payment)\b/i],
  ['claim a reward', /\bclaim (?:your )?(?:\S+ )?(?:reward|prize|btc|bitcoin|crypto|funds|refund|winnings)\b/i],
  ['crypto', /\b(?:btc|bitcoin|crypto(?:currency)?|usdt|ethereum|wallet)\b/i],
  ['threat of loss', /\b(?:lose|forfeit) (?:your )?(?:reward|access|account|funds|prize)\b|\baccount (?:will be |has been )?(?:suspended|locked|closed|terminated)\b/i],
  ['urgency', /\burgent\b|\bimmediately\b|\bwithin 24 hours\b|\bfinal (?:notice|warning)\b/i],
  ['gift card', /\bgift ?cards?\b/i],
];

const AUTH_RULES = { AUTH_DKIM_FAIL: 'DKIM', AUTH_SPF_FAIL: 'SPF', AUTH_DMARC_FAIL: 'DMARC' };

/**
 * Spam evidence: the user's own override, upstream's stored verdict, upstream's rules (when upstream
 * did not analyse the message), and a scam-phrase check for first-contact senders.
 */
export function spamEvidence(row, { text = '', sender = null } = {}) {
  const reasons = [];
  const details = row.spam_details && typeof row.spam_details === 'object' ? row.spam_details : null;
  const fired = Array.isArray(details?.rulesFired) ? details.rulesFired.map((r) => r?.name).filter(Boolean) : [];
  const authFail = fired.filter((n) => AUTH_RULES[n]).map((n) => AUTH_RULES[n]);

  if (row.spam_user_override === 'ham') return { spam: false, ham: true, reasons: [{ label: 'You marked this not spam', weight: 1, direction: 'against' }], authFail, source: 'override' };
  if (row.spam_user_override === 'spam') return { spam: true, reasons: [{ label: 'You marked this as spam', weight: 1, direction: 'for' }], authFail, source: 'override' };

  if (row.spam_verdict === 'spam') {
    const score = Number(details?.blendedScore ?? row.spam_score_ml);
    const top = fired.filter((n) => !AUTH_RULES[n]).slice(0, 2).map(humanRule);
    reasons.push({ label: `Spam filter verdict${top.length ? ` (${top.join(', ')})` : ''}`, weight: Number.isFinite(score) ? round(score) : 0.9, direction: 'for' });
    return { spam: true, reasons, authFail, source: 'upstream' };
  }

  let rulesScore = null;
  let rulesFired = [];
  if (!row.spam_verdict) {
    // Upstream classification is opt-in per account; run its rule engine ourselves when it did not.
    const res = scoreRules({
      subject: row.subject || '',
      body: text,
      from: row.from_email ? `<${row.from_email}>` : null,
      replyTo: null,
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      headers: [],
    });
    rulesScore = res.score;
    rulesFired = res.fired.map((r) => r.name);
    if (res.score >= UPSTREAM_SPAM_THRESHOLD) {
      reasons.push({ label: `Spam rules: ${rulesFired.slice(0, 3).map(humanRule).join(', ')}`, weight: round(res.score), direction: 'for' });
      return { spam: true, reasons, authFail, source: 'rules', rulesScore };
    }
  }

  const known = sender && (Number(sender.replied) > 0 || Number(sender.received) > 3);
  if (!known) {
    const hay = `${row.subject || ''}\n${text}`;
    const hits = SCAM_PATTERNS.filter(([, re]) => re.test(hay)).map(([label]) => label);
    const firstContact = !sender || Number(sender.received) <= 1;
    if (hits.length >= 3 || (hits.length >= 2 && firstContact && authFail.length)) {
      reasons.push({ label: `Scam phrasing: ${hits.slice(0, 3).join(', ')}`, weight: round(Math.min(1, 0.3 * hits.length)), direction: 'for' });
      if (firstContact) reasons.push({ label: 'First message from this sender', weight: 0.2, direction: 'for' });
      return { spam: true, reasons, authFail, source: 'scam', rulesScore, scamHits: hits };
    }
  }
  if (authFail.length) reasons.push({ label: `${authFail.join('/')} check failed`, weight: 0.4, direction: 'for' });
  return { spam: false, reasons, authFail, source: null, rulesScore, rulesFired };
}

function humanRule(name) {
  return String(name).toLowerCase().replace(/_/g, ' ');
}

// ── Thread facts ─────────────────────────────────────────────────────────────

/**
 * Facts about the thread around one incoming message.
 * @param {object} row          the message
 * @param {Array<{id, from_email, date, outgoing, text}>} thread  other messages in the same thread
 */
export function threadFacts(row, thread = []) {
  const date = row.date ? new Date(row.date).getTime() : Date.now();
  const before = thread.filter((t) => t.id !== row.id && t.date && new Date(t.date).getTime() <= date);
  const lastOut = before.filter((t) => t.outgoing).reduce((mx, t) => Math.max(mx, new Date(t.date).getTime()), -Infinity);
  const from = String(row.from_email || '').toLowerCase();
  // Messages from this sender since the user last wrote in the thread, this one included.
  const unanswered = 1 + before.filter((t) => !t.outgoing && String(t.from_email || '').toLowerCase() === from && new Date(t.date).getTime() > lastOut).length;
  const earlierAmounts = before.flatMap((t) => parseAmounts(t.text || ''));
  return {
    userRepliedBefore: Number.isFinite(lastOut),
    unanswered,
    earlierAmounts,
    length: before.length + 1,
  };
}

// ── Decision ─────────────────────────────────────────────────────────────────

// Log-odds contributions of each stage-1 signal to "needs you". Tuned so that a direct question
// to you alone crosses 0.5, while mail you are only Cc'd on needs a second signal.
export const WEIGHTS = Object.freeze({
  base: -2.0,
  question: 2.0,
  request: 1.5,
  deadline: 1.2,
  deadlineSoon: 0.5,
  urgent: 0.6,
  money: 0.5,
  moneyConflict: 1.0,
  askedTwice: 1.0,
  to: 0.6,
  ccOnly: -0.8,
  notAddressed: -1.2,
  repliedInThread: 0.7,
  youReplyToSender: 0.8,
  firstTime: -0.2,
  manyRecipients: -0.8,
  attachment: 0.2,
  authFail: -1.0,
  bulk: -3.0,
  notification: -2.5,
});

export const FLAG_LABELS = Object.freeze({
  question: 'Asks you a question',
  request: 'Asks you to do something',
  deadline: 'Mentions a deadline',
  deadlineSoon: 'Deadline within 3 days',
  urgent: 'Marked urgent',
  money: 'Mentions money',
  moneyConflict: 'Amount differs from earlier in the thread',
  askedTwice: 'Sender asked more than once',
  to: 'Sent to you directly',
  ccOnly: 'You are only in Cc',
  notAddressed: 'Not addressed to you',
  repliedInThread: 'You already replied in this thread',
  youReplyToSender: 'You usually reply to this sender',
  firstTime: 'First message from this sender',
  manyRecipients: 'Sent to many people',
  attachment: 'Has an attachment',
  authFail: 'Sender authentication failed',
  bulk: 'Bulk mail (List-Unsubscribe or bulk headers)',
  notification: 'Automated notification sender',
});

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

export function daysUntil(at, now = new Date()) {
  if (!at) return null;
  const a = new Date(at);
  const startA = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const startN = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((startA - startN) / DAY);
}

export function deadlineLabel(at, now = new Date()) {
  const d = daysUntil(at, now);
  if (d === null) return null;
  if (d < 0) return 'Deadline · overdue';
  if (d === 0) return 'Deadline · today';
  return `Deadline · ${d} d`;
}

function formatAmount(a) {
  const v = Number.isInteger(a.value) ? a.value.toLocaleString('en-GB') : a.value.toFixed(2);
  return a.currency.length === 1 ? `${a.currency}${v}` : `${v} ${a.currency}`;
}

/** Which of the user's sender/domain rules applies, sender rules first. */
export function matchRule(rules, fromEmail) {
  if (!rules?.length || !fromEmail) return null;
  const email = String(fromEmail).toLowerCase();
  const domain = domainOf(email);
  const bySender = rules.find((r) => r.kind === 'sender' && r.value === email);
  if (bySender) return bySender;
  return rules.find((r) => r.kind === 'domain' && domain && (domain === r.value || domain.endsWith(`.${r.value}`))) || null;
}

/**
 * Stage-1 triage of one incoming message.
 * @param {object} input
 * @param {object} input.row             message row (MESSAGE_COLUMNS)
 * @param {Set<string>} input.userAddresses
 * @param {string} input.text            stripped message text (falls back to snippet upstream)
 * @param {object|null} input.sender     hedwig_sender_stats row for the sender
 * @param {object} input.thread          threadFacts()
 * @param {Array} input.rules            the user's triage rules
 * @param {number} input.threshold       triage.needsYouThreshold
 * @param {Date} [input.now]
 */
export function stage1({ row, userAddresses = new Set(), text = '', sender = null, thread = null, rules = [], threshold = 0.5, now = new Date() }) {
  const facts = thread || threadFacts(row, []);
  const ref = row.date ? new Date(row.date) : now;
  const t = analyseText(text, ref);
  const to = addressesOf(row.to_addresses).map((a) => a.email);
  const cc = addressesOf(row.cc_addresses).map((a) => a.email);
  const mine = (list) => list.some((e) => userAddresses.has(e));
  const kind = senderKind(row.from_email);
  const upstreamCategory = row.category || null;
  const bulk = Boolean(row.is_bulk || row.list_unsubscribe || upstreamCategory === 'newsletter' || upstreamCategory === 'promotion');
  const notification = kind === 'notification' || upstreamCategory === 'automated' || upstreamCategory === 'social';
  const received = Number(sender?.received || 0);
  const replyRate = received > 0 ? Number(sender?.replied || 0) / received : 0;
  const spam = spamEvidence(row, { text, sender });

  const days = t.deadline ? daysUntil(t.deadline.at, now) : null;
  const priorAmounts = facts.earlierAmounts || [];
  const conflict = t.amounts.length > 0 && t.moneyContext && priorAmounts.length > 0
    && t.amounts.some((a) => priorAmounts.some((p) => p.currency === a.currency))
    && !t.amounts.some((a) => priorAmounts.some((p) => p.currency === a.currency && Math.abs(p.value - a.value) < 0.005));

  const flags = {
    question: t.question,
    request: t.request,
    deadline: Boolean(t.deadline),
    deadlineSoon: days !== null && days <= 3,
    urgent: t.urgent,
    money: t.amounts.length > 0,
    moneyConflict: conflict,
    // Only a chase counts: the latest message itself has to ask or nudge, not just be another update.
    askedTwice: facts.unanswered >= 2 && kind === 'person' && !bulk && (t.question || t.request || t.followUp),
    to: mine(to),
    ccOnly: !mine(to) && mine(cc),
    notAddressed: !mine(to) && !mine(cc) && userAddresses.size > 0,
    repliedInThread: facts.userRepliedBefore,
    youReplyToSender: received >= 2 && replyRate >= 0.3,
    firstTime: received <= 1,
    manyRecipients: to.length + cc.length > 10,
    attachment: Boolean(row.has_attachments),
    authFail: spam.authFail.length > 0,
    bulk,
    notification,
  };

  let z = WEIGHTS.base;
  const reasons = [];
  for (const [flag, on] of Object.entries(flags)) {
    if (!on) continue;
    const w = WEIGHTS[flag];
    z += w;
    let label = FLAG_LABELS[flag];
    if (flag === 'deadline' && t.deadline) label = `Deadline: “${t.deadline.phrase}”`;
    if (flag === 'money') label = `Mentions ${t.amounts.slice(0, 2).map(formatAmount).join(', ')}`;
    if (flag === 'moneyConflict') label = `${formatAmount(t.amounts[0])} differs from ${formatAmount(priorAmounts.find((p) => p.currency === t.amounts[0].currency) || priorAmounts[0])} earlier in the thread`;
    if (flag === 'askedTwice') label = `${row.from_name || row.from_email} wrote ${facts.unanswered} times without a reply`;
    reasons.push({ label, weight: round(Math.abs(w)), direction: w >= 0 ? 'for' : 'against', flag });
  }
  const p = sigmoid(z);

  // Category, most specific evidence first.
  let category;
  let hard = false;
  let reasonLabel;
  const rule = matchRule(rules, row.from_email);
  if (rule) {
    category = rule.category;
    hard = true;
    reasonLabel = 'Your rule';
    reasons.unshift({ label: `Your rule: mail from ${rule.value} → ${rule.category.replace('_', ' ')}`, weight: 1, direction: category === 'needs_you' ? 'for' : 'against', flag: 'rule' });
  } else if (spam.spam) {
    category = 'spam';
    hard = true;
    reasonLabel = spam.source === 'scam' ? 'Likely scam' : 'Spam';
    reasons.unshift(...spam.reasons.map((r) => ({ ...r, flag: 'spam' })));
  } else if (notification && !(t.question && kind === 'person')) {
    category = 'notifications';
    reasonLabel = 'Notification';
  } else if (bulk) {
    category = 'digest';
    reasonLabel = upstreamCategory === 'promotion' ? 'Promotion' : 'Newsletter';
  } else if (p >= threshold) {
    category = 'needs_you';
  } else {
    category = 'everything';
    reasonLabel = flags.ccOnly ? 'Cc' : flags.notAddressed ? 'Not to you' : 'FYI';
  }
  if (!spam.spam && spam.reasons.length && !reasons.some((r) => r.flag === 'authFail')) reasons.push(...spam.reasons);

  const seen = new Set();
  const unique = reasons.filter((r) => (seen.has(r.label) ? false : seen.add(r.label)));
  reasons.length = 0;
  reasons.push(...unique);

  const needsYou = category === 'needs_you';
  if (needsYou) reasonLabel = needsYouLabel({ flags, deadline: t.deadline, amounts: t.amounts, now });

  return {
    category,
    hard,
    p: round(p, 4),
    z: round(z, 4),
    needsYou,
    confidence: hard ? 0.95 : round(Math.min(0.95, Math.abs(p - 0.5) * 2), 3),
    flags,
    reasons,
    reasonLabel,
    deadlineAt: t.deadline?.at || null,
    amounts: t.amounts,
    analysis: t,
    rule,
    spam,
    senderKind: kind,
  };
}

/** One short phrase for the list chip, from the strongest signal that fired. */
export function needsYouLabel({ flags, deadline, amounts = [], now = new Date(), learnedSender = false }) {
  if (flags.moneyConflict) return 'Money · conflict';
  if (flags.askedTwice) return 'Asked twice';
  if (deadline) return deadlineLabel(deadline.at, now);
  if (flags.urgent) return 'Urgent';
  if ((flags.question || flags.request) && !flags.repliedInThread) return 'Owe a reply';
  if (learnedSender || flags.youReplyToSender) return 'You act on these';
  if (flags.question || flags.request) return 'Owe a reply';
  if (flags.money && amounts.length) return `Money · ${formatAmount(amounts[0])}`;
  return 'Needs you';
}
