// Evidence for the profile rebuild: facts computed by SQL (and plain counting over the user's own
// sent mail), each with an id, a kind, a plain statement and the numbers behind it. The model only
// words these facts; a profile line that mentions a number not in the facts it cites is discarded
// (lines.js validateLines). The builders are pure and exported for tests; gatherEvidence() runs the
// queries.
import { query } from '../../services/db.js';
import { CORRECTION_KINDS, recentCorrections } from '../ledger/corrections.js';
import { outgoingSql } from '../triage/store.js';
import { userAddresses } from '../pipeline.js';
import { splitBody } from '../indexer/parse.js';
import { voiceFeatures } from '../work/voice.js';

export const FACT_KINDS = Object.freeze(['people', 'ignore', 'reading', 'writing', 'preference']);

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const who = (name, email) => (name && name.toLowerCase() !== String(email).toLowerCase() ? `${clip(name, 60)} <${email}>` : String(email));
const hoursWord = (h) => {
  const n = Math.max(1, Math.round(Number(h) || 0));
  return { n, text: `${n} hour${n === 1 ? '' : 's'}` };
};

/** People the user answers quickly (behaviour 'reply' labels). rows: { email, name, replies, median_hours } */
export function replyFacts(rows, { days }) {
  return rows.map((r) => {
    const h = hoursWord(r.median_hours);
    return {
      kind: 'people',
      statement: `You replied to ${who(r.name, r.email)} ${r.replies} times in the last ${days} days, usually within ${h.text}.`,
      numbers: { replies: Number(r.replies), typicalHours: h.n, days },
      subject: String(r.email),
    };
  });
}

/** Organisations whose mail the user answers (hedwig_sender_stats by domain). */
export function domainFacts(rows) {
  return rows.map((r) => ({
    kind: 'people',
    statement: `Mail from ${r.domain}: you replied to ${r.replied} of ${r.received} messages from ${r.senders} ${Number(r.senders) === 1 ? 'person' : 'people'} there.`,
    numbers: { replied: Number(r.replied), received: Number(r.received), senders: Number(r.senders) },
    subject: String(r.domain),
  }));
}

/**
 * Senders the user leaves unread. stats: hedwig_sender_stats rows { sender_email, received, ignored,
 * replied, opened }; labels: behaviour 'archive_unread' counts { sender, n }. One fact per sender.
 */
export function ignoreFacts(stats, labels = []) {
  const bySender = new Map();
  for (const r of stats) {
    bySender.set(String(r.sender_email), {
      kind: 'ignore',
      statement: `${r.sender_email}: ${r.ignored} of ${r.received} messages left unread or archived unread, never replied to.`,
      numbers: { ignored: Number(r.ignored), received: Number(r.received) },
      subject: String(r.sender_email),
    });
  }
  for (const r of labels) {
    const key = String(r.sender || '');
    if (!key || bySender.has(key)) continue;
    bySender.set(key, {
      kind: 'ignore',
      statement: `You archived ${r.n} messages from ${key} without reading them.`,
      numbers: { archivedUnread: Number(r.n) },
      subject: key,
    });
  }
  return [...bySender.values()];
}

/** Kinds of mail (bundles) read or skipped. rows: { bundle, name, total, unread } */
export function bundleFacts(rows, { days, skipShare = 0.6, readShare = 0.3 } = {}) {
  const out = [];
  for (const r of rows) {
    const total = Number(r.total) || 0;
    const unread = Number(r.unread) || 0;
    if (!total) continue;
    const share = unread / total;
    const label = r.name || r.bundle;
    if (share >= skipShare) {
      out.push({ kind: 'ignore', statement: `${label}: ${unread} of ${total} messages in the last ${days} days left unread.`, numbers: { unread, total, days }, subject: `bundle:${r.bundle}` });
    } else if (share <= readShare) {
      out.push({ kind: 'reading', statement: `${label}: you opened ${total - unread} of ${total} messages in the last ${days} days.`, numbers: { opened: total - unread, total, days }, subject: `bundle:${r.bundle}` });
    }
  }
  return out;
}

function mostCommonWithCount(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null; let n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return { value: best, count: n };
}

/**
 * How the user writes, from their own sent mail. samples: [{ text, signature }].
 * @returns {{ facts: object[], excerpts: string[] }}
 */
