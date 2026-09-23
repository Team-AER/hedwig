// Eval suites over hedwig_labels. Silver and gold targets are scored separately; a run is recorded
// in hedwig_eval_runs and accepted when it passes the gates against the last accepted run of the
// same suite and scope. Used by scripts/hedwig-eval.mjs and the admin `labels.eval` job.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { messageText } from '../text.js';
import { userAddresses } from '../triage/store.js';
import { loadLabels, resolveTargetLabels } from './store.js';
import { runPrompt, runReflex, retrieve, tableExists } from './runtime.js';
import { toItem, ownerLine, reflexBundles } from './judge.js';
import { verifyAnswer } from './askTriples.js';
import {
  recallAtK, reciprocalRank, mean, uniqueInOrder, binaryMetrics, multiclassMetrics, checkGates, diffMetrics,
} from './metrics.js';

export const EVAL_SUITES = Object.freeze(['retrieval', 'ask', 'sort', 'needs_you', 'spam', 'rescue']);
const FIELD = { sort: 'stream', needs_you: 'needs_you', spam: 'spam', rescue: 'rescue' };
const NOT_FOUND_RE = /couldn'?t find|could not find|can'?t find|cannot find|no (emails?|messages?|mail) (about|mention|that)|not (mentioned|in your (mail|email))|don'?t see|nothing in your (mail|email)|no information/i;
const round = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

async function usersWithLabels(suites, userId) {
  if (userId) return [userId];
  const { rows } = await query('SELECT DISTINCT user_id FROM hedwig_labels WHERE suite = ANY($1::text[])', [suites]);
  return rows.map((r) => r.user_id);
}

