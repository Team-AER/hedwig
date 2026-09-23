// The nightly judge. A stratified sample of the user's mail goes through labels.judge (reasoning
// tier) and the Reflex tier's sort prompt. Where the two tiers agree with each other, with enough
// confidence, and do not contradict behaviour, the verdict becomes a silver label; where they
// disagree, or contradict what the user did, the item becomes a candidate question.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { messageText } from '../text.js';
import { outgoingSql, loadSenderStats, userAddresses } from '../triage/store.js';
import { runPrompt, runReflex } from './runtime.js';
import { stratifiedSample, folderClass } from './sample.js';
import { upsertLabels, resolveTargetLabels } from './store.js';
import { proposeQuestions, WHY_PRIORITY } from './questions.js';

const spamBool = (v) => (v == null ? null : v === 'suspected' || v === 'phishing' || v === true);

/** Which question kind asks about a field. */
const KIND_OF = { stream: 'stream', needs_you: 'needs_you', spam: 'spam' };
const SUITE_OF = { stream: 'sort', needs_you: 'needs_you', spam: 'spam' };

/**
 * Were the judge and the Reflex answer given by two different models on their own tiers? runPrompt
 * may move a prompt to the other tier on its last retry, and the gateway fallback may swap models,
 * so agreement only means something when the judge ran on the reasoning tier, Reflex on the reflex
 * tier, and the model names differ. Pure.
 */
export function independentTiers(judgeProvenance, reflexProvenance) {
  const jm = judgeProvenance?.model;
  const rm = reflexProvenance?.model;
  return judgeProvenance?.tier === 'reasoning' && reflexProvenance?.tier === 'reflex' && Boolean(jm) && Boolean(rm) && jm !== rm;
}

/**
 * Reconcile one item. Pure.
 * behaviour: { stream?, needs_you?, spam?, notStream? } each { value, grade, rule }
 * judge: { stream, needs_you, spam, confidence, rationale }; reflex: same shape or null
 * independent: false when the two answers did not come from two different models (independentTiers);
 *   their agreement then makes no label and the item goes to the question queue instead.
 * @returns {{ labels: Array, candidates: Array }}
 */
export function reconcileItem({ targetId, mid = null, inSpam = false, behaviour = {}, judge, reflex = null, minConfidence = 0.7, meta = {}, independent = true }) {
  const labels = [];
  const candidates = [];
  if (!judge) return { labels, candidates };
  const conf = Number(judge.confidence) || 0;
  const values = {
    stream: { j: judge.stream ?? null, r: reflex?.stream ?? null, b: behaviour.stream?.value },
    needs_you: { j: typeof judge.needs_you === 'boolean' ? judge.needs_you : null, r: typeof reflex?.needs_you === 'boolean' ? reflex.needs_you : null, b: behaviour.needs_you?.value },
    spam: { j: spamBool(judge.spam), r: spamBool(reflex?.spam), b: behaviour.spam?.value },
  };
  for (const [field, { j, r, b }] of Object.entries(values)) {
    if (j === null) continue;
    const behaviourConflict = (b !== undefined && b !== null && b !== j) || (field === 'stream' && behaviour.notStream?.value === j);
    const modelsAgree = r !== null && r === j && independent;
    const modelsDisagree = r !== null && r !== j;
    const behaviourAgrees = b !== undefined && b !== null && b === j;
    const evidence = {
      rule: 'judge', mid, confidence: conf, rationale: judge.rationale || null, reflex: r, behaviour: b ?? null,
      behaviourRule: behaviour[field]?.rule || null, ...meta,
    };
    // Same-model agreement counts for nothing: only the user's behaviour can then back the judge.
    const onlyBehaviour = r === null || (!independent && r === j);
    if (!behaviourConflict && conf >= minConfidence && (modelsAgree || (onlyBehaviour && behaviourAgrees))) {
      labels.push({ suite: SUITE_OF[field], targetId, label: { [field]: j }, grade: 'silver', source: 'judge', evidence });
      if (field === 'spam' && inSpam) labels.push({ suite: 'rescue', targetId, label: { rescue: !j }, grade: 'silver', source: 'judge', evidence });
      continue;
    }
    let why = null;
    if (behaviourConflict) why = 'behaviour_conflict';
    else if (modelsDisagree) why = field === 'spam' ? 'spam_disagree' : 'models_disagree';
    else if (conf < minConfidence) why = 'low_confidence';
    else if (r !== null && !independent) why = 'same_model';
    if (!why) continue;
    candidates.push({
      kind: KIND_OF[field], targetId, why,
      values: { judge: field === 'spam' ? judge.spam : j, reflex: field === 'spam' ? reflex?.spam ?? null : r, behaviour: b ?? null, rationale: judge.rationale || null, confidence: conf },
      priority: (WHY_PRIORITY[why] || 0) + (1 - conf) * 0.5,
    });
  }
  return { labels, candidates };
}

