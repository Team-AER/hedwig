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
import { messageText, addressesOf } from '../text.js';
import { MESSAGE_COLUMNS, decorate } from '../pipeline.js';
import { HEDWIG_HOOKS, collectHedwigHook, runHedwigHook } from '../hooks.js';
import { stage1 } from '../triage/signals.js';
import { loadSenderStats, outgoingSql } from '../triage/store.js';
import { fnv1a } from '../triage/features.js';
import { validTimezone, describeNow } from '../insights/time.js';
import { headerLayer, screenerKey } from './headers.js';
import { assessSpam, rescueScore } from './spam.js';
import { applyRules, loadRules, bumpHits, matchDescriptions } from './rules.js';
import { sortFeatures, priorStream, headsActive, predictHeads, loadHeads } from './classifier.js';
import { loadBundles, guessBundle, isScheduled, lastSlot } from './bundles.js';
import { loadDecisions, pickDecision, setSenderDecision, ensureSeeded, recordWrittenTo, streamOf, decisionKey } from './senders.js';
import { reflexItem, runReflex, cleanReason } from './reflex.js';
import { messagePartsFor, recentCorrections, runSortPrompt } from './deps.js';
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
async function knownDomains(userId) {
  const c = knownCache.get(userId);
  if (c && Date.now() - c.at < 10 * 60_000) return c.domains;
  const { rows } = await query(
    `SELECT DISTINCT domain FROM hedwig_sender_stats WHERE user_id = $1 AND domain IS NOT NULL AND (replied > 0 OR received >= 3) LIMIT 500`,
    [userId],
  );
  const domains = rows.map((r) => r.domain);
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
    knownDomains(userId),
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
  const spam = assessSpam(row, { text, sender, auth: header.auth, knownDomains: ctx.knownDomains || [], spamFolder: header.spamFolder, trustedSender });

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
    ruleMatches: [], prompt: null,
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
    cls = { stream: h.stream, confidence: h.confidence, reason: h.stream === prior.stream ? prior.reason : `Mail like this usually goes to ${cap(h.stream)}`, bundle: prior.bundle || null, signals: h.signals, spamP: h.spam };
  } else {
    cls = priorStream({ s1, sender, header });
  }
  if (!d.stream) {
    decideWith(cls.stream, { layer: 'classifier', confidence: cls.confidence, reason: cleanReason(cls.reason), final: cls.confidence >= cfg['sort.classifierDecideAbove'] });
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
  if (d.stream === 'spam') d.needsYou = false;

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
    d.layer = r.layer;
    d.confidence = r.confidence;
    d.reason = r.reason || d.reason;
    d.stream = r.stream;
    d.proposed = r.stream;
    d.bundle = ['reading', 'records'].includes(r.stream) ? (r.bundle || guessBundle({ row: d.rowLite || {}, text: d.text, stream: r.stream }, bundles) || null) : null;
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
  if (d.stream === 'spam') d.needsYou = false;
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

function toSortInfo(d) {
  return { stream: d.stream, bundle: d.bundle, needsYou: d.needsYou, spam: d.spam, layer: d.layer, reason: d.reason, confidence: d.confidence };
}

async function upsertSort(userId, row, d, { pending = null } = {}) {
  const p = d.prompt || {};
  const { rows } = await query(
    `INSERT INTO hedwig_sort (message_id, user_id, account_id, stream, proposed_stream, bundle, held, needs_you, needs_you_reason,
                              spam, spam_reason, confidence, layer, reason, signals, features, labels, notify, rule_id, rule_matches,
                              sender_key, sender_scope, own, in_spam_folder, pending, prompt_id, prompt_version, model, ai_call_id,
                              decided_at, body_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,NOW(),$30)
     ON CONFLICT (message_id) DO UPDATE SET
       stream = EXCLUDED.stream, proposed_stream = EXCLUDED.proposed_stream, bundle = EXCLUDED.bundle, held = EXCLUDED.held,
       needs_you = EXCLUDED.needs_you, needs_you_reason = EXCLUDED.needs_you_reason, spam = EXCLUDED.spam, spam_reason = EXCLUDED.spam_reason,
       confidence = EXCLUDED.confidence, layer = EXCLUDED.layer, reason = EXCLUDED.reason, signals = EXCLUDED.signals,
       features = EXCLUDED.features, labels = EXCLUDED.labels, notify = EXCLUDED.notify, rule_id = EXCLUDED.rule_id,
       rule_matches = EXCLUDED.rule_matches, sender_key = EXCLUDED.sender_key, sender_scope = EXCLUDED.sender_scope,
       own = EXCLUDED.own, in_spam_folder = EXCLUDED.in_spam_folder, pending = EXCLUDED.pending,
       prompt_id = EXCLUDED.prompt_id, prompt_version = EXCLUDED.prompt_version, model = EXCLUDED.model, ai_call_id = EXCLUDED.ai_call_id,
       decided_at = NOW(), body_seen = EXCLUDED.body_seen
     WHERE hedwig_sort.user_id = EXCLUDED.user_id AND hedwig_sort.layer <> 'user'
     RETURNING *`,
    [row.id, userId, row.account_id, d.stream, d.proposed && d.proposed !== 'spam' ? d.proposed : null, d.bundle, Boolean(d.held),
      Boolean(d.needsYou), d.needsYouReason, d.spam, d.spamReason ? cleanReason(d.spamReason, 140) : null, d.confidence, d.layer,
      d.reason, JSON.stringify(d.signals.slice(0, 16)), JSON.stringify(d.features || null), d.labels || [], Boolean(d.notify), d.ruleId,
      JSON.stringify(d.ruleMatches || []), d.screenKey?.key || null, d.screenKey?.scope || null, Boolean(d.own), Boolean(d.inSpamFolder),
      pending, p.promptId || null, p.promptVersion || null, p.model || null, p.aiCallId ?? null, Boolean(row.body_text || row.body_html)],
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
    const ctx = await loadUserContext(userId, list, cfg);
    const llmOn = allowReflex && !historical && await llmAvailable(userId).catch(() => false);
    const toReflex = [];
    for (const row of list) {
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
        if (prev && ['reflex', 'reasoning'].includes(prev.layer) && !userAuthoritative(d)) {
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
  const rows = (await loadRows(userId, messageIds)).filter((r) => !r.is_outgoing);
  if (!rows.length) return { skipped: 'no messages' };
  const ctx = await loadUserContext(userId, rows, cfg);
  const todo = [];
  for (const row of rows) {
    if (ctx.existing.get(row.id)?.layer === 'user') continue;
    const d = decideCheap(row, ctx);
    // The user's own rules and decisions are final; the model is not asked to second-guess them.
    if (userAuthoritative(d)) {
      await finalize(userId, row, d, ctx, { pending: null });
      continue;
    }
    todo.push({ row, d });
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
    if (!SOFT_ERRORS.has(err?.code)) throw err;
    for (const { row, d } of todo) await finalize(userId, row, d, ctx, { pending: null });
    return { skipped: err.code };
  }
  let sorted = 0;
  for (const { row, d } of todo) {
    const r = results.get(row.id);
    if (r) {
      mergeReflex(d, r, { bundles: ctx.bundles, cfg });
      applyPostRules(d, row, ctx);
    } else {
      d.signals.push({ name: 'reflexMissing', label: 'The model gave no answer for this message', weight: 0 });
    }
    await finalize(userId, row, d, ctx, { pending: null });
    sorted++;
  }
  await bumpHits(userId, ctx.ruleHits);
  return { sorted, escalated: [...results.values()].filter((r) => r.layer === 'reasoning').length };
}

/** Job `sort.resort` { messageIds?, sinceDays?, layers? }. */
export async function runResortJob({ messageIds = null, sinceDays = 7, layers = ['classifier'] }, job = {}) {
  const userId = job.user_id;
  if (!userId) return { skipped: 'bad payload' };
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
  return resortMessages(userId, ids, { onlyLayers: layers, allowReflex: false });
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

/** Every 30 s: bodies that landed, body waits that expired, and stuck Reflex rows. */
export async function pendingSweep() {
  const cfg = await getConfig();
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
  const { rowCount: stuck } = await query(
    `UPDATE hedwig_sort SET pending = NULL WHERE pending = 'reflex' AND decided_at < NOW() - INTERVAL '6 hours'`,
  );
  if (stuck) console.warn(`[hedwig] sort: ${stuck} message(s) waited 6 h for Reflex; keeping their classifier decision (see hedwig_jobs sort.reflex)`);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r.message_id);
  }
  let n = 0;
  for (const [userId, ids] of byUser) {
    // Mark the body as seen first so a model-less install does not pick the same rows up forever.
    await query(
      `UPDATE hedwig_sort s SET body_seen = (m.body_text IS NOT NULL OR m.body_html IS NOT NULL), pending = NULL
         FROM messages m WHERE m.id = s.message_id AND s.user_id = $1 AND s.message_id = ANY($2::uuid[]) AND s.pending IS DISTINCT FROM 'reflex'`,
      [userId, ids],
    );
    const res = await resortMessages(userId, ids, {});
    n += res.sorted;
  }
  return n;
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

async function spamReflex(userId, prepared, cfg, user) {
  const out = new Map();
  const size = Math.max(1, Math.min(8, cfg['sort.batchSize'] || 5));
  for (let i = 0; i < prepared.length; i += size) {
    const chunk = prepared.slice(i, i + size);
    const items = chunk.map(({ row, d }, j) => ({
      id: `m${j + 1}`,
      from: row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email,
      replyTo: addressesOf(row.reply_to).map((a) => a.email).join(', ') || null,
      subject: row.subject,
      history: `${Number(d.sender?.received || 0)} received, you replied to ${Number(d.sender?.replied || 0)}`,
      signals: [...d.signals.map((s) => s.label), ...d.rescue.reasons].slice(0, 10),
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
        out.set(target.row.id, { verdict: e.verdict, confidence: Math.max(0, Math.min(1, conf || 0)), reason: cleanReason(e.reason), layer: escalate ? 'reasoning' : 'reflex', provenance });
      }
    };
    try {
      await run(items, false);
      const unsure = items.filter((it, j) => {
        const r = out.get(chunk[j].row.id);
        return r && r.verdict === 'phishing' && r.confidence < cfg['spam.phishingEscalateBelow'];
      });
      if (unsure.length) await run(unsure, true);
    } catch (err) {
      if (!SOFT_ERRORS.has(err?.code)) console.warn(`[hedwig] sort: spam.reflex failed for ${userId}:`, err.message);
      break;
    }
  }
  return out;
}

/**
 * Rescue: run the layers over mail in the server spam folder and mark legitimate-looking mail
 * `rescued` above spam.rescueAbove. Nothing is moved; the Screener shows rescued mail from
 * undecided senders with inSpam, and decided senders' mail goes to their stream.
 */
export async function rescueRows(userId, rows, cfg) {
  if (!rows.length) return { rescued: 0, checked: 0 };
  await withExtras(rows);
  const ctx = await loadUserContext(userId, rows, cfg);
  const orders = await orderDomains(userId);
  const prepared = [];
  for (const row of rows) {
    if (ctx.existing.get(row.id)?.layer === 'user') continue;
    const d = decideCheap(row, ctx);
    d.sender = ctx.stats.get(d.keys.address || '') || null;
    const decision = d.senderDecision;
    d.rescue = rescueScore({
      row, sender: d.sender, decision: decision?.decision || null,
      alwaysIn: Boolean(decision && decision.source === 'import'), auth: d.header.auth, s1: d.s1, orderDomains: orders,
      phishingScore: d.phishingScore, text: d.text,
    });
    prepared.push({ row, d });
  }
  const above = cfg['spam.rescueAbove'];
  const llmOn = await llmAvailable(userId).catch(() => false);
  const borderline = prepared.filter(({ d }) => d.rescue.score >= above - 0.35 && d.rescue.score < above && d.spam !== 'phishing');
  const verdicts = llmOn && borderline.length ? await spamReflex(userId, borderline, cfg, ctx.user) : new Map();
  let rescued = 0;
  for (const { row, d } of prepared) {
    const v = verdicts.get(row.id);
    if (v) {
      if (v.verdict === 'legit') { d.rescue.score = round(Math.max(d.rescue.score, 0.5 * d.rescue.score + 0.5 * v.confidence + 0.1)); d.rescue.reasons.push(v.reason); }
      else { d.rescue.score = Math.min(d.rescue.score, 0.2); if (v.verdict === 'phishing') { d.spam = 'phishing'; d.spamReason = v.reason; d.spamConfidence = v.confidence; } }
      d.prompt = v.provenance;
      d.layer = v.layer;
      d.signals.push({ name: `spam.${v.layer}`, label: `${v.layer === 'reasoning' ? 'Reasoning model' : 'Reflex'}: ${v.reason}`, weight: v.confidence });
    }
    const userDecided = d.layer === 'rule' && (d.ruleId || d.senderDecision?.source === 'user');
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
    if (stored && d.spam === 'rescued') {
      await writeLog(userId, {
        messageId: row.id, action: 'rescue', from: { spam: 'suspected', stream: 'spam' },
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

/** Every 10 minutes: check new mail in each user's spam folders. */
export async function rescueSweep({ userIds = null, limit = 100 } = {}) {
  const users = userIds || await sortUsers();
  let rescued = 0;
  for (const userId of users) {
    const cfg = await getConfig(userId);
    if (!cfg.enabled || !cfg['sort.enabled']) continue;
    try {
      const { rows } = await query(
        `SELECT ${MESSAGE_COLUMNS}, ${EXTRA_COLUMNS}
           FROM messages m
           JOIN email_accounts a ON a.id = m.account_id
           LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
           LEFT JOIN hedwig_sort s ON s.message_id = m.id
          WHERE a.user_id = $1 AND NOT m.is_deleted AND ${SPAM_FOLDER_SQL}
            AND (m.date IS NULL OR m.date > NOW() - make_interval(days => $2))
            AND s.message_id IS NULL
          ORDER BY m.date DESC NULLS LAST
          LIMIT $3`,
        [userId, cfg['spam.suspectedDays'], limit],
      );
      const res = await rescueRows(userId, await decorate(rows), cfg);
      rescued += res.rescued;
    } catch (err) {
      console.warn(`[hedwig] sort: spam rescue failed for ${userId}:`, err.message);
    }
  }
  return rescued;
}

export { sortUsers };
