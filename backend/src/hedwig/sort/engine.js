// The sorting engine. Layers, cheapest first; each decides or passes down with a confidence:
//   1. rules and headers: user rules, sender decisions, own mail, replies to own threads, list and
//      automated headers, calendar MIME, the server spam folder (weak), authentication results
//   2. classifier: sorting heads on triage's model code, or a prior from sender history
//   3. Reflex (sort.reflex), batched, as a job once the body is present or sort.bodyWaitSec passed
//   4. escalation to the reasoning tier for low confidence or suspected phishing
// Every stored row records its layer, reason, signals and prompt/model provenance.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { llmAvailable } from '../llm.js';
import { messageText, addressesOf, domainOf } from '../text.js';
import { MESSAGE_COLUMNS, decorate } from '../pipeline.js';
import { HEDWIG_HOOKS, collectHedwigHook, runHedwigHook } from '../hooks.js';
import { stage1 } from '../triage/signals.js';
import { loadSenderStats, outgoingSql } from '../triage/store.js';
import { fnv1a } from '../triage/features.js';
import { validTimezone, describeNow } from '../insights/time.js';
import { getState, setState } from '../state.js';
import { headerLayer, screenerKey, inSpamFolder, listRule } from './headers.js';
import { assessSpam, rescueScore, SPAM_SIGNALS_VERSION, DEFAULT_TRUSTED_LINK_HOSTS } from './spam.js';
import { applyRules, loadRules, bumpHits, matchDescriptions } from './rules.js';
import { sortFeatures, priorStream, headsActive, predictHeads, loadHeads } from './classifier.js';
import { loadBundles, guessBundle, isScheduled, lastSlot } from './bundles.js';
import { loadDecisions, pickDecision, setSenderDecision, ensureSeeded, recordWrittenTo, streamOf, decisionKey, gateOnly } from './senders.js';
import { engineStamp } from './version.js';
import { reflexItem, runReflex, cleanReason } from './reflex.js';
import { messagePartsFor, recentCorrections, runSortPrompt, sortEscalationUseful } from './deps.js';
import { writeLog } from './log.js';

const DAY = 86400_000;
const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const SOFT_ERRORS = new Set(['llm_disabled', 'budget_exceeded']);

// Columns sorting needs beyond MESSAGE_COLUMNS (spam analysis, Reply-To).
export const EXTRA_COLUMNS = 'm.spam_verdict, m.spam_details, m.spam_user_override, m.spam_score_ml';

// ── Context ─────────────────────────────────────────────────────────────────

async function threadFactsFor(userId, rows, addresses) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return new Map();
  const { rows: found } = await query(
    `SELECT m.id,
            EXISTS (SELECT 1 FROM messages o LEFT JOIN folders ofo ON ofo.account_id = o.account_id AND ofo.path = o.folder
                     WHERE o.account_id = m.account_id AND o.id <> m.id AND NOT o.is_deleted AND o.date <= m.date
                       AND ((m.thread_key IS NOT NULL AND o.thread_key = m.thread_key) OR (m.in_reply_to IS NOT NULL AND o.message_id = m.in_reply_to))
                       AND ${outgoingSql('o', 'ofo', '$3')}) AS reply_to_own,
            EXISTS (SELECT 1 FROM messages o LEFT JOIN folders ofo ON ofo.account_id = o.account_id AND ofo.path = o.folder
                     WHERE o.account_id = m.account_id AND o.id <> m.id AND NOT o.is_deleted AND o.date > m.date
                       AND ((m.thread_key IS NOT NULL AND o.thread_key = m.thread_key) OR (m.message_id IS NOT NULL AND o.in_reply_to = m.message_id))
                       AND ${outgoingSql('o', 'ofo', '$3')}) AS replied_after
       FROM messages m JOIN email_accounts a ON a.id = m.account_id
      WHERE m.id = ANY($1::uuid[]) AND a.user_id = $2`,
    [ids, userId, [...addresses]],
  );
  return new Map(found.map((r) => [r.id, { replyToOwn: r.reply_to_own, repliedAfter: r.replied_after }]));
}

const knownCache = new Map(); // userId -> { at, domains }
/**
 * Domains the user corresponds with: senders they replied to or hear from regularly, and everyone
 * they wrote to or put in a stream themselves (hedwig_senders). Lookalike targets and the domains
 * a message may link to or take replies at without looking foreign.
 */
async function knownDomains(userId) {
  const c = knownCache.get(userId);
  if (c && Date.now() - c.at < 10 * 60_000) return c.domains;
  const { rows } = await query(
    `SELECT domain FROM hedwig_sender_stats WHERE user_id = $1 AND domain IS NOT NULL AND (replied > 0 OR received >= 3)
     UNION
     SELECT CASE WHEN scope = 'address' THEN split_part(key, '@', 2) ELSE key END FROM hedwig_senders
      WHERE user_id = $1 AND undone_at IS NULL AND decision <> 'block' AND scope IN ('address','domain')
        AND (source IN ('user','import') OR reason = 'You wrote to them')
     LIMIT 3000`,
    [userId],
  );
  const domains = rows.map((r) => r.domain).filter(Boolean);
  knownCache.set(userId, { at: Date.now(), domains });
  return domains;
}

async function userProfile(userId, addresses) {
  const { rows } = await query('SELECT display_name, username FROM users WHERE id = $1', [userId]);
  return { name: rows[0]?.display_name || rows[0]?.username || null, addresses: [...addresses] };
}

/** Everything decideCheap needs for a batch of one user's rows. */
export async function loadUserContext(userId, rows, cfg) {
  const addresses = rows[0]?.user_addresses || new Set();
  const incoming = rows.filter((r) => !r.is_outgoing);
  const keysList = incoming.map((r) => headerLayer(r, { userAddresses: addresses }).keys);
  const ids = rows.map((r) => r.id);
  const [bundles, rules, heads, stats, decisions, triage, threads, user, known, existing] = await Promise.all([
    loadBundles(userId),
    loadRules(userId),
    loadHeads(userId),
    loadSenderStats(userId, incoming.map((r) => r.from_email)),
    loadDecisions(userId, keysList),
    query(
      `SELECT message_id, needs_you, overridden, override_category, category, reason_label FROM hedwig_triage
        WHERE user_id = $1 AND message_id = ANY($2::uuid[])`,
      [userId, ids],
    ).then((r) => new Map(r.rows.map((t) => [t.message_id, t]))),
    threadFactsFor(userId, incoming, addresses),
    userProfile(userId, addresses),
    knownDomains(userId).then((d) => [...new Set([...d, ...[...addresses].map(domainOf).filter(Boolean)])]),
    query('SELECT message_id, layer, stream, spam, pending FROM hedwig_sort WHERE user_id = $1 AND message_id = ANY($2::uuid[])', [userId, ids])
      .then((r) => new Map(r.rows.map((s) => [s.message_id, s]))),
  ]);
  // When Hedwig first saw each message (the body wait is timed from this, not from the Date header).
  const seenAt = await query('SELECT message_id, seen_at FROM hedwig_msg WHERE user_id = $1 AND message_id = ANY($2::uuid[])', [userId, ids])
    .then((r) => new Map((r?.rows || []).map((s) => [s.message_id, s.seen_at])));
  return {
    userId, cfg, userAddresses: addresses, bundles, rules, heads, stats, decisions, triage, threads, user, knownDomains: known, existing,
    seenAt, ruleHits: [], now: new Date(),
  };
}

// ── Layers 1–2 (pure given the context) ─────────────────────────────────────

const TITLES = new Set(['dr', 'dr.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'prof', 'prof.', 'sir', 'dame']);

function firstName(row) {
  const words = String(row.from_name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length && !/@/.test(words[0])) {
    if (TITLES.has(words[0].toLowerCase()) && words[1]) return `${words[0]} ${words[1]}`;
    return words[0];
  }
  return String(row.from_email || 'The sender').split('@')[0];
}

const shortDate = (d) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d));

/** Plain second-person needs-you reason from triage's read of the message. Exported for tests. */
export function needsYouText(row, s1, triageRow = null) {
  const who = firstName(row);
  const a = s1?.analysis || {};
  const f = s1?.flags || {};
  const label = triageRow?.reason_label || '';
  let text = null;
  if (f.moneyConflict || label === 'Money · conflict') text = 'The amount differs from what was agreed earlier in the thread';
  else if (f.askedTwice || label === 'Asked twice') text = `${who} has asked more than once without a reply`;
  else if (a.deadline && (f.question || f.request)) text = `${who} needs a reply by ${shortDate(a.deadline.at)}`;
  else if (a.deadline) text = `Due by ${shortDate(a.deadline.at)}`;
  else if (f.question && a.questionText) text = `${who} asks: ${a.questionText}`;
  else if (f.request) text = `${who} asks you to do something`;
  else if (label) text = label;
  return text ? cleanReason(text) : null;
}

function triageNeedsYou(t) {
  if (!t) return null;
  if (t.overridden) return t.override_category === 'needs_you';
  return Boolean(t.needs_you);
}

/**
 * Layers 1 and 2 for one incoming or outgoing message. Pure given `ctx` (loadUserContext).
 * @returns {object} decision: stream, proposed, bundle, needsYou, needsYouReason, spam, spamReason,
 *   spamConfidence, confidence, layer, reason, signals, features, labels, notify, ruleId, final,
 *   needsScreen, screenKey, own, inSpamFolder, header, s1, text, senderDecision, phishingScore
 */