async function fetchCandidates(userId, addrs, seed) {
  const { rows } = await query(
    `WITH mine AS (
       SELECT m.id, m.message_id AS mid, m.folder, f.special_use, lower(m.from_email) AS sender, m.date
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE NOT m.is_deleted AND m.date > NOW() - INTERVAL '180 days' AND m.date <= NOW() + INTERVAL '1 day'
          AND NOT ${outgoingSql('m', 'f', '$2')}
          AND COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Drafts', '\\Sent', '\\All', '\\Flagged', '\\Important')
          AND m.folder !~* '(^|[/.])(trash|bin|deleted items|deleted messages|drafts|sent|sent items|sent mail)$'),
     vol AS (SELECT sender, COUNT(*)::int AS n FROM mine GROUP BY 1)
     SELECT mine.*, vol.n AS sender_volume FROM mine JOIN vol USING (sender)
      WHERE NOT EXISTS (SELECT 1 FROM hedwig_labels l WHERE l.user_id = $1 AND l.target_id = mine.id::text
                          AND (l.grade = 'gold' OR (l.source = 'judge' AND l.created_at > NOW() - INTERVAL '30 days')))
        AND NOT EXISTS (SELECT 1 FROM hedwig_questions q WHERE q.user_id = $1 AND q.target_id = mine.id::text)
      ORDER BY md5(mine.id::text || $3) LIMIT 5000`,
    [userId, addrs, String(seed)],
  );
  return rows;
}