export function writingFacts(samples, { days, minCount = 2, excerpts = 4 } = {}) {
  const usable = samples.filter((s) => s.text && s.text.trim());
  if (usable.length < minCount) return { facts: [], excerpts: [] };
  const feats = usable.map((s) => voiceFeatures(s.text, s.signature));
  const words = feats.map((f) => f.words).sort((a, b) => a - b);
  const median = words[Math.floor(words.length / 2)];
  const short = words.filter((w) => w <= 50).length;
  const n = usable.length;
  const facts = [{
    kind: 'writing',
    statement: `Your last ${n} sent messages in ${days} days: a median of ${median} words; ${short} of ${n} were 50 words or fewer.`,
    numbers: { messages: n, medianWords: median, short, days, limit: 50 },
    subject: 'writing:length',
  }];
  const g = mostCommonWithCount(feats.map((f) => f.greeting));
  if (g.value && g.count >= minCount) facts.push({ kind: 'writing', statement: `You open with "${g.value}" in ${g.count} of ${n} messages.`, numbers: { count: g.count, messages: n }, subject: 'writing:greeting' });
  const noGreeting = feats.filter((f) => !f.greeting).length;
  if (noGreeting >= minCount && noGreeting > n / 2) facts.push({ kind: 'writing', statement: `${noGreeting} of ${n} messages start without a greeting.`, numbers: { count: noGreeting, messages: n }, subject: 'writing:nogreeting' });
  const s = mostCommonWithCount(feats.map((f) => f.signOff));
  if (s.value && s.count >= minCount) facts.push({ kind: 'writing', statement: `You sign off with "${s.value}" in ${s.count} of ${n} messages.`, numbers: { count: s.count, messages: n }, subject: 'writing:signoff' });
  // A few short excerpts for tone only. They carry no numbers the model may cite.
  const picked = usable.slice(0, excerpts).map((x) => clip(x.text, 280));
  return { facts, excerpts: picked };
}

/** The user's corrections: counts by what they chose, plus their notes in their own words. */
export function correctionFacts(corrections) {
  const counts = new Map();
  const notes = [];
  for (const c of corrections) {
    const after = c?.after && typeof c.after === 'object' ? c.after : {};
    let what = null;
    if (c.kind === 'screener' && after.decision) what = after.decision === 'block' ? 'blocked a sender' : `put a sender in ${after.decision}`;
    else if (after.stream) what = `moved a message to ${after.stream}${after.bundle ? `/${after.bundle}` : ''}`;
    else if (after.needsYou === false) what = 'marked a message as not needing you';
    else if (after.needsYou === true) what = 'marked a message as needing you';
    else if (after.spam) what = `marked a message ${after.spam === 'clean' ? 'not spam' : after.spam}`;
    if (what) counts.set(what, (counts.get(what) || 0) + 1);
    if (c.note && String(c.note).trim()) notes.push(c);
  }
  const facts = [];
  const among = corrections.length === 1 ? 'In your one recent correction' : `Among your last ${corrections.length} corrections`;
  for (const [what, n] of counts) {
    facts.push({ kind: 'preference', statement: `${among}, you ${what} ${n === 1 ? 'once' : `${n} times`}.`, numbers: { times: n, corrections: corrections.length }, subject: `correction:${what}` });
  }
  for (const c of notes.slice(0, 12)) {
    const after = c.after && typeof c.after === 'object' ? c.after : {};
    const about = after.subject || after.from || c.before?.subject || c.before?.from;
    facts.push({ kind: 'preference', statement: `You wrote${about ? ` about "${clip(about, 80)}"` : ''}: "${clip(c.note, 200)}"`, numbers: {}, subject: `note:${c.id}` });
  }
  return facts;
}

/** Standing rules and blocks the user set up. */
export function ruleFacts(rules, blocked = 0) {
  const facts = rules.slice(0, 10).map((r) => ({ kind: 'preference', statement: `A rule you keep: "${clip(r.name, 120)}".`, numbers: {}, subject: `rule:${r.id}` }));
  if (blocked > 0) facts.push({ kind: 'preference', statement: `You have blocked ${blocked} sender${blocked === 1 ? '' : 's'}.`, numbers: { blocked }, subject: 'blocked' });
  return facts;
}

/** Give every fact a stable short id (f1, f2, …) in order. */
export function numberFacts(groups) {
  return groups.flat().map((f, i) => ({ id: `f${i + 1}`, ...f }));
}

/**
 * Run the queries and build the facts for one user.
 * @returns {Promise<{ facts: object[], excerpts: string[], counts: object }>}
 */