export function decideCheap(row, ctx) {
  const cfg = ctx.cfg;
  const now = ctx.now || new Date();
  const text = messageText(row, { maxChars: 4000 });
  const facts = ctx.threads?.get(row.id) || {};
  const header = headerLayer(row, { userAddresses: ctx.userAddresses, replyToOwn: Boolean(facts.replyToOwn) });
  const { keys } = header;
  const sender = ctx.stats?.get(keys.address || '') || null;
  const s1 = stage1({ row, userAddresses: ctx.userAddresses, text, sender, rules: [], threshold: cfg['triage.needsYouThreshold'] ?? 0.5, now });
  const features = sortFeatures({ row, s1, sender, header });
  const senderDecision = pickDecision(keys, ctx.decisions || new Map());
  const trustedSender = Boolean((senderDecision && senderDecision.decision !== 'block' && ['user', 'import'].includes(senderDecision.source))
    || Number(sender?.replied) > 0);
  const spam = assessSpam(row, {
    text, sender, auth: header.auth, knownDomains: ctx.knownDomains || [], spamFolder: header.spamFolder, trustedSender,
    trustedLinkHosts: Array.isArray(cfg['spam.trustedLinkHosts']) ? cfg['spam.trustedLinkHosts'] : DEFAULT_TRUSTED_LINK_HOSTS,
  });

  // List mail: Reading (final) or a Reading/Records floor, never People (see headers.js listRule).
  const list = listRule(header, row, text);
  const gate = gateOnly(senderDecision);

  const t = ctx.triage?.get(row.id) || null;
  const tNeeds = triageNeedsYou(t);
  let needsYou = tNeeds ?? Boolean(s1.needsYou);
  let needsYouReason = needsYou ? needsYouText(row, s1, t) : null;
  if (facts.repliedAfter) { needsYou = false; needsYouReason = null; }

  const d = {
    stream: null, proposed: null, bundle: null, needsYou, needsYouReason,
    spam: spam.verdict, spamReason: spam.reason, spamConfidence: spam.confidence, phishingScore: spam.phishingScore,
    confidence: 0, layer: 'classifier', reason: null,
    signals: [...header.signals, ...spam.signals.filter((s) => !header.signals.some((h) => h.name === s.name))],
    features, labels: [], notify: false, ruleId: null, final: false, needsScreen: false,
    screenKey: screenerKey(keys), own: header.own, inSpamFolder: header.spamFolder, header, s1, text, senderDecision, keys,
    ruleMatches: [], prompt: null, listRule: false, listFloor: list ? list.stream : null, listReason: list ? list.reason : null,
    rowLite: { from_name: row.from_name, from_email: row.from_email, subject: row.subject },
  };
  if (facts.repliedAfter) d.signals.push({ name: 'replied', label: 'You replied', weight: 1 });
  const decideWith = (stream, { layer, confidence, reason, final = true }) => {
    Object.assign(d, { stream, proposed: stream === 'spam' ? d.proposed : stream, layer, confidence: round(confidence), reason, final });
  };

  // 1a. own mail
  if (header.own) {
    decideWith('people', { layer: 'rule', confidence: 1, reason: 'You sent this' });
    d.needsYou = false; d.needsYouReason = null; d.spam = 'clean'; d.spamReason = null;
    return d;
  }

  // 1b. user rules without model predicates
  const pre = applyRules(ctx.rules, { row, headers: header.headers, keys, text }, { phase: 'pre' });
  d.labels = pre.labels;
  d.notify = pre.notify;
  if (pre.matched.length) ctx.ruleHits?.push(...pre.matched);
  if (pre.rule) {
    const bundleStream = pre.effect.bundle ? ctx.bundles?.find((b) => b.key === pre.effect.bundle)?.stream : null;
    decideWith(pre.effect.stream || bundleStream || 'records', { layer: 'rule', confidence: 1, reason: cleanReason(`Your rule “${pre.rule.name}”`) });
    d.ruleId = pre.rule.id;
    if (pre.effect.bundle) d.bundle = pre.effect.bundle;
    d.signals.unshift({ name: 'rule', label: `Your rule “${pre.rule.name}”`, weight: 1 });
  } else if (senderDecision?.decision === 'block' && senderDecision.source === 'user') {
    decideWith('spam', { layer: 'rule', confidence: 1, reason: 'You blocked this sender' });
  } else if (header.hard && !header.spamFolder) {
    decideWith(header.hard.stream, { layer: 'rule', confidence: header.hard.confidence, reason: header.hard.reason });
  } else if (senderDecision?.source !== 'user' && list?.final && !header.spamFolder) {
    // A newsletter: the headers settle it before any automatic sender decision or model.
    decideWith(list.stream, { layer: 'rule', confidence: list.confidence, reason: list.reason });
    d.bundle = list.bundle;
    d.listRule = true;
    d.signals.unshift({ name: 'listRule', label: list.reason, weight: list.confidence });
    if (gate) d.signals.push({ name: 'alwaysIn', label: cleanReason(senderDecision.reason || 'You have written to them'), weight: 0.5 });
  } else if (gate) {
    // The Screener's door only: the stream is decided per message below.
    d.signals.unshift({ name: 'alwaysIn', label: cleanReason(senderDecision.reason || 'You have written to them'), weight: 0.5 });
  } else if (senderDecision) {
    const conf = senderDecision.source === 'user' ? 1 : Number(senderDecision.confidence ?? 0.9);
    const scopeWord = senderDecision.scope === 'address' ? 'this sender' : senderDecision.scope === 'list' ? 'this list' : senderDecision.key;
    const reason = senderDecision.source === 'user'
      ? (senderDecision.decision === 'block' ? 'You blocked this sender' : `You put ${scopeWord} in ${cap(senderDecision.decision)}`)
      : cleanReason(senderDecision.reason || `Screened into ${cap(senderDecision.decision)}`);
    decideWith(streamOf(senderDecision.decision), {
      layer: 'rule', confidence: conf, reason,
      final: senderDecision.source === 'user' || senderDecision.source === 'import' || conf >= cfg['sort.classifierDecideAbove'],
    });
    d.signals.unshift({ name: 'senderDecision', label: `${cap(senderDecision.source)} decision: ${senderDecision.scope} ${senderDecision.key} → ${senderDecision.decision}`, weight: round(conf) });
  }

  // 2. classifier (always computed: it proposes the stream even when a sender decision settles it)
  const minSamples = cfg['sort.classifierMinSamples'] ?? 40;
  let cls;
  if (headsActive(ctx.heads, minSamples)) {
    const h = predictHeads(ctx.heads, features);
    const prior = priorStream({ s1, sender, header });
    const version = ctx.heads.people?.version;
    cls = {
      stream: h.stream, confidence: h.confidence, reason: h.stream === prior.stream ? prior.reason : `Mail like this usually goes to ${cap(h.stream)}`,
      bundle: prior.bundle || null, spamP: h.spam,
      signals: [{ name: 'classifier', label: `Your sorting classifier${version ? ` v${version}` : ''} (${ctx.heads.people?.samples || 0} examples)`, weight: round(h.confidence) }, ...h.signals],
    };
  } else {
    cls = priorStream({ s1, sender, header });
  }
  // List mail is never People by the classifier: a list the user replies to still sends issues.
  if (list && cls.stream === 'people') {
    cls = { ...cls, stream: list.stream, bundle: list.bundle || cls.bundle || null, confidence: Math.min(cls.confidence, list.confidence), reason: list.reason, forcedFloor: true };
  }
  if (!d.stream) {
    decideWith(cls.stream, { layer: 'classifier', confidence: cls.confidence, reason: cleanReason(cls.reason), final: !cls.forcedFloor && cls.confidence >= cfg['sort.classifierDecideAbove'] });
    d.signals.push(...(cls.signals || []));
  } else if (d.stream === 'spam' && !d.proposed) {
    d.proposed = cls.stream;
  }
  if (!d.proposed) d.proposed = cls.stream;
  if (cls.spamP !== undefined && cls.spamP !== null && cls.spamP >= 0.9 && d.spam === 'clean' && !trustedSender) {
    d.spam = 'suspected'; d.spamConfidence = round(cls.spamP); d.spamReason = 'Mail like this is usually spam for you';
  }

  // Spam: the server folder is weak; strong verdicts override automatic stream decisions.
  const userDecided = d.layer === 'rule' && (d.ruleId || senderDecision?.source === 'user');
  if (header.spamFolder && !userDecided) {
    d.stream = 'spam'; d.final = true;
  } else if (!userDecided && !trustedSender) {
    const escalatePhishing = d.spam === 'phishing' && d.spamConfidence < (cfg['spam.phishingEscalateBelow'] ?? 0.8);
    if (d.spam === 'phishing' && !escalatePhishing) { d.stream = 'spam'; d.final = true; d.reason = cleanReason(d.spamReason); }
    else if (d.spam === 'suspected' && d.spamConfidence >= 0.85) { d.stream = 'spam'; d.final = true; d.reason = cleanReason(d.spamReason); }
    if (escalatePhishing) d.final = false;
  }

  // Bundle (Reading and Records only).
  if (['reading', 'records'].includes(d.stream)) {
    d.bundle = d.bundle || guessBundle({ row, text, stream: d.stream, prior: cls.bundle ? { bundle: cls.bundle } : header.prior }, ctx.bundles || []);
  } else if (d.stream !== 'spam') d.bundle = null;
  // A newsletter no keyword places still belongs with the other newsletters.
  if (d.stream === 'reading' && d.listFloor && !d.bundle && (ctx.bundles || []).some((b) => b.key === 'updates' && b.enabled !== false)) d.bundle = 'updates';
  // Needs You is a People concept for recent mail. List and records mail never need you (their
  // deadlines live in the ledger), and the question heuristic must not surface a months-old
  // "PayPal asks: Not sure why you received this email?" as something waiting on the owner.
  const needsMaxDays = cfg['sort.needsYouMaxAgeDays'] ?? 30;
  const needsTooOld = needsMaxDays > 0 && row.date && now.getTime() - new Date(row.date).getTime() > needsMaxDays * DAY;
  if ((d.stream && d.stream !== 'people') || d.listFloor || needsTooOld) { d.needsYou = false; d.needsYouReason = null; }

  // Screener: undecided senders' recent mail waits for a decision.
  const holdDays = cfg['sort.screenerHoldDays'] ?? 14;
  const recent = holdDays > 0 && row.date && now.getTime() - new Date(row.date).getTime() <= holdDays * DAY;
  d.needsScreen = Boolean(!senderDecision && !d.ruleId && !header.replyToOwn && d.stream !== 'spam' && recent && d.screenKey);
  return d;
}

// ── Merge model output ──────────────────────────────────────────────────────

const SPAM_RANK = { clean: 0, suspected: 1, phishing: 2 };
// A model's "suspected" verdict moves mail out of the streams only when it is this sure.
const SUSPECTED_TO_SPAM = 0.8;