/** Current message ids for label targets: the uuid itself, or the row now carrying its Message-ID. */
async function resolveMessages(userId, targets) {
  const ids = targets.map((t) => t.targetId).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const mids = targets.map((t) => t.mid).filter(Boolean);
  const { rows } = await query(
    `SELECT m.id, m.message_id AS mid, m.folder, f.special_use FROM messages m
       JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE NOT m.is_deleted AND (m.id = ANY($2::uuid[]) OR m.message_id = ANY($3::text[]))`,
    [userId, ids, mids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byMid = new Map();
  for (const r of rows) if (r.mid && !byMid.has(r.mid)) byMid.set(r.mid, r);
  const out = new Map();
  for (const t of targets) {
    const hit = byId.get(t.targetId) || (t.mid ? byMid.get(t.mid) : null);
    if (hit) out.set(t.targetId, hit.id);
  }
  return out;
}

/** Targets with their truth for a classification suite, split by grade. */
async function classificationTargets(suite, userId) {
  const rows = await loadLabels({ userId, suites: [suite], minGrade: 'silver' });
  const field = FIELD[suite];
  const main = resolveTargetLabels(rows, field);
  const targets = [];
  for (const [targetId, v] of main) {
    targets.push({ targetId, truth: v.value, grade: v.grade, mid: v.row.evidence?.mid || null });
  }
  if (suite === 'sort') {
    const not = resolveTargetLabels(rows, 'notStream');
    for (const [targetId, v] of not) {
      if (main.has(targetId)) continue;
      targets.push({ targetId, truth: { not: v.value }, grade: v.grade, mid: v.row.evidence?.mid || null });
    }
  }
  return targets;
}

async function storedPredictions(suite, userId, messageIds) {
  const preds = new Map();
  if (!messageIds.length) return { preds, source: 'none' };
  if (await tableExists('hedwig_sort')) {
    const { rows } = await query('SELECT message_id, stream, needs_you, spam FROM hedwig_sort WHERE user_id = $1 AND message_id = ANY($2::uuid[])', [userId, messageIds]);
    for (const r of rows) {
      if (suite === 'sort') preds.set(r.message_id, r.stream ?? null);
      else if (suite === 'needs_you') preds.set(r.message_id, r.needs_you ?? null);
      else if (suite === 'spam') preds.set(r.message_id, r.spam == null ? null : ['suspected', 'phishing'].includes(r.spam));
      else if (suite === 'rescue') preds.set(r.message_id, r.spam == null ? null : ['rescued', 'clean'].includes(r.spam));
    }
    return { preds, source: 'hedwig_sort' };
  }
  if (suite === 'sort') return { preds, source: 'none (hedwig_sort missing)' };
  // Before sorting lands, triage's decisions are the only stored verdicts.
  const { rows } = await query(
    `SELECT message_id, COALESCE(CASE WHEN overridden THEN override_category END, category) AS category, needs_you, overridden
       FROM hedwig_triage WHERE user_id = $1 AND message_id = ANY($2::uuid[])`,
    [userId, messageIds],
  );
  for (const r of rows) {
    if (suite === 'needs_you') preds.set(r.message_id, r.overridden ? r.category === 'needs_you' : Boolean(r.needs_you));
    else if (suite === 'spam') preds.set(r.message_id, r.category === 'spam');
    else if (suite === 'rescue') preds.set(r.message_id, r.category !== 'spam');
  }
  return { preds, source: 'hedwig_triage' };
}

async function livePredictions(suite, userId, messageIds, { promptId, promptVersion, model, batch = 5 }) {
  const preds = new Map();
  let provenance = null;
  if (!messageIds.length) return { preds, source: 'live', provenance };
  const addresses = (await userAddresses([userId])).get(userId) || new Set();
  const owner = await ownerLine(userId, addresses);
  const user = { name: owner.replace(/ \(.*$/, ''), addresses: [...addresses].slice(0, 10) };
  const bundles = await reflexBundles(userId);
  const { rows } = await query(
    `SELECT m.id, m.message_id AS mid, m.folder, f.special_use, lower(m.from_email) AS sender, m.from_name, m.subject, m.date,
            m.to_addresses, m.cc_addresses, m.body_text, m.body_html, m.snippet, m.is_bulk, m.list_unsubscribe, m.attachments,
            (SELECT COUNT(*)::int FROM messages x WHERE x.account_id = m.account_id AND lower(x.from_email) = lower(m.from_email) AND x.date > NOW() - INTERVAL '180 days') AS sender_volume
       FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
       LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
      WHERE m.id = ANY($2::uuid[])`,
    [userId, messageIds],
  );
  const opts = { userId, feature: 'labels', lane: 'background', model: model || undefined, version: promptVersion || undefined };
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const items = part.map((r, k) => toItem(`m${k + 1}`, r, r, { addresses }));
    let out;
    if (promptId === 'labels.judge') {
      const res = await runPrompt('labels.judge', { owner, user, items }, opts);
      provenance = res.provenance;
      const byId = new Map((res.data?.items || []).map((x) => [x.id, x]));
      out = items.map((it) => byId.get(it.id) || null);
    } else {
      const res = await runReflex(items, { owner, user, bundles }, opts);
      provenance = { ...(res.provenance || {}), promptId: res.promptId };
      out = res.items;
    }
    part.forEach((r, k) => {
      const o = out[k];
      if (!o) return;
      const spam = o.spam == null ? null : ['suspected', 'phishing'].includes(o.spam);
      if (suite === 'sort') preds.set(r.id, o.stream ?? null);
      else if (suite === 'needs_you') preds.set(r.id, typeof o.needs_you === 'boolean' ? o.needs_you : null);
      else if (suite === 'spam') preds.set(r.id, spam);
      else if (suite === 'rescue') preds.set(r.id, spam === null ? null : !spam);
    });
  }
  return { preds, source: 'live', provenance };
}

async function classificationSuite(suite, users, opts) {
  const pairs = { silver: [], gold: [] };
  let source = null;
  let provenance = null;
  for (const userId of users) {
    const targets = await classificationTargets(suite, userId);
    if (!targets.length) continue;
    const current = await resolveMessages(userId, targets);
    const ids = [...new Set([...current.values()])].slice(0, opts.limit || 100000);
    const idSet = new Set(ids);
    const live = Boolean(opts.promptVersion || opts.model || opts.live);
    const res = live
      ? await livePredictions(suite, userId, ids, { promptId: opts.promptId || 'sort.reflex', promptVersion: opts.promptVersion, model: opts.model })
      : await storedPredictions(suite, userId, ids);
    source = res.source;
    provenance = res.provenance || provenance;
    for (const t of targets) {
      const mid = current.get(t.targetId);
      if (!mid || !idSet.has(mid)) continue;
      const pred = res.preds.has(mid) ? res.preds.get(mid) : null;
      (t.grade === 'gold' ? pairs.gold : pairs.silver).push({ truth: t.truth, pred });
    }
  }
  const score = (p) => (suite === 'sort' ? multiclassMetrics(p, ['people', 'reading', 'records']) : binaryMetrics(p));
  return { silver: score(pairs.silver), gold: score(pairs.gold), nSilver: pairs.silver.length, nGold: pairs.gold.length, source, provenance };
}

async function askItems(userId, { unanswerable = false } = {}) {
  const rows = await loadLabels({ userId, suites: ['ask'], minGrade: 'silver' });
  return rows.map((r) => ({ ...r, label: typeof r.label === 'string' ? JSON.parse(r.label) : r.label }))
    .filter((r) => (unanswerable ? r.label.answerable === false : r.label.answerable !== false));
}

async function messageKeys(userId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT m.id, COALESCE(m.message_id, m.id::text) AS k FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1 WHERE m.id = ANY($2::uuid[])`,
    [userId, ids],
  );
  return new Map(rows.map((r) => [r.id, r.k]));
}

async function retrievalSuite(users, opts) {
  const per = { silver: { recall: [], rr: [] }, gold: { recall: [], rr: [] } };
  let via = null;
  for (const userId of users) {
    const items = (await askItems(userId)).filter((r) => Array.isArray(r.label.sourceIds) && r.label.sourceIds.length && !r.label.wrong).slice(0, opts.limit || 200);
    for (const it of items) {
      const res = await retrieve({ userId, query: it.label.question, filters: {}, limit: 10, expandThreads: false });
      via = res.via || via;
      const rankedIds = uniqueInOrder((res.chunks || []).map((c) => c.messageId));
      const keys = await messageKeys(userId, [...rankedIds, ...it.label.sourceIds]);
      const k = (id) => keys.get(id) || id;
      const ranked = uniqueInOrder(rankedIds.map(k));
      const relevant = it.label.sourceIds.map(k);
      const bucket = it.grade === 'gold' ? per.gold : per.silver;
      bucket.recall.push(recallAtK(ranked, relevant, 10));
      bucket.rr.push(reciprocalRank(ranked, relevant));
    }
  }
  const agg = (b) => ({ items: b.recall.length, recallAt10: round(mean(b.recall)), mrr: round(mean(b.rr)) });
  return { silver: agg(per.silver), gold: agg(per.gold), nSilver: per.silver.recall.length, nGold: per.gold.recall.length, source: via };
}

async function sourceTexts(userId, ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT m.id, m.subject, m.body_text, m.body_html, m.snippet FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1 WHERE m.id = ANY($2::uuid[])`,
    [userId, ids],
  );
  return rows.map((r, i) => ({ id: `c${i + 1}`, text: `Subject: ${r.subject || ''}\n${messageText(r, { maxChars: 2000 })}` }));
}

async function askOnce(userId, question) {
  const { answerQuestion } = await import('../context/ask.js');
  const started = new Date();
  try {
    const res = await answerQuestion(userId, question, {});
    const cited = (res.citations || []).map((n) => res.sources?.[n - 1]?.message?.id).filter(Boolean);
    return { answer: res.answer, cited, sources: (res.sources || []).map((s) => s.message?.id).filter(Boolean) };
  } finally {
    // Eval questions are not the user's history.
    await query('DELETE FROM hedwig_ask_log WHERE user_id = $1 AND question = $2 AND created_at >= $3', [userId, question, started]).catch(() => {});
  }
}

const normAnswer = (s) => String(s || '').toLowerCase().replace(/\[\d+\]/g, '').replace(/\W+/g, ' ').trim();

async function askSuite(users, opts) {
  const per = { silver: { faithful: [], sourceRecall: [], fakeNotFound: [], notFound: [], wrongRepeat: [] }, gold: { faithful: [], sourceRecall: [], fakeNotFound: [], notFound: [], wrongRepeat: [] } };
  const limit = opts.limit || 40;
  for (const userId of users) {
    const answerable = (await askItems(userId)).slice(0, limit);
    const unanswerable = (await askItems(userId, { unanswerable: true })).slice(0, Math.ceil(limit / 2));
    for (const it of answerable) {
      const b = it.grade === 'gold' ? per.gold : per.silver;
      const got = await askOnce(userId, it.label.question);
      const notFound = NOT_FOUND_RE.test(got.answer || '');
      if (it.label.wrong) b.wrongRepeat.push(normAnswer(got.answer) === normAnswer(it.label.answer) ? 1 : 0);
      else b.fakeNotFound.push(notFound ? 1 : 0);
      if (!notFound && got.answer) {
        const sources = await sourceTexts(userId, got.cited.length ? got.cited : got.sources.slice(0, 5));
        const v = sources.length ? await verifyAnswer(userId, { question: it.label.question, answer: got.answer, sources }) : { supported: false };
        b.faithful.push(v.supported ? 1 : 0);
      }
      if (Array.isArray(it.label.sourceIds) && it.label.sourceIds.length && !it.label.wrong) {
        const keys = await messageKeys(userId, [...got.sources, ...it.label.sourceIds]);
        const found = new Set(got.sources.map((id) => keys.get(id) || id));
        b.sourceRecall.push(it.label.sourceIds.some((id) => found.has(keys.get(id) || id)) ? 1 : 0);
      }
    }
    for (const it of unanswerable) {
      const b = it.grade === 'gold' ? per.gold : per.silver;
      const got = await askOnce(userId, it.label.question);
      b.notFound.push(NOT_FOUND_RE.test(got.answer || '') ? 1 : 0);
    }
  }
  const agg = (b) => ({
    items: b.faithful.length + b.notFound.length + b.wrongRepeat.length,
    faithfulness: round(mean(b.faithful)),
    sourceRecall: round(mean(b.sourceRecall)),
    notFoundRate: round(mean(b.notFound)),
    fakeNotFound: round(mean(b.fakeNotFound)),
    wrongRepeat: round(mean(b.wrongRepeat)),
  });
  const n = (b) => b.fakeNotFound.length + b.notFound.length + b.wrongRepeat.length;
  return { silver: agg(per.silver), gold: agg(per.gold), nSilver: n(per.silver), nGold: n(per.gold), source: 'context/ask.js' };
}

/** Score one suite. Does not record. */
export async function runSuite(suite, { userId = null, promptVersion = null, promptId = null, model = null, limit = null, live = false } = {}) {
  if (!EVAL_SUITES.includes(suite)) throw Object.assign(new Error(`suite must be one of ${EVAL_SUITES.join(', ')}`), { status: 400 });
  const labelSuites = suite === 'retrieval' || suite === 'ask' ? ['ask'] : [suite];
  const users = await usersWithLabels(labelSuites, userId);
  const opts = { promptVersion, promptId, model, limit, live };
  if (suite === 'retrieval') return retrievalSuite(users, opts);
  if (suite === 'ask') return askSuite(users, opts);
  return classificationSuite(suite, users, opts);
}

export async function lastAcceptedRun(suite, scopeUser = null) {
  const { rows } = await query(
    `SELECT * FROM hedwig_eval_runs WHERE suite = $1 AND accepted AND (metrics->'scope'->>'userId') IS NOT DISTINCT FROM $2
      ORDER BY started_at DESC LIMIT 1`,
    [suite, scopeUser],
  );
  return rows[0] || null;
}

/** Run, gate against the last accepted run, record. Returns the run and the comparison. */
export async function runAndRecord(suite, opts = {}) {
  const started = new Date();
  const cfg = await getConfig();
  const result = await runSuite(suite, opts);
  const prev = await lastAcceptedRun(suite, opts.userId || null);
  const metrics = { silver: result.silver, gold: result.gold };
  const gates = checkGates(suite, metrics, prev?.metrics || null, { gatePoints: cfg['eval.gatePoints'] });
  const diff = prev ? { silver: diffMetrics(metrics.silver, prev.metrics?.silver), gold: diffMetrics(metrics.gold, prev.metrics?.gold) } : null;
  const live = Boolean(opts.promptVersion || opts.model || opts.live);
  const record = {
    suite,
    promptId: live ? (result.provenance?.promptId || opts.promptId || 'sort.reflex') : null,
    promptVersion: live ? (result.provenance?.promptVersion || opts.promptVersion || null) : null,
    model: live ? (result.provenance?.model || opts.model || null) : (result.source || null),
    metrics: { ...metrics, scope: { userId: opts.userId || null, source: result.source || null, live }, gates, previousRunId: prev?.id || null },
    nGold: result.nGold,
    nSilver: result.nSilver,
    accepted: gates.pass && (result.nGold + result.nSilver) > 0,
  };
  let id = null;
  if (opts.record !== false) {
    const { rows } = await query(
      `INSERT INTO hedwig_eval_runs (suite, prompt_id, prompt_version, model, metrics, n_gold, n_silver, accepted, started_at, finished_at, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10) RETURNING id`,
      [suite, record.promptId, record.promptVersion, record.model, JSON.stringify(record.metrics), record.nGold, record.nSilver,
        record.accepted, started, opts.notes || (gates.failures.length ? gates.failures.join('; ') : null)],
    );
    id = rows[0]?.id ?? null;
  }
  return { id, ...record, gates, diff, previous: prev ? { id: prev.id, started_at: prev.started_at, metrics: prev.metrics } : null };
}

export async function listRuns({ suite = null, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const { rows } = await query(
    `SELECT id, suite, prompt_id, prompt_version, model, metrics, n_gold, n_silver, accepted, started_at, finished_at, notes
       FROM hedwig_eval_runs WHERE ($1::text IS NULL OR suite = $1) ORDER BY started_at DESC LIMIT $2`,
    [suite, n],
  );
  return rows;
}