async function fetchBodies(userId, ids) {
  const { rows } = await query(
    `SELECT m.id, m.from_name, lower(m.from_email) AS from_email, m.subject, m.date, m.to_addresses, m.cc_addresses,
            m.body_text, m.body_html, m.snippet, m.is_bulk, m.list_unsubscribe, m.attachments
       FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1 WHERE m.id = ANY($2::uuid[])`,
    [userId, ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Bundle definitions for sort.reflex (C's, when sorting is installed). */
export async function reflexBundles(userId) {
  try {
    const mod = await import('../sort/bundles.js');
    const list = typeof mod.loadBundles === 'function' ? await mod.loadBundles(userId) : (mod.DEFAULT_BUNDLES || []);
    return (list || []).filter((b) => b.enabled !== false).map((b) => ({ key: b.key, name: b.name, hint: b.hint || b.description || '' }));
  } catch {
    return [];
  }
}

export async function ownerLine(userId, addresses) {
  const { rows } = await query('SELECT display_name, username FROM users WHERE id = $1', [userId]).catch(() => ({ rows: [] }));
  const name = rows[0]?.display_name || rows[0]?.username || 'the user';
  const emails = [...(addresses || [])].slice(0, 5);
  return `${name}${emails.length ? ` (${emails.join(', ')})` : ''}`;
}

function roleOf(row, addresses) {
  const list = (v) => (Array.isArray(v) ? v : []).map((a) => String(a?.address || a?.email || a || '').toLowerCase());
  const to = list(row.to_addresses);
  if (to.some((e) => addresses.has(e))) return to.length > 1 ? `in To with ${to.length - 1} other${to.length > 2 ? 's' : ''}` : 'the only person in To';
  if (list(row.cc_addresses).some((e) => addresses.has(e))) return 'in Cc only';
  return 'not in To or Cc (Bcc, an alias or a list)';
}

/** Sender history in the words sort.reflex uses. */
export function historyLine(volume, stats) {
  const parts = [`${volume} message${volume === 1 ? '' : 's'} from them in 180 days`];
  if (stats && Number(stats.received) > 1) {
    parts.push(`you replied to ${Number(stats.replied || 0)}`, `opened ${Number(stats.opened || 0)}`);
    const ignored = Number(stats.archived_unread || 0) + Number(stats.deleted_unread || 0);
    if (ignored) parts.push(`left ${ignored} unread`);
  }
  return parts.join(', ');
}

/**
 * The prompt-facing view of a sampled message, in sort.reflex's item shape (so the same batch goes
 * to both tiers) plus the folder. Short ids keep the batch small.
 */
export function toItem(shortId, cand, body, { addresses = new Set(), stats = null } = {}) {
  const newText = body ? messageText(body, { maxChars: 2500 }) : '';
  const full = body ? messageText(body, { maxChars: 3200, stripQuotes: false }) : '';
  const quoted = full.length > newText.length + 40 ? full.slice(newText.length).trim().slice(0, 600) : '';
  const signals = [];
  if (body?.list_unsubscribe) signals.push('List-Unsubscribe header');
  if (body?.is_bulk) signals.push('bulk mail');
  const inSpam = folderClass(cand) === 'spam';
  if (inSpam) signals.push('the server put this in spam');
  const atts = (Array.isArray(body?.attachments) ? body.attachments : []).map((a) => a?.filename || a?.name).filter(Boolean).slice(0, 5);
  return {
    id: shortId,
    folder: cand.folder,
    inSpam,
    from: body?.from_name ? `${body.from_name} <${cand.sender}>` : cand.sender,
    role: body ? roleOf(body, addresses) : 'unknown',
    subject: body?.subject || '',
    date: cand.date ? new Date(cand.date).toISOString().slice(0, 16).replace('T', ' ') : '',
    history: historyLine(Number(cand.sender_volume) || 1, stats),
    signals,
    attachments: atts,
    newText,
    quoted,
  };
}

function behaviourFor(labelRows) {
  const out = {};
  for (const field of ['stream', 'needs_you', 'spam', 'notStream']) {
    const resolved = resolveTargetLabels(labelRows, field);
    for (const [target, v] of resolved) {
      (out[target] ||= {})[field] = { value: v.value, grade: v.grade, rule: v.row.evidence?.rule || null };
    }
  }
  return out;
}

/**
 * Judge one user's sample. Stops early (partial) when the labels budget runs out.
 * @returns {{ sampled, judged, silver, candidates, proposed, partial, reflexPrompt }}
 */
export async function judgeForUser(userId, { day = new Date().toISOString().slice(0, 10), useModelForQuestions = true } = {}) {
  const cfg = await getConfig(userId);
  const n = cfg['labels.judgeSample'];
  const stats = { sampled: 0, judged: 0, silver: 0, candidates: 0, proposed: 0, partial: false, reflexPrompt: null };
  if (!cfg.enabled || !n) return stats;
  const addrMap = await userAddresses([userId]);
  const addresses = addrMap.get(userId) || new Set();
  const seed = `${userId}:${day}`;
  const pool = await fetchCandidates(userId, [...addresses], seed);
  const sample = stratifiedSample(pool, n, { seed });
  stats.sampled = sample.length;
  if (!sample.length) return stats;

  const ids = sample.map((s) => s.id);
  const [bodies, senderStats, { rows: labelRows }] = await Promise.all([
    fetchBodies(userId, ids),
    loadSenderStats(userId, sample.map((s) => s.sender)),
    query(`SELECT target_id, label, grade, source, evidence, created_at FROM hedwig_labels WHERE user_id = $1 AND target_id = ANY($2::text[]) AND source <> 'judge'`, [userId, ids]),
  ]);
  const behaviour = behaviourFor(labelRows);
  const owner = await ownerLine(userId, addresses);
  const user = { name: owner.replace(/ \(.*$/, ''), addresses: [...addresses].slice(0, 10) };
  const bundles = await reflexBundles(userId);
  const batchSize = cfg['labels.judgeBatch'];
  const minConfidence = cfg['labels.judgeMinConfidence'];
  const labels = [];
  const candidates = [];

  for (let i = 0; i < sample.length; i += batchSize) {
    const part = sample.slice(i, i + batchSize);
    const items = part.map((c, k) => toItem(`m${i + k + 1}`, c, bodies.get(c.id), { addresses, stats: senderStats.get(c.sender) }));
    let judged;
    try {
      judged = await runPrompt('labels.judge', { owner, user, items }, { userId, feature: 'labels', lane: 'background' });
    } catch (err) {
      if (err.code === 'budget_exceeded' || err.code === 'llm_disabled') { stats.partial = true; break; }
      console.warn(`[hedwig] labels.judge batch failed for ${userId}:`, err.message);
      continue;
    }
    let reflex = null;
    try {
      // Pin the tier so an admin routing `labels` to the reasoning tier cannot make both opinions Qwen's.
      reflex = await runReflex(items, { owner, user, bundles, now: new Date().toISOString().slice(0, 16) }, { userId, feature: 'labels', lane: 'background', tier: 'reflex' });
      stats.reflexPrompt = reflex.promptId;
    } catch (err) {
      if (err.code === 'budget_exceeded') stats.partial = true;
      else if (err.code !== 'reflex_unavailable') console.warn(`[hedwig] labels: sort.reflex failed for ${userId}:`, err.message);
    }
    const byShort = new Map((judged.data?.items || []).map((r) => [r.id, r]));
    const independent = independentTiers(judged.provenance, reflex?.provenance);
    part.forEach((c, k) => {
      const item = items[k];
      const j = byShort.get(item.id);
      if (!j) return;
      stats.judged++;
      const res = reconcileItem({
        targetId: c.id, mid: c.mid, inSpam: item.inSpam, behaviour: behaviour[c.id] || {}, judge: j,
        reflex: reflex?.items?.[k] || null, minConfidence, independent,
        meta: {
          stratum: c.stratum, judgeModel: judged.provenance?.model || null, judgePrompt: judged.provenance?.promptVersion || null,
          reflexModel: reflex?.provenance?.model || null, reflexPrompt: reflex?.promptId || null, day,
          judgeTier: judged.provenance?.tier || null, reflexTier: reflex?.provenance?.tier || null,
        },
      });
      labels.push(...res.labels);
      candidates.push(...res.candidates);
    });
    if (stats.partial) break;
  }
  await upsertLabels(userId, labels);
  stats.silver = labels.length;
  stats.candidates = candidates.length;
  stats.proposed = await proposeQuestions(userId, candidates, { useModel: useModelForQuestions });
  return stats;
}