/** Fold a Reflex/reasoning result into a cheap decision. Exported for tests. */
export function mergeReflex(d, r, { bundles = [] } = {}) {
  const userDecided = d.layer === 'rule' && (d.ruleId || d.senderDecision?.source === 'user');
  if (!userDecided) {
    let stream = r.stream;
    let reason = r.reason || d.reason;
    // Mailing lists stay out of People whatever the model read into a personal greeting.
    if (d.listFloor && stream === 'people') {
      stream = d.listFloor;
      reason = d.listReason || reason;
      d.signals.push({ name: 'listFloor', label: 'Mailing list headers: kept out of People', weight: 0.6 });
    }
    d.layer = r.layer;
    d.confidence = r.confidence;
    d.reason = reason;
    d.stream = stream;
    d.proposed = stream;
    d.bundle = ['reading', 'records'].includes(stream) ? ((stream === r.stream && r.bundle) || guessBundle({ row: d.rowLite || {}, text: d.text, stream }, bundles) || null) : null;
  }
  d.final = true;
  d.needsYou = r.needsYou;
  d.needsYouReason = r.needsYou ? (r.needsYouReason || d.needsYouReason) : null;
  if (r.spam !== 'clean') {
    if (SPAM_RANK[r.spam] >= (SPAM_RANK[d.spam] ?? 0) || d.inSpamFolder) {
      d.spam = r.spam; d.spamReason = r.reason; d.spamConfidence = r.confidence;
    }
  } else if (!d.inSpamFolder && d.spam !== 'clean' && r.confidence >= 0.6 && d.spamConfidence < 0.9) {
    d.spam = 'clean'; d.spamReason = null; d.spamConfidence = r.confidence;
  }
  const trusted = d.senderDecision && d.senderDecision.decision !== 'block' && ['user', 'import'].includes(d.senderDecision.source);
  if (!userDecided && !trusted && (d.spam === 'phishing' || (d.spam === 'suspected' && d.spamConfidence >= SUSPECTED_TO_SPAM))) {
    d.stream = 'spam';
    d.bundle = null;
  }
  if (d.inSpamFolder && !userDecided) d.stream = 'spam';
  if (d.stream !== 'people') { d.needsYou = false; d.needsYouReason = null; } // Needs You is a People concept
  d.ruleMatches = r.matches || [];
  d.prompt = r.provenance || null;
  d.signals.push({ name: r.layer, label: `${r.layer === 'reasoning' ? 'Reasoning model' : 'Reflex'}: ${r.reason || r.stream}`, weight: r.confidence });
  if (d.needsScreen && d.senderDecision) d.needsScreen = false;
  return d;
}

/** Model-predicate rules, once a decision exists. Mutates and returns d. */
export function applyPostRules(d, row, ctx) {
  const post = applyRules(ctx.rules, {
    row, headers: d.header.headers, keys: d.keys, text: d.text,
    decision: { stream: d.stream, bundle: d.bundle, confidence: d.confidence }, ruleMatches: d.ruleMatches,
  }, { phase: 'post' });
  if (post.matched.length) ctx.ruleHits?.push(...post.matched);
  d.labels = [...new Set([...d.labels, ...post.labels])];
  if (post.notify) d.notify = true;
  if (post.rule) {
    const bundleStream = post.effect.bundle ? ctx.bundles?.find((b) => b.key === post.effect.bundle)?.stream : null;
    d.stream = post.effect.stream || bundleStream || d.stream;
    if (post.effect.bundle) d.bundle = post.effect.bundle;
    if (!['reading', 'records'].includes(d.stream)) d.bundle = null;
    d.layer = 'rule';
    d.confidence = 1;
    d.ruleId = post.rule.id;
    d.reason = cleanReason(`Your rule “${post.rule.name}”`);
    d.signals.unshift({ name: 'rule', label: `Your rule “${post.rule.name}”`, weight: 1 });
    d.needsScreen = false;
  }
  return d;
}

// ── Plugins ─────────────────────────────────────────────────────────────────

function hookMessage(row, text) {
  return {
    id: row.id, accountId: row.account_id, folder: row.folder, subject: row.subject,
    from: { name: row.from_name, email: row.from_email }, to: addressesOf(row.to_addresses), cc: addressesOf(row.cc_addresses),
    date: row.date, text, isBulk: Boolean(row.is_bulk), category: row.category || null, hasAttachments: Boolean(row.has_attachments),
  };
}

/** beforeSort: the first valid plugin verdict wins, below the user's own rules and decisions. */
async function applyPluginVerdict(userId, row, d) {
  if (d.layer === 'rule' && (d.ruleId || d.senderDecision?.source === 'user')) return;
  const results = await collectHedwigHook(HEDWIG_HOOKS.beforeSort, {
    userId, message: hookMessage(row, d.text), proposal: { stream: d.stream, bundle: d.bundle, confidence: d.confidence, layer: d.layer },
  }).catch(() => []);
  for (const res of results || []) {
    const v = res?.verdict;
    if (!v || !['people', 'reading', 'records', 'spam'].includes(v.stream)) continue;
    const pluginId = String(res.pluginId || v.pluginId || 'plugin').slice(0, 64);
    d.stream = v.stream;
    d.proposed = v.stream === 'spam' ? d.proposed : v.stream;
    if (['reading', 'records'].includes(v.stream)) d.bundle = typeof v.bundle === 'string' ? v.bundle.slice(0, 64) : d.bundle;
    else d.bundle = null;
    if (typeof v.needsYou === 'boolean') d.needsYou = v.needsYou;
    d.layer = 'rule';
    d.confidence = 1;
    d.final = true;
    d.needsScreen = false;
    d.reason = cleanReason(`Plugin ${pluginId}${v.reason ? `: ${v.reason}` : ''}`);
    d.signals.unshift({ name: `plugin:${pluginId}`, label: d.reason, weight: 1 });
    return;
  }
}

// ── Finalise and store ──────────────────────────────────────────────────────

/** Every needs-you decision says why, even when neither triage nor the model gave a reason. */
export function ensureNeedsYouReason(row, d) {
  if (d.needsYou && !d.needsYouReason) d.needsYouReason = cleanReason(`${firstName(row)} may need something from you`);
  return d;
}

function toSortInfo(d) {
  return { stream: d.stream, bundle: d.bundle, needsYou: d.needsYou, spam: d.spam, layer: d.layer, reason: d.reason, confidence: d.confidence };
}

async function upsertSort(userId, row, d, { pending = null } = {}) {
  const p = d.prompt || {};
  const { rows } = await query(
    `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, proposed_stream, bundle, held, needs_you, needs_you_reason,
                              spam, spam_reason, confidence, layer, reason, signals, features, labels, notify, rule_id, rule_matches,
                              sender_key, sender_scope, own, in_spam_folder, pending, prompt_id, prompt_version, model, ai_call_id,
                              decided_at, body_seen, engine_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,NOW(),$30,$31)
     ON CONFLICT (message_id) DO UPDATE SET
       stream = EXCLUDED.stream, proposed_stream = EXCLUDED.proposed_stream, bundle = EXCLUDED.bundle, held = EXCLUDED.held,
       needs_you = EXCLUDED.needs_you, needs_you_reason = EXCLUDED.needs_you_reason, spam = EXCLUDED.spam, spam_reason = EXCLUDED.spam_reason,
       confidence = EXCLUDED.confidence, layer = EXCLUDED.layer, reason = EXCLUDED.reason, signals = EXCLUDED.signals,
       features = EXCLUDED.features, labels = EXCLUDED.labels, notify = EXCLUDED.notify, rule_id = EXCLUDED.rule_id,
       rule_matches = EXCLUDED.rule_matches, sender_key = EXCLUDED.sender_key, sender_scope = EXCLUDED.sender_scope,
       own = EXCLUDED.own, in_spam_folder = EXCLUDED.in_spam_folder, pending = EXCLUDED.pending,
       prompt_id = EXCLUDED.prompt_id, prompt_version = EXCLUDED.prompt_version, model = EXCLUDED.model, ai_call_id = EXCLUDED.ai_call_id,
       decided_at = NOW(), body_seen = EXCLUDED.body_seen, engine_version = EXCLUDED.engine_version
     WHERE hedwig_sort.user_id = EXCLUDED.user_id AND hedwig_sort.layer <> 'user'
     RETURNING *`,
    [row.id, userId, row.account_id, d.stream, d.proposed && d.proposed !== 'spam' ? d.proposed : null, d.bundle, Boolean(d.held),
      Boolean(d.needsYou), d.needsYouReason, d.spam, d.spamReason ? cleanReason(d.spamReason, 140) : null, d.confidence, d.layer,
      d.reason, JSON.stringify(d.signals.slice(0, 16)), JSON.stringify(d.features || null), d.labels || [], Boolean(d.notify), d.ruleId,
      JSON.stringify(d.ruleMatches || []), d.screenKey?.key || null, d.screenKey?.scope || null, Boolean(d.own), Boolean(d.inSpamFolder),
      pending, p.promptId || null, p.promptVersion || null, p.model || null, p.aiCallId ?? null, Boolean(row.body_text || row.body_html),
      engineStamp()],
  );
  return rows[0] || null;
}

/**
 * Screener hold or auto-screen, bundle hold, opt-in spam move; then store and fire afterSort.
 * @returns {Promise<object|null>} the stored row (null when a user correction protects it)
 */
