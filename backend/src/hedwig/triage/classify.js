// Pipeline step `triage` (order 30). Stage 1 (rules) always runs; stage 2 (the user's model) takes
// over once it has been trained on triage.minSamples labels; stage 3 (the fast model) is queued as
// a job for decisions in the uncertain band so the pipeline never waits on a model call.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { enqueue } from '../jobs.js';
import { llmAvailable } from '../llm.js';
import { messageText, addressesOf } from '../text.js';
import { HEDWIG_HOOKS, collectHedwigHook, runHedwigHook } from '../hooks.js';
import { CATEGORIES, stage1, threadFacts, needsYouLabel } from './signals.js';
import { buildFeatures, describeFeature, isSenderFeature } from './features.js';
import { predict, contributions } from './model.js';
import { loadSenderStats, loadRules, loadModel, loadThreads, toTriageInfo, isGone } from './store.js';
import { resolveByOutgoing, resolveWaitingByIncoming } from './resolution.js';

const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

/** What plugins receive in beforeTriage: the message minus bodies, plus the stripped text. */
function hookMessage(row, text) {
  return {
    id: row.id,
    accountId: row.account_id,
    folder: row.folder,
    subject: row.subject,
    from: { name: row.from_name, email: row.from_email },
    to: addressesOf(row.to_addresses),
    cc: addressesOf(row.cc_addresses),
    date: row.date,
    text,
    isBulk: Boolean(row.is_bulk),
    category: row.category || null,
    hasAttachments: Boolean(row.has_attachments),
  };
}

/** Merge beforeTriage results: numeric features add up; the first valid verdict wins. */
export function mergePluginResults(results) {
  const features = {};
  let verdict = null;
  for (const r of results || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.features && typeof r.features === 'object') {
      for (const [k, v] of Object.entries(r.features)) {
        const n = Number(v);
        if (Number.isFinite(n)) features[k] = (features[k] || 0) + n;
      }
    }
    const v = r.verdict;
    if (!verdict && v && CATEGORIES.includes(v.category) && v.category !== 'waiting_on') {
      verdict = { category: v.category, reason: String(v.reason || '').slice(0, 120), pluginId: String(r.pluginId || v.pluginId || 'plugin').slice(0, 64) };
    }
  }
  return { features, verdict };
}

/**
 * Decide one message. Pure apart from the inputs it is given; exported for tests.
 * @returns {object} decision ready for storage
 */
export function decide({ row, text, userAddresses, sender, thread, rules, model, cfg, plugin = { features: {}, verdict: null }, now = new Date() }) {
  const threshold = cfg['triage.needsYouThreshold'];
  const facts = threadFacts(row, thread || []);
  const s1 = stage1({ row, userAddresses, text, sender, thread: facts, rules, threshold, now });
  const features = buildFeatures({ row, s1, sender, thread: facts, extra: plugin.features });

  let stage = 1;
  let p = s1.p;
  let category = s1.category;
  let reasonLabel = s1.reasonLabel;
  let reasons = [...s1.reasons];
  let modelVersion = null;
  let learnedSender = false;
  let p2 = null;

  const modelActive = model?.model?.weights && Number(model.samples) >= cfg['triage.minSamples'];
  if (modelActive && !s1.hard) {
    p2 = predict(model.model, features);
    stage = 2;
    modelVersion = model.version;
    const w = cfg['triage.modelWeight'] ?? 0.65;
    p = w * p2 + (1 - w) * s1.p;
    const top = contributions(model.model, features).filter((c) => Math.abs(c.contribution) >= 0.15).slice(0, 4);
    learnedSender = top.some((c) => c.contribution > 0 && isSenderFeature(c.name));
    reasons = [
      ...top.map((c) => ({ label: `Learned: ${describeFeature(c.name)}`, weight: round(Math.abs(c.contribution)), direction: c.contribution > 0 ? 'for' : 'against' })),
      ...reasons,
    ];
    if (category === 'needs_you' || category === 'everything') {
      category = p >= threshold ? 'needs_you' : 'everything';
    } else if (p2 >= (cfg['triage.modelPromote'] ?? 0.8) && p >= threshold) {
      category = 'needs_you';
    }
    if (category === 'everything' && s1.category === 'needs_you') reasonLabel = 'FYI';
  }

  // The user's own rules outrank plugins; a plugin verdict outranks everything else.
  const verdict = s1.rule ? null : plugin.verdict;
  if (verdict) {
    category = verdict.category;
    reasons.unshift({
      label: `Plugin ${verdict.pluginId}${verdict.reason ? `: ${verdict.reason}` : ''}`,
      weight: 1,
      direction: category === 'needs_you' ? 'for' : 'against',
      flag: `plugin:${verdict.pluginId}`,
    });
    reasonLabel = verdict.reason && verdict.reason.length <= 24 ? verdict.reason : `Plugin · ${verdict.pluginId}`;
  }

  const needsYou = category === 'needs_you';
  if (needsYou && !verdict && !s1.rule) {
    reasonLabel = needsYouLabel({ flags: s1.flags, deadline: s1.analysis.deadline, amounts: s1.amounts, now, learnedSender });
  }
  if (!reasonLabel) reasonLabel = needsYou ? 'Needs you' : 'FYI';

  const hard = s1.hard || Boolean(verdict);
  const ageDays = row.date ? (now.getTime() - new Date(row.date).getTime()) / 86400_000 : 0;
  const askModel = !hard && (category === 'needs_you' || category === 'everything')
    && p >= cfg['triage.llmLow'] && p <= cfg['triage.llmHigh'] && ageDays <= (cfg['triage.llmMaxAgeDays'] ?? 14);

  const spamScore = s1.spam.rulesScore ?? (Number.isFinite(Number(row.spam_score_ml)) && row.spam_score_ml !== null ? Number(row.spam_score_ml) : null);
  return {
    category,
    priority: round(p, 4),
    needsYou,
    confidence: hard ? 0.95 : round(Math.min(0.95, Math.abs(p - 0.5) * 2)),
    stage,
    reasons: reasons.slice(0, 12),
    reasonLabel,
    modelVersion,
    features,
    deadlineAt: s1.deadlineAt,
    spamScore,
    resolved: isGone(row),
    askModel,
    p1: s1.p,
    p2,
  };
}

