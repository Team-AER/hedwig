// Newsletter detection and daily-paper selection. Pure functions.

const PLATFORM = /@(?:[a-z0-9-]+\.)*(substack\.com|beehiiv\.com|mail\.beehiiv\.com|convertkit\.com|ck\.page|buttondown\.email|ghost\.io|mailchimpapp\.net|mcsv\.net|list-manage\.com|mailerlite\.com|sendfox\.com|revue\.email|medium\.com|tinyletter\.com|every\.to|morningbrew\.com|theatlantic\.com)$/i;
const SENDER = /^(newsletters?|digest|news|weekly|daily|updates?|editors?|briefing|hello|letters?|dispatch|bulletin)[._+-]?[a-z0-9]*@/i;
const SUBJECT = /\b(issue\s*#?\d+|edition|newsletter|digest|weekly|roundup|round-up|this week|the week in|briefing|dispatch|vol\.?\s*\d+|#\d{1,4})\b/i;
const TRANSACTIONAL = /\b(receipt|invoice|order|payment|password|verify|verification|security alert|sign[- ]?in|log[- ]?in|one[- ]time code|otp|your code|reset|confirm your|shipped|delivery)\b/i;

/** Score + verdict for "this is a newsletter". `msg` is a message view or a triage ctx row. */
export function newsletterScore(msg) {
  let score = 0;
  const from = String(msg?.from_email || msg?.sender_email || '').toLowerCase();
  const subject = String(msg?.subject || '');
  if (msg?.category === 'newsletter') score += 3;
  if (msg?.has_list_unsubscribe || msg?.list_unsubscribe) score += 2;
  if (msg?.is_bulk) score += 1;
  if (PLATFORM.test(from)) score += 3;
  if (SENDER.test(from)) score += 2;
  if (SUBJECT.test(subject)) score += 1;
  if (TRANSACTIONAL.test(subject)) score -= 4;
  if (msg?.is_outgoing) score -= 10;
  return score;
}

export function isNewsletter(msg, threshold = 3) {
  return newsletterScore(msg) >= threshold;
}

/**
 * Pick the issues for a paper: newsletters since `since`, one row per issue, but only the newest
 * issue per sender (some send several a day), ordered by sender name.
 */
export function selectForPaper(messages, { since = null, max = 40 } = {}) {
  const sinceMs = since ? Date.parse(since) : 0;
  const bySender = new Map();
  for (const m of messages || []) {
    if (!m?.id || !isNewsletter(m)) continue;
    const t = m.date ? Date.parse(m.date) : 0;
    if (sinceMs && t < sinceMs) continue;
    const key = String(m.from_email || '').toLowerCase();
    const prev = bySender.get(key);
    if (!prev || (prev.date ? Date.parse(prev.date) : 0) < t) bySender.set(key, m);
  }
  return [...bySender.values()]
    .sort((a, b) => String(a.from_name || a.from_email).localeCompare(String(b.from_name || b.from_email)))
    .slice(0, max);
}

/** Calendar date (YYYY-MM-DD) and hour in an IANA time zone. */
export function localParts(tz, now = new Date()) {
  let zone = tz || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); } catch { zone = 'UTC'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Whether the scheduled tick should build today's paper. */
export function shouldBuild({ hour, paperHour, exists }) {
  return !exists && hour >= paperHour;
}

/** A one-line fallback when the model is unavailable: the snippet, trimmed to a sentence. */
export function snippetLine(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}