export async function finalize(userId, row, d, ctx, { pending = null } = {}) {
  const cfg = ctx.cfg;
  if (d.needsScreen && d.screenKey && !d.own) {
    const live = ctx.decisions.get(decisionKey(d.screenKey.scope, d.screenKey.key));
    if (live) {
      d.stream = streamOf(live.decision);
      d.needsScreen = false;
    } else {
      const canAuto = cfg['sort.autoScreen'] && d.final && !pending && d.confidence >= cfg['sort.autoScreenAbove']
        && ['people', 'reading', 'records'].includes(d.proposed) && !d.inSpamFolder;
      if (canAuto) {
        const res = await setSenderDecision(userId, {
          key: d.screenKey.key, scope: d.screenKey.scope, decision: d.proposed, source: 'auto', confidence: d.confidence,
          reason: d.reason, messageId: row.id,
        });
        if (!res.skipped && res.decision) {
          ctx.decisions.set(decisionKey(d.screenKey.scope, d.screenKey.key), res.decision);
          d.stream = d.proposed;
          d.signals.push({ name: 'autoScreen', label: `Hedwig screened ${d.screenKey.key} into ${cap(d.proposed)}`, weight: d.confidence });
        } else d.stream = 'screener';
      } else {
        d.stream = 'screener';
      }
    }
  }
  // Screener rows keep their bundle so it applies once the sender is decided.
  if (d.stream === 'people' || d.stream === 'spam') d.bundle = null;
  // A scheduled bundle holds only mail that arrived since its last delivery slot; older mail would
  // already have been delivered.
  const bundle = d.bundle ? ctx.bundles.find((b) => b.key === d.bundle) : null;
  const slot = bundle && bundle.enabled !== false && isScheduled(bundle.schedule) ? lastSlot(bundle.schedule, ctx.now, validTimezone(cfg['insights.timezone'])) : null;
  d.held = Boolean(slot && ['reading', 'records'].includes(d.stream) && row.date && new Date(row.date) > slot);

  const prev = ctx.existing?.get(row.id);
  if (cfg['spam.autoMove'] && ['phishing', 'suspected'].includes(d.spam) && d.spamConfidence >= cfg['spam.autoMoveAbove']
      && !d.inSpamFolder && !d.own && d.final && d.stream === 'spam' && prev?.spam !== d.spam) {
    const id = await enqueue('sort.spamMove', { messageId: row.id, to: 'junk' }, { userId, dedupeKey: `sort.spamMove:${row.id}`, maxAttempts: 3 });
    if (id !== null) {
      await writeLog(userId, { messageId: row.id, action: 'spam_move', from: { folder: row.folder, accountId: row.account_id }, to: { folder: 'junk', spam: d.spam, confidence: d.spamConfidence }, by: 'auto' });
    }
  }

  if (d.stream !== 'spam') ensureNeedsYouReason(row, d);
  const stored = await upsertSort(userId, row, d, { pending });
  if (stored && !pending) {
    runHedwigHook(HEDWIG_HOOKS.afterSort, { userId, messageId: row.id, sort: toSortInfo(d) }).catch(() => {});
  }
  return stored;
}

async function markError(id, message) {
  await query(`UPDATE hedwig_msg SET error = LEFT(COALESCE(error || '; ', '') || $2, 1000) WHERE message_id = $1`, [id, message]).catch(() => {});
}

// ── Reflex queue ────────────────────────────────────────────────────────────

export async function enqueueReflex(userId, ids, cfg) {
  const size = Math.max(1, Math.min(8, cfg['sort.batchSize'] || 5));
  let n = 0;
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    await enqueue('sort.reflex', { messageIds: chunk }, { userId, dedupeKey: `sort.reflex:${fnv1a(chunk.join(','))}`, priority: 5, maxAttempts: 3 });
    n++;
  }
  return n;
}

/** The user replied: earlier messages in those threads no longer need them. */
async function clearNeedsYouAfterReply(userId, outgoing) {
  const ids = outgoing.map((r) => r.id);
  if (!ids.length) return 0;
  const { rowCount } = await query(
    `UPDATE hedwig_sort s SET needs_you = false, needs_you_reason = NULL,
            signals = s.signals || '[{"name":"replied","label":"You replied","weight":1}]'::jsonb
       FROM messages m, messages o
      WHERE o.id = ANY($2::uuid[]) AND m.id = s.message_id AND s.user_id = $1 AND s.needs_you AND s.layer <> 'user'
        AND m.account_id = o.account_id AND m.date < o.date
        AND ((o.thread_key IS NOT NULL AND m.thread_key = o.thread_key) OR (o.in_reply_to IS NOT NULL AND o.in_reply_to = m.message_id))`,
    [userId, ids],
  );
  return rowCount || 0;
}

async function withExtras(rows) {
  const missing = rows.filter((r) => !('spam_details' in r)).map((r) => r.id);
  if (!missing.length) return rows;
  const { rows: extra } = await query(`SELECT m.id, ${EXTRA_COLUMNS} FROM messages m WHERE m.id = ANY($1::uuid[])`, [missing]);
  const by = new Map(extra.map((e) => [e.id, e]));
  for (const r of rows) if (by.has(r.id)) Object.assign(r, { ...by.get(r.id), id: r.id });
  return rows;
}

// ── Entry points ────────────────────────────────────────────────────────────

/**
 * Seconds left to wait for a message's body before Reflex runs on the snippet, timed from when
 * Hedwig first saw the message (hedwig_msg.seen_at), not from its Date header: delayed mail and
 * the backfill get the same wait as fresh mail, so they are not sent to Reflex twice (once on the
 * snippet, again when the body lands). No hedwig_msg row means it is being seen right now.
 */
export function bodyWaitLeft(row, ctx) {
  const seen = ctx.seenAt?.get(row.id);
  const since = seen ? new Date(seen).getTime() : ctx.now.getTime();
  const waited = (ctx.now.getTime() - since) / 1000;
  return (ctx.cfg?.['sort.bodyWaitSec'] ?? 120) - waited;
}

/** Decided by the user's own rule or sender decision (or it is their own mail): no model needed. */
export function userAuthoritative(d) {
  return Boolean(d.own || (d.layer === 'rule' && (d.ruleId || d.senderDecision?.source === 'user' || d.signals?.some((x) => x.name?.startsWith('plugin:')))));
}

/** A newsletter the list headers settled (Tier 0): no model needed, and it replaces a model's guess. */
export function headerSettled(d) {
  return Boolean(d.listRule && d.layer === 'rule' && d.final);
}

/**
 * Sort decorated message rows (MESSAGE_COLUMNS, user_addresses, is_outgoing).
 * @param {object[]} rows
 * @param {{ historical?: boolean, allowReflex?: boolean, onlyLayers?: string[]|null }} [opts]
 */
export async function sortRows(rows, { historical = false, allowReflex = true, onlyLayers = null } = {}) {
  if (!rows.length) return { sorted: 0, reflex: 0 };
  await withExtras(rows);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  let sorted = 0;
  let reflexJobs = 0;
  for (const [userId, list] of byUser) {
    const cfg = await getConfig(userId);
    if (!cfg.enabled || !cfg['sort.enabled']) continue;
    const addresses = list[0].user_addresses || new Set();
    try {
      await ensureSeeded(userId, [...new Set(list.map((r) => r.account_id))], addresses);
    } catch (err) {
      console.warn(`[hedwig] sort: seeding sender decisions failed for ${userId}:`, err.message);
    }
    const outgoing = list.filter((r) => r.is_outgoing);
    if (outgoing.length && !historical) {
      await recordWrittenTo(userId, outgoing, addresses);
      await clearNeedsYouAfterReply(userId, outgoing);
    }
    // Mail in the server spam folder is judged by rescue on every path (new mail, bodies landing,
    // re-sorts), so a rescue is never overwritten by a verdict that ignores the rescue evidence.
    const spamRows = list.filter((r) => !r.is_outgoing && inSpamFolder(r));
    const mail = spamRows.length ? list.filter((r) => !spamRows.includes(r)) : list;
    if (spamRows.length) {
      try {
        const res = await rescueRows(userId, spamRows, cfg, { allowReflex: allowReflex && !historical, onlyLayers });
        sorted += res.checked;
      } catch (err) {
        console.warn(`[hedwig] sort: spam rescue failed for ${spamRows.length} message(s) of ${userId}:`, err.message);
      }
    }
    if (!mail.length) continue;
    const ctx = await loadUserContext(userId, mail, cfg);
    const llmOn = allowReflex && !historical && await llmAvailable(userId).catch(() => false);
    const toReflex = [];
    for (const row of mail) {
      const prev = ctx.existing.get(row.id);
      if (prev?.layer === 'user') continue;
      if (onlyLayers && prev && !onlyLayers.includes(prev.layer)) continue;
      try {
        const ageDays = row.date ? (ctx.now.getTime() - new Date(row.date).getTime()) / DAY : 0;
        const eligible = llmOn && ageDays <= cfg['sort.reflexMaxAgeDays'];
        const d = decideCheap(row, ctx);
        if (!historical && !d.own) await applyPluginVerdict(userId, row, d);
        // A model decision is only replaced by another model decision, or by the user's own rules
        // and sender decisions, which apply at once.
        if (prev && ['reflex', 'reasoning'].includes(prev.layer) && !userAuthoritative(d) && !headerSettled(d)) {
          if (eligible && !row.is_outgoing) {
            await query(`UPDATE hedwig_sort SET pending = 'reflex' WHERE message_id = $1 AND user_id = $2 AND layer <> 'user'`, [row.id, userId]);
            toReflex.push(row.id);
          }
          continue;
        }
        let pending = null;
        if (!d.final && !d.own && eligible) {
          const hasBody = Boolean(row.body_text || row.body_html);
          if (!hasBody && bodyWaitLeft(row, ctx) > 0) pending = 'body';
          else { pending = 'reflex'; toReflex.push(row.id); }
        }
        await finalize(userId, row, d, ctx, { pending });
        sorted++;
      } catch (err) {
        console.warn(`[hedwig] sort failed for message ${row.id}:`, err.message);
        await markError(row.id, `sort: ${err.message}`);
      }
    }
    if (toReflex.length) reflexJobs += await enqueueReflex(userId, toReflex, cfg);
    await bumpHits(userId, ctx.ruleHits);
  }
  return { sorted, reflex: reflexJobs };
}