export async function storeDecision(userId, row, d) {
  const { rows } = await query(
    `INSERT INTO hedwig_triage (message_id, user_id, account_id, category, priority, needs_you, spam_score, confidence, stage,
                               reasons, reason_label, model_version, decided_at, features, deadline_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, CASE WHEN $15 THEN NOW() END)
     ON CONFLICT (message_id) DO UPDATE SET
       category = EXCLUDED.category, priority = EXCLUDED.priority, needs_you = EXCLUDED.needs_you,
       spam_score = EXCLUDED.spam_score, confidence = EXCLUDED.confidence, stage = EXCLUDED.stage,
       reasons = EXCLUDED.reasons, reason_label = EXCLUDED.reason_label, model_version = EXCLUDED.model_version,
       decided_at = NOW(), features = EXCLUDED.features, deadline_at = EXCLUDED.deadline_at,
       resolved_at = COALESCE(hedwig_triage.resolved_at, EXCLUDED.resolved_at)
     WHERE hedwig_triage.user_id = EXCLUDED.user_id AND NOT hedwig_triage.overridden AND hedwig_triage.stage < 3
     RETURNING *`,
    [row.id, userId, row.account_id, d.category, d.priority, d.needsYou, d.spamScore, d.confidence, d.stage,
      JSON.stringify(d.reasons), d.reasonLabel, d.modelVersion, JSON.stringify(d.features), d.deadlineAt, d.resolved],
  );
  return rows[0] || null;
}

async function markTriaged(ids) {
  if (!ids.length) return;
  await query('UPDATE hedwig_msg SET triaged_at = NOW() WHERE message_id = ANY($1::uuid[])', [ids]);
}

async function markError(id, message) {
  await query(
    `UPDATE hedwig_msg SET error = LEFT(COALESCE(error || '; ', '') || $2, 1000) WHERE message_id = $1`,
    [id, message],
  );
}

export async function runTriage(rows) {
  const now = new Date();
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  for (const [userId, list] of byUser) {
    const cfg = await getConfig(userId);
    if (!cfg['features.triage']) continue;
    const addresses = list[0].user_addresses || new Set();
    const outgoing = list.filter((r) => r.is_outgoing);
    const incoming = list.filter((r) => !r.is_outgoing);
    if (outgoing.length) await resolveByOutgoing(userId, outgoing);
    if (incoming.length) await resolveWaitingByIncoming(userId, incoming);
    await markTriaged(outgoing.map((r) => r.id));
    if (!incoming.length) continue;

    const [senders, rules, model, threads, overridden] = await Promise.all([
      loadSenderStats(userId, incoming.map((r) => r.from_email)),
      loadRules(userId),
      loadModel(userId),
      loadThreads(userId, incoming, addresses),
      query('SELECT message_id FROM hedwig_triage WHERE user_id = $1 AND message_id = ANY($2::uuid[]) AND overridden', [userId, incoming.map((r) => r.id)]),
    ]);
    const skip = new Set(overridden.rows.map((r) => r.message_id));
    const llmOn = await llmAvailable(userId).catch(() => false);
    const done = [];
    for (const row of incoming) {
      if (skip.has(row.id)) { done.push(row.id); continue; }
      try {
        const text = messageText(row, { maxChars: 4000 });
        const thread = threads.get(`${row.account_id}|${row.thread_key}`) || [];
        const sender = senders.get(String(row.from_email || '').toLowerCase()) || null;
        let plugin = { features: {}, verdict: null };
        const probe = decide({ row, text, userAddresses: addresses, sender, thread, rules, model, cfg, now });
        const results = await collectHedwigHook(HEDWIG_HOOKS.beforeTriage, { userId, message: hookMessage(row, text), features: { ...probe.features } }).catch(() => []);
        plugin = mergePluginResults(results);
        const d = plugin.verdict || Object.keys(plugin.features).length
          ? decide({ row, text, userAddresses: addresses, sender, thread, rules, model, cfg, plugin, now })
          : probe;
        const stored = await storeDecision(userId, row, d);
        done.push(row.id);
        if (!stored) continue;
        if (d.askModel && llmOn && !stored.resolved_at) {
          await enqueue('triage.llm', { messageId: row.id }, { userId, dedupeKey: `triage.llm:${row.id}`, priority: 6, maxAttempts: 3 });
        }
        runHedwigHook(HEDWIG_HOOKS.afterTriage, { userId, messageId: row.id, triage: toTriageInfo(stored) }).catch(() => {});
      } catch (err) {
        console.warn(`[hedwig] triage failed for message ${row.id}:`, err.message);
        await markError(row.id, `triage: ${err.message}`).catch(() => {});
      }
    }
    await markTriaged(done);
  }
}