export async function gatherEvidence(userId, cfg, { days: windowDays = null } = {}) {
  const days = windowDays || cfg['profile.windowDays'];
  const min = cfg['profile.minCount'];
  const freemail = (cfg['context.freemailDomains'] || []).map((d) => String(d).toLowerCase());
  const addresses = [...((await userAddresses([userId])).get(userId) || new Set())];
  const [replies, domains, ignored, archived, bundles, sent, rules, blocked, corrections] = await Promise.all([
    query(
      `SELECT lower(m.from_email) AS email, MAX(m.from_name) AS name, COUNT(DISTINCT l.target_id)::int AS replies,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (l.evidence->>'hours')::float) AS median_hours
         FROM hedwig_labels l JOIN messages m ON m.id::text = l.target_id
        WHERE l.user_id = $1 AND l.suite = 'needs_you' AND l.source = 'behaviour' AND l.evidence->>'rule' = 'reply'
          AND COALESCE(m.date, l.created_at) > NOW() - make_interval(days => $2) AND m.from_email IS NOT NULL
        GROUP BY 1 HAVING COUNT(DISTINCT l.target_id) >= $3
        ORDER BY replies DESC, median_hours ASC LIMIT 10`,
      [userId, days, min],
    ),
    query(
      `SELECT domain, SUM(received)::int AS received, SUM(replied)::int AS replied, COUNT(*)::int AS senders
         FROM hedwig_sender_stats
        WHERE user_id = $1 AND domain IS NOT NULL AND NOT (lower(domain) = ANY($2::text[]))
          AND last_received > NOW() - make_interval(days => $3)
        GROUP BY domain
       HAVING SUM(replied) >= $4 AND SUM(replied)::float / NULLIF(SUM(received), 0) >= 0.3
        ORDER BY SUM(replied) DESC LIMIT 5`,
      [userId, freemail, days, min],
    ),
    query(
      `SELECT sender_email, received, opened, replied, (archived_unread + deleted_unread)::int AS ignored
         FROM hedwig_sender_stats
        WHERE user_id = $1 AND replied = 0 AND (archived_unread + deleted_unread) >= GREATEST($2, 3)
          AND last_received > NOW() - make_interval(days => $3)
        ORDER BY (archived_unread + deleted_unread) DESC LIMIT 8`,
      [userId, min, days],
    ),
    query(
      `SELECT evidence->>'sender' AS sender, COUNT(DISTINCT target_id)::int AS n
         FROM hedwig_labels
        WHERE user_id = $1 AND suite = 'needs_you' AND source = 'behaviour' AND evidence->>'rule' = 'archive_unread'
          AND created_at > NOW() - make_interval(days => $2)
        GROUP BY 1 HAVING COUNT(DISTINCT target_id) >= GREATEST($3, 3)
        ORDER BY n DESC LIMIT 8`,
      [userId, days, min],
    ),
    query(
      `SELECT s.bundle, MAX(b.name) AS name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT m.is_read)::int AS unread
         FROM hedwig_sort s
         JOIN messages m ON m.id = s.message_id
         LEFT JOIN hedwig_bundles b ON b.user_id = s.user_id AND b.key = s.bundle
        WHERE s.user_id = $1 AND s.stream IN ('reading','records') AND s.bundle IS NOT NULL AND NOT s.own AND NOT m.is_deleted
          AND m.date > NOW() - make_interval(days => $2)
        GROUP BY s.bundle HAVING COUNT(*) >= GREATEST($3, 5)
        ORDER BY COUNT(*) DESC LIMIT 12`,
      [userId, days, min],
    ),
    cfg['profile.sentSamples'] > 0
      ? query(
        `SELECT m.body_text, m.body_html, m.snippet
           FROM messages m
           JOIN email_accounts a ON a.id = m.account_id
           LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
          WHERE a.user_id = $1 AND NOT m.is_deleted AND ${outgoingSql('m', 'f', '$2')}
            AND m.date > NOW() - make_interval(days => $3)
          ORDER BY m.date DESC NULLS LAST LIMIT $4`,
        [userId, addresses, days, cfg['profile.sentSamples']],
      )
      : Promise.resolve({ rows: [] }),
    query(`SELECT id, name FROM hedwig_rules WHERE user_id = $1 AND enabled AND source = 'user' ORDER BY position LIMIT 10`, [userId]),
    query(`SELECT COUNT(*)::int AS n FROM hedwig_senders WHERE user_id = $1 AND decision = 'block' AND source = 'user' AND undone_at IS NULL`, [userId]),
    latestCorrections(userId, cfg['profile.corrections']),
  ]);
  const samples = sent.rows
    .map((r) => { const p = splitBody(r); return { text: (p.newText || '').trim(), signature: p.signature || '' }; })
    .filter((s) => s.text);
  const writing = writingFacts(samples, { days, minCount: min });
  const facts = numberFacts([
    replyFacts(replies.rows, { days }),
    domainFacts(domains.rows),
    ignoreFacts(ignored.rows, archived.rows),
    bundleFacts(bundles.rows, { days }),
    writing.facts,
    correctionFacts(corrections),
    ruleFacts(rules.rows, Number(blocked.rows[0]?.n) || 0),
  ]);
  return { facts, excerpts: writing.excerpts, counts: { corrections: corrections.length, sent: samples.length }, days };
}

/** The latest `n` corrections across every kind, newest first (B's recentCorrections is per kind). */
export async function latestCorrections(userId, n) {
  if (!n) return [];
  const lists = await Promise.all(CORRECTION_KINDS.map(async (kind) => ((await recentCorrections(userId, kind, n)) || []).map((c) => ({ kind, ...c }))));
  return lists.flat().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, n);
}