/** Load rows by id for one user (MESSAGE_COLUMNS + extras, decorated). */
export async function loadRows(userId, ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, ${EXTRA_COLUMNS}
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.id = ANY($1::uuid[]) AND a.user_id = $2 AND NOT m.is_deleted`,
    [ids, userId],
  );
  return decorate(rows);
}

/** Re-sort messages (A calls this when bodies land; retrain and body sweeps use it too). */
export async function resortMessages(userId, messageIds, opts = {}) {
  const rows = await loadRows(userId, [...new Set(messageIds)].slice(0, 2000));
  return sortRows(rows, opts);
}

/** Pipeline step `sort`. */
export async function runSortStep(rows, ctx = {}) {
  return sortRows(rows, { historical: Boolean(ctx.historical) });
}

/** Job `sort.reflex` { messageIds }: Reflex over one batch, escalating the unsure. */
export async function runReflexJob({ messageIds }, job = {}) {
  const userId = job.user_id;
  if (!userId || !Array.isArray(messageIds) || !messageIds.length) return { skipped: 'bad payload' };
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['sort.enabled']) return { skipped: 'sorting off' };
  const all = (await loadRows(userId, messageIds)).filter((r) => !r.is_outgoing);
  if (!all.length) return { skipped: 'no messages' };
  const spamRows = all.filter((r) => inSpamFolder(r));
  if (spamRows.length) await rescueRows(userId, spamRows, cfg);
  const rows = all.filter((r) => !spamRows.includes(r));
  if (!rows.length) return { sorted: 0, rescueChecked: spamRows.length };
  const ctx = await loadUserContext(userId, rows, cfg);
  const todo = [];
  for (const row of rows) {
    const prev = ctx.existing.get(row.id);
    if (prev?.layer === 'user') continue;
    // Judged by a model since this job was queued (a duplicate job, a sweep): nothing left to do.
    if (prev && !prev.pending && ['reflex', 'reasoning'].includes(prev.layer)) continue;
    const d = decideCheap(row, ctx);
    // The user's own rules and decisions are final, and so are newsletters the list headers
    // settled; the model is not asked to second-guess them.
    if (userAuthoritative(d) || headerSettled(d)) {
      await finalize(userId, row, d, ctx, { pending: null });
      continue;
    }
    todo.push({ row, d, prev });
  }
  if (!todo.length) return { sorted: 0 };
  const items = [];
  for (const [index, { row, d }] of todo.entries()) {
    const parts = await messagePartsFor(row.id, row, { userId });
    items.push(reflexItem(row, parts, {
      index, userAddresses: ctx.userAddresses, sender: ctx.stats.get(d.keys.address || '') || null,
      decision: d.senderDecision && d.senderDecision.source !== 'import' ? d.senderDecision.decision : null,
      wroteTo: d.senderDecision?.source === 'import' || d.senderDecision?.reason === 'You wrote to them',
      signals: d.signals.filter((s) => !['senderDecision'].includes(s.name)), cfg,
    }));
  }
  const tz = validTimezone(cfg['insights.timezone']);
  const batch = {
    items, messageIds: todo.map((t) => t.row.id), user: ctx.user, bundles: ctx.bundles, rules: matchDescriptions(ctx.rules),
    corrections: await recentCorrections(userId, { limit: cfg['sort.correctionExamples'] }), now: describeNow(new Date(), tz),
  };
  let results;
  try {
    results = await runReflex(userId, batch, cfg);
  } catch (err) {
    // No model at all: the cheap decision is the answer, and nothing waits for Reflex.
    if (err?.code === 'llm_disabled') {
      for (const { row, d } of todo) await finalize(userId, row, d, ctx, { pending: null });
      return { skipped: err.code };
    }
    // Anything else (a full lane, the gateway down, the day's budget spent, a bad answer) leaves
    // every row pending = 'reflex': the ledger defers or retries this job, and the Reflex sweep
    // (sort.reflexSweep) re-enqueues what is still waiting if it fails for good.
    throw err;
  }
  let sorted = 0;
  let missing = 0;
  for (const { row, d, prev } of todo) {
    const r = results.get(row.id);
    if (!r) {
      // Still waiting for a model: keep it pending so the sweep asks again (a few times a day at
      // most). A model decision already stored stays until a new one replaces it.
      missing++;
      if (prev && ['reflex', 'reasoning'].includes(prev.layer)) continue;
      d.signals.push({ name: 'reflexMissing', label: 'The model gave no answer for this message yet', weight: 0 });
      await finalize(userId, row, d, ctx, { pending: 'reflex' });
      continue;
    }
    mergeReflex(d, r, { bundles: ctx.bundles, cfg });
    applyPostRules(d, row, ctx);
    await finalize(userId, row, d, ctx, { pending: null });
    sorted++;
  }
  await bumpHits(userId, ctx.ruleHits);
  const out = { sorted, escalated: [...results.values()].filter((r) => r.layer === 'reasoning').length };
  if (missing) return { ...out, missing, status: 'partial', note: `${missing} message(s) got no answer; they stay pending for the Reflex sweep` };
  return out;
}

const RESORT_BATCH = 200;

/**
 * Job `sort.resort` { messageIds?, sinceDays?, layers?, allowReflex?, engine?, cursor? }.
 * With `engine` (the stamp from version.js) it is the re-sort after an engine or sort.reflex
 * prompt change: every row not decided by the user and not stamped with that engine, newest
 * first (`sinceDays` null = all history), in pages that re-enqueue themselves. Reflex is asked
 * about mail within sort.reflexMaxAgeDays (sortRows gates by age); older mail gets the cheap layers.
 */
export async function runResortJob({ messageIds = null, sinceDays = 7, layers = ['classifier'], allowReflex = false, engine = null, cursor = null }, job = {}) {
  const userId = job.user_id;
  if (!userId) return { skipped: 'bad payload' };
  if (engine) return runEngineResort(userId, { engine, cursor, sinceDays });
  let ids = messageIds;
  if (!ids) {
    const { rows } = await query(
      `SELECT s.message_id FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
        WHERE s.user_id = $1 AND s.layer = ANY($2::text[]) AND m.date > NOW() - make_interval(days => $3) AND NOT s.own
        ORDER BY m.date DESC LIMIT 1000`,
      [userId, layers, Math.max(1, Math.min(365, Number(sinceDays) || 7))],
    );
    ids = rows.map((r) => r.message_id);
  }
  return resortMessages(userId, ids, { onlyLayers: layers, allowReflex: Boolean(allowReflex) });
}

async function runEngineResort(userId, { engine, cursor = null, sinceDays = null }) {
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['sort.enabled']) return { skipped: 'sorting off' };
  const days = sinceDays === null || sinceDays === undefined ? null : Math.max(1, Math.min(3650, Math.round(Number(sinceDays)) || 1));
  const { rows } = await query(
    `SELECT s.message_id, COALESCE(m.date, 'epoch'::timestamptz)::text AS d
       FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
      WHERE s.user_id = $1 AND s.layer <> 'user' AND NOT s.own AND NOT m.is_deleted
        AND s.engine_version IS DISTINCT FROM $2
        AND ($3::int IS NULL OR m.date > NOW() - make_interval(days => $3::int))
        AND ($4::timestamptz IS NULL OR (COALESCE(m.date, 'epoch'::timestamptz), s.message_id) < ($4::timestamptz, $5::uuid))
      ORDER BY COALESCE(m.date, 'epoch'::timestamptz) DESC, s.message_id DESC
      LIMIT $6`,
    [userId, engine, days, cursor?.date || null, cursor?.id || null, RESORT_BATCH],
  );
  const ids = rows.map((r) => r.message_id);
  const res = ids.length ? await resortMessages(userId, ids, { allowReflex: true }) : { sorted: 0, reflex: 0 };
  const key = `sort.engineVersion:${userId}`;
  const prev = (await getState(key, null)) || {};
  const totals = {
    checked: (cursor ? Number(prev.checked) || 0 : 0) + ids.length,
    reflexJobs: (cursor ? Number(prev.reflexJobs) || 0 : 0) + (res.reflex || 0),
  };
  if (ids.length === RESORT_BATCH) {
    const last = rows[rows.length - 1];
    const next = { date: last.d, id: last.message_id };
    await setState(key, { ...prev, version: engine, ...totals, cursor: next });
    await enqueue('sort.resort', { engine, allowReflex: true, sinceDays: days, cursor: next }, {
      userId, dedupeKey: `sort.resort:engine:${userId}:${engine}:${next.id}`, priority: 8, maxAttempts: 3,
    });
    return { checked: ids.length, sorted: res.sorted, reflex: res.reflex, continued: true };
  }
  await setState(key, { ...prev, version: engine, ...totals, cursor: null, doneAt: new Date().toISOString() });
  console.log(`[hedwig] sort.resort: ${totals.checked} decision(s) re-sorted for ${userId} under engine ${engine}; ${totals.reflexJobs} Reflex job(s) queued`);
  return { checked: ids.length, sorted: res.sorted, reflex: res.reflex, done: true };
}

/**
 * Worker start-up (and every 10 minutes, cheaply): when the engine stamp (version.js) differs
 * from the one in hedwig_state `sort.engineVersion`, enqueue one engine sort.resort per user.
 * This is how production re-sorts after a deploy that changes the sorting engine or sort.reflex.
 * @returns {Promise<{ version: string, enqueued: number }|null>} null when nothing changed
 */
export async function ensureSortEngineCurrent({ userIds = null } = {}) {
  const stamp = engineStamp();
  const current = await getState('sort.engineVersion', null);
  if (current?.version === stamp && !userIds) return resumeEngineResorts(stamp);
  const users = userIds || await sortUsers();
  let enqueued = 0;
  for (const userId of users) {
    const mine = await getState(`sort.engineVersion:${userId}`, null);
    if (mine?.version === stamp && !userIds) continue;
    const jobId = await enqueue('sort.resort', { engine: stamp, allowReflex: true, sinceDays: null }, {
      userId, dedupeKey: `sort.resort:engine:${userId}:${stamp}:start`, priority: 8, maxAttempts: 3,
    });
    await setState(`sort.engineVersion:${userId}`, { version: stamp, previous: mine?.version || null, enqueuedAt: new Date().toISOString(), jobId, checked: 0, reflexJobs: 0 });
    if (jobId !== null) enqueued++;
  }
  if (!userIds) {
    await setState('sort.engineVersion', { version: stamp, previous: current?.version || null, at: new Date().toISOString(), users: users.length, enqueued });
    console.log(`[hedwig] sort: engine ${current?.version || 'none'} → ${stamp}; re-sorting stored decisions for ${enqueued} user(s)`);
  }
  return { version: stamp, enqueued };
}

// A user's engine re-sort that stopped short (a page failed all its attempts, or its job was lost)
// is picked up again from its saved cursor by the 10-minute check, a few times per engine version:
// sort.resort has no rebuild(), so the hourly retry of failed jobs does not cover it, and until it
// finishes the classifier heads stay unused (learning.js waits for doneAt).
const RESORT_RESUMES = 5;
async function resumeEngineResorts(stamp) {
  let resumed = 0;
  for (const userId of await sortUsers()) {
    const key = `sort.engineVersion:${userId}`;
    const mine = await getState(key, null);
    if (!mine || mine.version !== stamp || mine.doneAt) continue;
    if ((Number(mine.resumes) || 0) >= RESORT_RESUMES) continue;
    const { rows } = await query(
      `SELECT 1 FROM hedwig_jobs WHERE kind = 'sort.resort' AND user_id = $1 AND done_at IS NULL AND failed_at IS NULL
          AND payload->>'engine' = $2 LIMIT 1`,
      [userId, stamp],
    );
    if (rows.length) continue; // still running or queued
    const resumes = (Number(mine.resumes) || 0) + 1;
    const cursor = mine.cursor || null;
    await enqueue('sort.resort', { engine: stamp, allowReflex: true, sinceDays: null, ...(cursor ? { cursor } : {}) }, {
      userId, dedupeKey: `sort.resort:engine:${userId}:${stamp}:resume:${resumes}`, priority: 8, maxAttempts: 3,
    });
    await setState(key, { ...mine, resumes });
    console.warn(`[hedwig] sort: engine re-sort for ${userId} stopped before the end; resuming (${resumes}/${RESORT_RESUMES})`);
    resumed++;
  }
  return resumed ? { version: stamp, enqueued: 0, resumed } : null;
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

/**
 * Every 30 s: bodies that landed and body waits that expired are re-sorted (which sends what
 * Tier 0 cannot settle to Reflex). A row waiting for Reflex (pending = 'reflex') keeps waiting
 * until a model decision replaces it or it is older than sort.reflexMaxAgeDays; the Reflex sweep
 * re-enqueues it when its job is gone.
 */
export async function pendingSweep() {
  const cfg = await getConfig();
  const started = (await query('SELECT NOW() AS now'))?.rows?.[0]?.now || new Date();
  const { rows } = await query(
    `SELECT s.user_id, s.message_id
       FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
      WHERE NOT s.own AND s.layer <> 'user' AND (
              (s.pending = 'body' AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL OR s.decided_at < NOW() - make_interval(secs => $1)))
           OR (s.pending IS NULL AND NOT s.body_seen AND s.layer IN ('classifier','reflex','reasoning')
               AND (m.body_text IS NOT NULL OR m.body_html IS NOT NULL) AND m.date > NOW() - INTERVAL '14 days'))
      LIMIT 500`,
    [cfg['sort.bodyWaitSec']],
  );
  const { rowCount: expired } = await query(
    `UPDATE hedwig_sort s SET pending = NULL FROM messages m
      WHERE m.id = s.message_id AND s.pending = 'reflex' AND (m.date IS NULL OR m.date < NOW() - make_interval(days => $1::int))`,
    [Math.round(cfg['sort.reflexMaxAgeDays'] ?? 14)],
  );
  if (expired) console.warn(`[hedwig] sort: ${expired} message(s) passed sort.reflexMaxAgeDays while waiting for Reflex; keeping their cheap decision`);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r.message_id);
  }
  let n = 0;
  for (const [userId, ids] of byUser) {
    let res;
    try {
      res = await resortMessages(userId, ids, {});
    } finally {
      // What the re-sort did not rewrite (a model decision kept until Reflex answers again, or a
      // row that failed) counts as body-seen so it is not picked up every 30 s. A Reflex wait stays.
      await query(
        `UPDATE hedwig_sort s SET body_seen = (m.body_text IS NOT NULL OR m.body_html IS NOT NULL),
                pending = CASE WHEN s.pending = 'body' THEN NULL ELSE s.pending END
           FROM messages m WHERE m.id = s.message_id AND s.user_id = $1 AND s.message_id = ANY($2::uuid[]) AND s.decided_at < $3`,
        [userId, ids, started],
      );
    }
    n += res.sorted;
  }
  return n;
}

/** Jobs of kind sort.reflex that carry this row's message id (SQL fragment; $1 = user id). */
const REFLEX_JOBS_FOR_ROW = `FROM hedwig_jobs j WHERE j.kind = 'sort.reflex' AND j.user_id = $1 AND j.payload->'messageIds' ? s.message_id::text`;

/**
 * sort.reflex payloads for the rows still waiting for Reflex (pending = 'reflex', not the user's,
 * within sort.reflexMaxAgeDays) that no live job covers. A failed job's batch is kept together (less
 * what no longer waits), so the ledger's reconcile/retryFailed recognise it; the rest are batched
 * newest first. `tryCap` leaves out messages already in that many jobs today.
 * @returns {Promise<Array<{ messageIds: string[] }>>}
 */
export async function reflexPayloads(userId, cfg, { tryCap = null, limit = 500 } = {}) {
  const size = Math.max(1, Math.min(8, cfg['sort.batchSize'] || 5));
  const { rows } = await query(
    `SELECT s.message_id,
            (SELECT COUNT(*) ${REFLEX_JOBS_FOR_ROW} AND j.created_at > NOW() - INTERVAL '1 day')::int AS tries
       FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
      WHERE s.user_id = $1 AND s.pending = 'reflex' AND s.layer <> 'user' AND NOT s.own AND NOT m.is_deleted
        AND m.date > NOW() - make_interval(days => $2::int)
        AND NOT EXISTS (SELECT 1 ${REFLEX_JOBS_FOR_ROW} AND j.done_at IS NULL AND j.failed_at IS NULL)
      ORDER BY m.date DESC, s.message_id
      LIMIT $3`,
    [userId, Math.round(cfg['sort.reflexMaxAgeDays'] ?? 14), limit],
  );
  const waiting = rows.filter((r) => tryCap === null || Number(r.tries) < tryCap).map((r) => r.message_id);
  if (!waiting.length) return [];
  const need = new Set(waiting);
  const out = [];
  const used = new Set();
  const { rows: failed } = await query(
    `SELECT payload FROM hedwig_jobs WHERE kind = 'sort.reflex' AND user_id = $1 AND status = 'failed' ORDER BY id`,
    [userId],
  );
  for (const f of failed) {
    const p = typeof f.payload === 'string' ? JSON.parse(f.payload) : f.payload;
    const ids = Array.isArray(p?.messageIds) ? p.messageIds.filter((id) => need.has(id) && !used.has(id)) : [];
    if (!ids.length) continue;
    out.push({ messageIds: ids });
    for (const id of ids) used.add(id);
  }
  const rest = waiting.filter((id) => !used.has(id));
  for (let i = 0; i < rest.length; i += size) out.push({ messageIds: rest.slice(i, i + size) });
  return out;
}

/**
 * Every 2 minutes: Tier 1 coverage, rebuilt from the data. For each user with a model:
 *  1. recent classifier (or automatic sender-decision) decisions below sort.classifierDecideAbove
 *     that no model has judged and nothing waits on (sorted while the model was off, by a sweep without Reflex, or a lost
 *     pending flag) are re-sorted with Reflex allowed, which marks and enqueues them;
 *  2. rows waiting for Reflex with no live job (the job failed for good, or was never queued)
 *     are enqueued again, at most sort.reflexTriesPerDay jobs per message a day.
 * @returns {Promise<{ users: number, adopted: number, enqueued: number }>}
 */
export async function reflexSweep({ userIds = null } = {}) {
  const users = userIds || await sortUsers();
  const out = { users: 0, adopted: 0, enqueued: 0 };
  for (const userId of users) {
    try {
      const cfg = await getConfig(userId);
      if (!cfg.enabled || !cfg['sort.enabled']) continue;
      if (!await llmAvailable(userId).catch(() => false)) continue;
      out.users++;
      const tryCap = Math.max(1, Math.round(cfg['sort.reflexTriesPerDay'] ?? 3));
      const { rows } = await query(
        `SELECT s.message_id FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
          WHERE s.user_id = $1 AND s.pending IS NULL AND s.layer IN ('classifier','rule') AND COALESCE(s.confidence, 0) < $3
            AND s.stream <> 'spam' AND NOT s.in_spam_folder AND NOT s.own AND NOT m.is_deleted
            AND m.date > NOW() - make_interval(days => $2::int)
            AND (SELECT COUNT(*) ${REFLEX_JOBS_FOR_ROW} AND j.created_at > NOW() - INTERVAL '1 day') < $4
          ORDER BY m.date DESC LIMIT 200`,
        [userId, Math.round(cfg['sort.reflexMaxAgeDays'] ?? 14), cfg['sort.classifierDecideAbove'], tryCap],
      );
      if (rows.length) {
        const res = await resortMessages(userId, rows.map((r) => r.message_id), { allowReflex: true });
        out.adopted += rows.length;
        out.enqueued += res.reflex || 0;
      }
      for (const payload of await reflexPayloads(userId, cfg, { tryCap })) {
        const id = await enqueue('sort.reflex', payload, {
          userId, dedupeKey: `sort.reflex:${fnv1a(payload.messageIds.join(','))}`, priority: 5, maxAttempts: 3,
        });
        if (id !== null) out.enqueued++;
      }
    } catch (err) {
      console.warn(`[hedwig] sort.reflexSweep failed for ${userId}:`, err.message);
    }
  }
  if (out.adopted || out.enqueued) console.log(`[hedwig] sort.reflexSweep: ${out.adopted} unsure decision(s) re-sorted, ${out.enqueued} Reflex job(s) queued for ${out.users} user(s)`);
  return out;
}

/** Every minute: history the pipeline indexed before sorting existed (cheap layers; Reflex for recent mail). */
export async function backfillSweep() {
  const cfg = await getConfig();
  const limit = cfg['sort.backfillBatch'];
  if (!limit) return 0;
  const { rows } = await query(
    `SELECT h.message_id, h.user_id FROM hedwig_msg h
       LEFT JOIN hedwig_sort s ON s.message_id = h.message_id
       JOIN messages m ON m.id = h.message_id
      WHERE s.message_id IS NULL AND h.skip_reason IS NULL AND NOT m.is_deleted
      ORDER BY m.date DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r.message_id);
  }
  let n = 0;
  for (const [userId, ids] of byUser) n += (await resortMessages(userId, ids, {})).sorted;
  return n;
}

// ── Spam rescue ─────────────────────────────────────────────────────────────

const SPAM_FOLDER_SQL = `(f.special_use = '\\Junk' OR m.folder ~* '(^|/)(spam|junk|junk e-?mail|bulk mail)$')`;

async function orderDomains(userId) {
  const { rows } = await query(
    `SELECT DISTINCT split_part(lower(m.from_email), '@', 2) AS domain FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
      WHERE s.user_id = $1 AND s.bundle IN ('purchases','deliveries','travel') AND NOT s.in_spam_folder LIMIT 300`,
    [userId],
  );
  return rows.map((r) => r.domain).filter(Boolean);
}

/**
 * What the user's own mail says about the senders of spam-folder messages: how often they wrote to
 * each address (To/Cc of their sent mail) and how often they marked that sender's mail not spam
 * (a spam override, a correction, or a behaviour/judge rescue label).
 * @returns {Promise<Map<string, { wroteTo: number, notSpam: number }>>}
 */
export async function rescueEvidence(userId, emails, addresses) {
  const list = [...new Set(emails.filter(Boolean).map((e) => String(e).toLowerCase()))];
  const out = new Map(list.map((e) => [e, { wroteTo: 0, notSpam: 0 }]));
  if (!list.length) return out;
  const [sent, notSpam] = await Promise.all([
    query(
      `SELECT lower(COALESCE(r->>'address', r->>'email', r #>> '{}')) AS email, COUNT(DISTINCT m.id)::int AS n
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(m.to_addresses) = 'array' THEN m.to_addresses ELSE '[]'::jsonb END
           || CASE WHEN jsonb_typeof(m.cc_addresses) = 'array' THEN m.cc_addresses ELSE '[]'::jsonb END) AS r
        WHERE a.user_id = $1 AND NOT m.is_deleted AND ${outgoingSql('m', 'f', '$2')}
          AND lower(COALESCE(r->>'address', r->>'email', r #>> '{}')) = ANY($3::text[])
        GROUP BY 1`,
      [userId, [...addresses], list],
    ).catch((err) => { console.warn(`[hedwig] sort: rescue sent-mail lookup failed for ${userId}:`, err.message); return { rows: [] }; }),
    query(
      `SELECT lower(m.from_email) AS email, COUNT(*)::int AS n
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
         LEFT JOIN hedwig_sort s ON s.message_id = m.id AND s.user_id = a.user_id
        WHERE a.user_id = $1 AND lower(m.from_email) = ANY($2::text[])
          AND (m.spam_user_override = 'ham'
               OR (s.layer = 'user' AND s.spam IN ('clean','rescued') AND s.in_spam_folder)
               OR EXISTS (SELECT 1 FROM hedwig_labels l WHERE l.user_id = a.user_id AND l.target_id = m.id::text
                           AND ((l.suite = 'rescue' AND l.label->>'rescue' = 'true') OR (l.suite = 'spam' AND l.label->>'spam' = 'false'))))
        GROUP BY 1`,
      [userId, list],
    ).catch((err) => { console.warn(`[hedwig] sort: rescue not-spam lookup failed for ${userId}:`, err.message); return { rows: [] }; }),
  ]);
  for (const r of sent?.rows || []) if (out.has(r.email)) out.get(r.email).wroteTo = Number(r.n) || 0;
  for (const r of notSpam?.rows || []) if (out.has(r.email)) out.get(r.email).notSpam = Number(r.n) || 0;
  return out;
}

/** spam.reflex over rescue candidates. `failed` says a call failed and some went unjudged. */
async function spamReflex(userId, prepared, cfg, user) {
  const out = new Map();
  let failed = false;
  const size = Math.max(1, Math.min(8, cfg['sort.batchSize'] || 5));
  for (let i = 0; i < prepared.length; i += size) {
    const chunk = prepared.slice(i, i + size);
    const items = chunk.map(({ row, d }, j) => ({
      id: `m${j + 1}`,
      from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
      replyTo: addressesOf(row.reply_to).map((a) => a.email).join(', ') || null,
      subject: row.subject,
      history: `${Number(d.sender?.received || 0)} received, you replied to ${Number(d.sender?.replied || 0)}`,
      signals: [...d.signals.filter((s) => s.name !== 'rescue').map((s) => s.label), ...d.rescue.reasons].slice(0, 10),
      text: String(d.text || '').slice(0, cfg['sort.newTextChars']),
    }));
    const run = async (subset, escalate) => {
      const { data, provenance } = await runSortPrompt('spam.reflex', { user, items: subset }, { userId, lane: 'background', escalate });
      for (const e of data?.items || []) {
        const idx = Number(String(e.id).replace(/^m/, '')) - 1;
        const target = chunk[idx];
        if (!target || !subset.some((s) => s.id === e.id)) continue;
        let conf = Number(e.confidence);
        if (conf > 1 && conf <= 100) conf /= 100;
        const served = provenance?.servedTier || provenance?.tier || (escalate ? 'reasoning' : 'reflex');
        out.set(target.row.id, { verdict: e.verdict, confidence: Math.max(0, Math.min(1, conf || 0)), reason: cleanReason(e.reason), layer: served === 'reasoning' ? 'reasoning' : 'reflex', provenance });
      }
    };
    try {
      await run(items, false);
      const unsure = items.filter((it, j) => {
        const r = out.get(chunk[j].row.id);
        return r && r.verdict === 'phishing' && r.confidence < cfg['spam.phishingEscalateBelow'];
      });
      // Not while Tier 2 is degraded: the fallback is the model that just answered.
      if (unsure.length && await sortEscalationUseful(userId)) await run(unsure, true);
    } catch (err) {
      if (!SOFT_ERRORS.has(err?.code)) console.warn(`[hedwig] sort: spam.reflex failed for ${userId}:`, err.message);
      failed = true;
      break;
    }
  }
  return { verdicts: out, failed };
}

/**
 * A spam-folder message worth a Reflex read: some sign the user knows the sender or that it is
 * personal (rescue score at least spam.rescueAbove - 0.45, the least a confident "legit" can lift
 * over the line), not phishing, not rescued already on its own, and recent (spam.suspectedDays).
 * The server folder alone never keeps it from the model; the model alone never rescues mail with
 * no evidence (see the score blend in rescueRows).
 */
export function rescueReflexCandidate(row, d, cfg, now = new Date()) {
  const above = cfg['spam.rescueAbove'];
  const score = d.rescue?.score ?? 0;
  if (d.spam === 'phishing' || score >= above || score < Math.max(0.2, above - 0.45)) return false;
  const days = cfg['spam.suspectedDays'] ?? 30;
  return !row.date || now.getTime() - new Date(row.date).getTime() <= days * DAY;
}

/**
 * Rescue: run the layers over mail in the server spam folder and mark legitimate-looking mail
 * `rescued` at spam.rescueAbove. Nothing is moved; the Screener shows rescued mail from undecided
 * senders with inSpam, and decided senders' mail goes to their stream. Every row gets a `rescue`
 * signal (score, reasons, signals version) so the sweep knows it has been judged.
 * @param {{ allowReflex?: boolean, onlyLayers?: string[]|null }} [opts]
 */
export async function rescueRows(userId, rows, cfg, { allowReflex = true, onlyLayers = null } = {}) {
  if (!rows.length) return { rescued: 0, checked: 0 };
  await withExtras(rows);
  const ctx = await loadUserContext(userId, rows, cfg);
  const [orders, evidence] = await Promise.all([
    orderDomains(userId),
    rescueEvidence(userId, rows.map((r) => r.from_email), ctx.userAddresses),
  ]);
  const prepared = [];
  for (const row of rows) {
    const prev = ctx.existing.get(row.id);
    if (prev?.layer === 'user') continue;
    if (onlyLayers && prev && !onlyLayers.includes(prev.layer)) continue;
    const d = decideCheap(row, ctx);
    d.sender = ctx.stats.get(d.keys.address || '') || null;
    const decision = d.senderDecision;
    const ev = evidence.get(String(row.from_email || '').toLowerCase()) || { wroteTo: 0, notSpam: 0 };
    const source = decision?.source || null;
    d.rescue = rescueScore({
      row, sender: d.sender, decision: decision?.decision || null, decisionSource: source,
      wroteTo: ev.wroteTo > 0 || (source !== 'user' && /wr(ote|itten) to them/i.test(decision?.reason || '')),
      contact: source === 'import' && /contacts/i.test(decision?.reason || ''),
      replyToOwn: Boolean(ctx.threads?.get(row.id)?.replyToOwn), markedNotSpam: ev.notSpam > 0,
      auth: d.header.auth, s1: d.s1, orderDomains: orders, phishingScore: d.phishingScore, text: d.text,
    });
    prepared.push({ row, d, prev });
  }
  const above = cfg['spam.rescueAbove'];
  const llmOn = allowReflex && await llmAvailable(userId).catch(() => false);
  const candidates = prepared.filter(({ row, d }) => rescueReflexCandidate(row, d, cfg, ctx.now));
  const { verdicts } = llmOn && candidates.length ? await spamReflex(userId, candidates, cfg, ctx.user) : { verdicts: new Map() };
  const candidateIds = new Set(candidates.map(({ row }) => row.id));
  let rescued = 0;
  for (const { row, d, prev } of prepared) {
    const v = verdicts.get(row.id);
    if (v) {
      if (v.verdict === 'legit') { d.rescue.score = round(Math.max(d.rescue.score, 0.5 * d.rescue.score + 0.5 * v.confidence + 0.1)); d.rescue.reasons.push(v.reason); }
      else { d.rescue.score = Math.min(d.rescue.score, 0.2); if (v.verdict === 'phishing') { d.spam = 'phishing'; d.spamReason = v.reason; d.spamConfidence = v.confidence; } }
      d.prompt = v.provenance;
      d.layer = v.layer;
      d.signals.push({ name: `spam.${v.layer}`, label: `${v.layer === 'reasoning' ? 'Reasoning model' : 'Reflex'}: ${v.reason}`, weight: v.confidence });
    }
    const userDecided = d.layer === 'rule' && (d.ruleId || d.senderDecision?.source === 'user');
    // First, so upsertSort's cap on stored signals never drops it.
    // reflex: which model judged it, or 'pending' when it is a candidate no model has read yet
    // (no model, a full lane, history sorted without models); the rescue sweep picks those up.
    d.signals.unshift({
      name: 'rescue', v: SPAM_SIGNALS_VERSION, weight: d.rescue.score,
      ...(v ? { reflex: v.layer } : candidateIds.has(row.id) ? { reflex: 'pending' } : {}),
      label: d.rescue.reasons.length ? `Rescue ${d.rescue.score}: ${d.rescue.reasons.slice(0, 3).join('; ')}` : `Rescue ${d.rescue.score}: no sign you know this sender`,
    });
    if (d.rescue.score >= above && d.spam !== 'phishing') {
      d.spam = 'rescued';
      d.spamReason = d.rescue.reasons.slice(0, 2).join('; ');
      d.spamConfidence = d.rescue.score;
      d.stream = d.senderDecision && d.senderDecision.decision !== 'block' ? streamOf(d.senderDecision.decision) : (d.proposed || 'people');
      if (!['reading', 'records'].includes(d.stream)) d.bundle = null;
      d.reason = cleanReason(`Rescued from spam: ${d.rescue.reasons[0] || 'looks legitimate'}`);
      d.confidence = d.rescue.score;
      d.needsScreen = !d.senderDecision && Boolean(d.screenKey);
      rescued++;
    } else if (!userDecided) {
      d.stream = 'spam';
      d.bundle = null;
      d.needsYou = false;
      d.needsScreen = false;
      if (d.spam === 'clean') { d.spam = 'suspected'; d.spamReason = 'Your provider filed this as spam'; d.spamConfidence = 0.55; }
    }
    d.final = true;
    const stored = await finalize(userId, row, d, ctx, { pending: null });
    if (stored && d.spam === 'rescued' && prev?.spam !== 'rescued') {
      await writeLog(userId, {
        messageId: row.id, action: 'rescue', from: { spam: prev?.spam || 'suspected', stream: 'spam' },
        to: { spam: 'rescued', stream: stored.stream, score: d.rescue.score, reasons: d.rescue.reasons.slice(0, 4) }, by: 'auto',
      });
    }
  }
  return { rescued, checked: prepared.length };
}

async function sortUsers() {
  const { rows } = await query('SELECT DISTINCT user_id FROM email_accounts WHERE enabled = true');
  return rows.map((r) => r.user_id);
}

/**
 * Spam-folder messages to judge for one user: never sorted, sorted before the rescue signal (or
 * under an older signals version), or whose sender has new evidence since (a reply, a decision).
 * `all` re-judges everything in the window (the on-demand run). `withPending` adds candidates no
 * model has read yet (rescue signal reflex: 'pending'), when a model is available.
 */
async function rescueCandidates(userId, cfg, { limit = 100, all = false, withPending = false } = {}) {
  const { rows } = await query(
    `SELECT ${MESSAGE_COLUMNS}, ${EXTRA_COLUMNS}
       FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
       LEFT JOIN hedwig_sort s ON s.message_id = m.id
      WHERE a.user_id = $1 AND NOT m.is_deleted AND ${SPAM_FOLDER_SQL}
        AND (m.date IS NULL OR m.date > NOW() - make_interval(days => $2))
        AND (s.message_id IS NULL OR (s.layer <> 'user' AND (
              $4::boolean
           OR NOT (COALESCE(s.signals, '[]'::jsonb) @> $5::jsonb)
           OR ($6::boolean AND COALESCE(s.signals, '[]'::jsonb) @> '[{"name":"rescue","reflex":"pending"}]'::jsonb)
           OR (s.spam <> 'rescued' AND (
                EXISTS (SELECT 1 FROM hedwig_sender_stats st WHERE st.user_id = $1 AND st.sender_email = lower(m.from_email) AND st.last_replied > s.decided_at)
             OR EXISTS (SELECT 1 FROM hedwig_senders hs WHERE hs.user_id = $1 AND hs.undone_at IS NULL AND hs.decision <> 'block'
                          AND hs.scope = 'address' AND hs.key = lower(m.from_email) AND hs.decided_at > s.decided_at))))))
      ORDER BY (s.message_id IS NULL) DESC, m.date DESC NULLS LAST
      LIMIT $3`,
    [userId, cfg['spam.suspectedDays'], limit, Boolean(all), JSON.stringify([{ name: 'rescue', v: SPAM_SIGNALS_VERSION }]), Boolean(withPending)],
  );
  return decorate(rows);
}

/**
 * Check each user's spam folder (every 10 minutes, and on demand). Records its last run in
 * hedwig_state `schedule.sort.rescue` and logs one line per run.
 * @returns {Promise<{ users: number, scanned: number, rescued: number, errors: number }>}
 */
export async function rescueSweep({ userIds = null, limit = 100, all = false, record = true } = {}) {
  const started = Date.now();
  const users = userIds || await sortUsers();
  const out = { users: 0, scanned: 0, rescued: 0, errors: 0 };
  for (const userId of users) {
    const cfg = await getConfig(userId);
    if (!cfg.enabled || !cfg['sort.enabled']) continue;
    out.users++;
    try {
      const withPending = await llmAvailable(userId).catch(() => false);
      const rows = await rescueCandidates(userId, cfg, { limit, all, withPending });
      const res = await rescueRows(userId, rows, cfg);
      out.scanned += res.checked;
      out.rescued += res.rescued;
    } catch (err) {
      out.errors++;
      console.warn(`[hedwig] sort: spam rescue failed for ${userId}:`, err.message);
    }
  }
  console.log(`[hedwig] sort.rescue: ${out.scanned} spam-folder message(s) checked for ${out.users} user(s), ${out.rescued} rescued${out.errors ? `, ${out.errors} failed` : ''} (${Date.now() - started} ms)`);
  if (record) {
    await setState('schedule.sort.rescue', { at: new Date(started).toISOString(), ...out, all: Boolean(all), signalsVersion: SPAM_SIGNALS_VERSION, ms: Date.now() - started })
      .catch((err) => console.warn('[hedwig] sort.rescue: could not record its state:', err.message));
  }
  return out;
}

/** Job `sort.rescue` { all? }: one user's spam folder now (POST /sort/rescue/run, admin). */
export async function runRescueJob({ all = true, limit = 1000 } = {}, job = {}) {
  const userId = job.user_id;
  if (!userId) return { skipped: 'bad payload' };
  const res = await rescueSweep({ userIds: [userId], all: Boolean(all), limit: Math.max(1, Math.min(5000, Number(limit) || 1000)), record: false });
  await setState(`sort.rescue.lastRun:${userId}`, { at: new Date().toISOString(), ...res, manual: true }).catch(() => {});
  return res;
}

// ── Re-judging stored spam verdicts when the signals change ─────────────────

const REEVALUATE_BATCH = 200;

/**
 * Job `sort.reevaluateSpam` { cursor? }: recompute every stored verdict the spam signals decide —
 * rows in the server spam folder (rescue) and rows marked phishing — for one user, in batches that
 * re-enqueue themselves. Rows the user corrected are left alone.
 */
export async function runReevaluateSpamJob({ cursor = null, version = SPAM_SIGNALS_VERSION } = {}, job = {}) {
  const userId = job.user_id;
  if (!userId) return { skipped: 'bad payload' };
  const cfg = await getConfig(userId);
  if (!cfg.enabled || !cfg['sort.enabled']) return { skipped: 'sorting off' };
  const { rows } = await query(
    `SELECT s.message_id FROM hedwig_sort s JOIN messages m ON m.id = s.message_id
      WHERE s.user_id = $1 AND s.layer <> 'user' AND NOT s.own AND NOT m.is_deleted
        AND (s.in_spam_folder OR s.spam = 'phishing')
        AND ($2::uuid IS NULL OR s.message_id > $2::uuid)
      ORDER BY s.message_id
      LIMIT $3`,
    [userId, cursor, REEVALUATE_BATCH],
  );
  const ids = rows.map((r) => r.message_id);
  const before = ids.length
    ? new Map((await query('SELECT message_id, spam FROM hedwig_sort WHERE user_id = $1 AND message_id = ANY($2::uuid[])', [userId, ids])).rows.map((r) => [r.message_id, r.spam]))
    : new Map();
  const res = ids.length ? await resortMessages(userId, ids, {}) : { sorted: 0 };
  const after = ids.length
    ? (await query('SELECT message_id, spam FROM hedwig_sort WHERE user_id = $1 AND message_id = ANY($2::uuid[])', [userId, ids])).rows
    : [];
  const changed = {};
  for (const r of after) {
    const was = before.get(r.message_id);
    if (was && was !== r.spam) changed[`${was}→${r.spam}`] = (changed[`${was}→${r.spam}`] || 0) + 1;
  }
  const key = `spam.signalsVersion:${userId}`;
  const prevState = (await getState(key, null)) || {};
  const totals = { checked: (cursor ? Number(prevState.checked) || 0 : 0) + ids.length, changed: mergeCounts(cursor ? prevState.changed : null, changed) };
  if (ids.length === REEVALUATE_BATCH) {
    const next = ids[ids.length - 1];
    await setState(key, { ...prevState, version, ...totals, cursor: next });
    await enqueue('sort.reevaluateSpam', { cursor: next, version }, { userId, dedupeKey: `sort.reevaluateSpam:${userId}:${version}:${next}`, priority: 7, maxAttempts: 3 });
    return { checked: ids.length, sorted: res.sorted, changed, continued: true };
  }
  await setState(key, { ...prevState, version, ...totals, cursor: null, doneAt: new Date().toISOString() });
  console.log(`[hedwig] sort.reevaluateSpam: ${totals.checked} stored spam verdict(s) re-judged for ${userId} under signals ${version}; changed ${JSON.stringify(totals.changed)}`);
  return { checked: ids.length, sorted: res.sorted, changed, done: true };
}

function mergeCounts(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/**
 * Worker start-up (and every 10 minutes, cheaply): when SPAM_SIGNALS_VERSION differs from the one
 * stored in hedwig_state `spam.signalsVersion`, enqueue sort.reevaluateSpam once per user.
 * @returns {Promise<{ version: string, enqueued: number }|null>} null when nothing changed
 */
export async function ensureSpamSignalsCurrent({ userIds = null } = {}) {
  const current = await getState('spam.signalsVersion', null);
  if (current?.version === SPAM_SIGNALS_VERSION && !userIds) return null;
  const users = userIds || await sortUsers();
  let enqueued = 0;
  for (const userId of users) {
    const mine = await getState(`spam.signalsVersion:${userId}`, null);
    if (mine?.version === SPAM_SIGNALS_VERSION && !userIds) continue;
    const jobId = await enqueue('sort.reevaluateSpam', { version: SPAM_SIGNALS_VERSION }, {
      userId, dedupeKey: `sort.reevaluateSpam:${userId}:${SPAM_SIGNALS_VERSION}:start`, priority: 7, maxAttempts: 3,
    });
    await setState(`spam.signalsVersion:${userId}`, { version: SPAM_SIGNALS_VERSION, enqueuedAt: new Date().toISOString(), jobId, checked: 0, changed: {} });
    if (jobId !== null) enqueued++;
  }
  if (!userIds) {
    await setState('spam.signalsVersion', { version: SPAM_SIGNALS_VERSION, previous: current?.version || null, at: new Date().toISOString(), users: users.length, enqueued });
    console.log(`[hedwig] sort: spam signals ${current?.version || 'none'} → ${SPAM_SIGNALS_VERSION}; re-judging stored spam verdicts for ${enqueued} user(s)`);
  }
  return { version: SPAM_SIGNALS_VERSION, enqueued };
}

export { sortUsers };
