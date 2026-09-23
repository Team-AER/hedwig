// Gentle questions: at most labels.questionsPerDay a day, one tap, the evidence attached, never
// repeated for a target, dropped when other evidence settles them. An answer is a gold label.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { runPrompt, recordCorrection, applySortCorrection, tableExists } from './runtime.js';
import { upsertLabels } from './store.js';

export const KINDS = Object.freeze({
  stream: { suite: 'sort', field: 'stream' },
  needs_you: { suite: 'needs_you', field: 'needs_you' },
  spam: { suite: 'spam', field: 'spam' },
});

export function optionsFor(kind) {
  switch (kind) {
    case 'stream': return [
      { id: 'people', label: 'A person', always: true },
      { id: 'reading', label: 'Reading', always: true },
      { id: 'records', label: 'Records', always: true },
    ];
    case 'needs_you': return [
      { id: 'yes', label: 'Yes, it needed me' },
      { id: 'no', label: 'No', always: true },
    ];
    case 'spam': return [
      { id: 'spam', label: 'Junk', always: true },
      { id: 'clean', label: 'Real mail', always: true },
    ];
    default: return [];
  }
}

// Why a candidate is worth asking, most useful first: the user's own behaviour contradicting the
// models teaches the most, and a possible spam false positive costs the most.
export const WHY_PRIORITY = { behaviour_conflict: 3, spam_disagree: 2.5, models_disagree: 2, low_confidence: 1, same_model: 1 };

/** Best candidate per target, minus targets that were ever asked. Pure. */
export function dedupeCandidates(candidates, askedTargets = new Set()) {
  const best = new Map();
  for (const c of candidates) {
    if (!c?.targetId || askedTargets.has(String(c.targetId))) continue;
    const prev = best.get(String(c.targetId));
    if (!prev || (c.priority ?? 0) > (prev.priority ?? 0)) best.set(String(c.targetId), c);
  }
  return [...best.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

/**
 * Should an open question be dropped? Pure.
 * facts: { messageExists, labels: [{ suite, label, grade, source, created_at, rule }], correctedAfter }
 * @returns {{ drop: boolean, reason?: string }}
 */
export function settleDecision(question, facts) {
  if (facts.messageExists === false) return { drop: true, reason: 'the message is gone' };
  if (facts.correctedAfter) return { drop: true, reason: 'you corrected it directly' };
  const k = KINDS[question.kind];
  if (!k) return { drop: false };
  const relevant = (facts.labels || []).filter((l) => l.suite === k.suite && l.label && l.label[k.field] !== undefined);
  const gold = relevant.find((l) => l.grade === 'gold');
  if (gold) return { drop: true, reason: `answered elsewhere (${gold.source})` };
  const created = new Date(question.created_at || 0).getTime();
  const behaviour = relevant.find((l) => l.grade === 'silver' && l.source === 'behaviour' && new Date(l.created_at).getTime() > created);
  if (behaviour) return { drop: true, reason: `settled by what you did (${behaviour.rule || 'behaviour'})` };
  return { drop: false };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const monthYear = (d) => (d ? new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(d)) : null);
const quoteSubject = (s) => `“${String(s || '(no subject)').replace(/\s+/g, ' ').trim().slice(0, 60)}”`;

/** Plain second-person question from evidence, without a model. */
export function templateQuestion(kind, ev) {
  const who = ev.from || ev.sender || 'this sender';
  const since = ev.senderFirst ? ` since ${monthYear(ev.senderFirst)}` : '';
  switch (kind) {
    case 'needs_you':
      if ((ev.senderCount || 0) > 1) {
        return `${who} has sent you ${plural(ev.senderCount, 'message', 'messages')}${since} and you replied to ${ev.senderReplied || 0}. Did ${quoteSubject(ev.subject)} need you?`;
      }
      return `Did ${quoteSubject(ev.subject)} from ${who} need something from you?`;
    case 'stream':
      return `Is mail from ${who} a person writing to you, something to read, or a record to keep? You have ${plural(ev.senderCount || 1, 'message', 'messages')} from them${since}.`;
    case 'spam':
      return `${quoteSubject(ev.subject)} from ${who} ${ev.inSpam ? 'landed in your spam folder' : 'looks like junk to me'}. Is it junk, or real mail?`;
    default:
      return `How should Hedwig treat mail from ${who}?`;
  }
}

/** Numbers a question may mention: every digit run in the evidence. */
function allowedNumbers(evidence) {
  return new Set(JSON.stringify(evidence).match(/\d+/g) || []);
}

/** A model-written question is kept only if every number in it comes from the evidence. Pure. */
export function questionIsGrounded(text, evidence) {
  const allowed = allowedNumbers(evidence);
  return (String(text).match(/\d+/g) || []).every((n) => allowed.has(n));
}


/** Counts and dates about a message and its sender, computed from the user's mail. */
export async function gatherEvidence(userId, messageId) {
  const { rows } = await query(
    `WITH msg AS (
       SELECT m.id, m.message_id AS mid, m.account_id, m.subject, m.from_name, lower(m.from_email) AS sender, m.date, m.folder,
              (COALESCE(f.special_use, '') = '\\Junk' OR m.folder ~* '(^|[/.])(spam|junk|junk e-?mail|bulk mail)$') AS in_spam
         FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = $1
         LEFT JOIN folders f ON f.account_id = m.account_id AND f.path = m.folder
        WHERE m.id = $2),
     theirs AS (
       SELECT DISTINCT ON (COALESCE(x.message_id, x.id::text)) x.message_id, x.date, x.is_read
         FROM messages x JOIN email_accounts xa ON xa.id = x.account_id AND xa.user_id = $1
        WHERE lower(x.from_email) = (SELECT sender FROM msg) AND NOT x.is_deleted AND x.date > NOW() - INTERVAL '180 days')
     SELECT msg.*,
            (SELECT COUNT(*)::int FROM theirs) AS sender_count,
            (SELECT MIN(date) FROM theirs) AS sender_first,
            (SELECT COUNT(*)::int FROM theirs WHERE is_read) AS sender_opened,
            (SELECT COUNT(DISTINCT o.in_reply_to)::int FROM messages o JOIN email_accounts oa ON oa.id = o.account_id AND oa.user_id = $1
              WHERE o.in_reply_to IN (SELECT message_id FROM theirs WHERE message_id IS NOT NULL)) AS sender_replied
       FROM msg`,
    [userId, messageId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    messageId: r.id,
    mid: r.mid || null,
    from: r.from_name || r.sender,
    sender: r.sender,
    subject: r.subject || '(no subject)',
    date: r.date ? new Date(r.date).toISOString().slice(0, 10) : null,
    folder: r.folder,
    inSpam: Boolean(r.in_spam),
    senderCount: r.sender_count,
    senderFirst: r.sender_first ? new Date(r.sender_first).toISOString().slice(0, 10) : null,
    senderOpened: r.sender_opened,
    senderReplied: r.sender_replied,
    windowDays: 180,
  };
}

/** Question text: the model phrases it from the evidence; a template when it cannot or strays. */
export async function writeQuestion(userId, kind, evidence, options, { useModel = true } = {}) {
  const fallback = templateQuestion(kind, evidence);
  if (!useModel) return { text: fallback, by: 'template' };
  try {
    const { data } = await runPrompt('labels.question', { kind, evidence, options }, { userId, feature: 'labels', lane: 'background' });
    const text = String(data?.question || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 8 && text.length <= 200 && questionIsGrounded(text, evidence)) return { text, by: 'model' };
  } catch (err) {
    if (!['llm_disabled', 'budget_exceeded'].includes(err.code)) console.warn('[hedwig] labels.question failed:', err.message);
  }
  return { text: fallback, by: 'template' };
}

/**
 * Queue candidates as questions (not yet asked). Targets ever asked are skipped; the backlog is
 * capped at five days of questions.
 * candidate: { kind, targetId, why, values, priority }
 */
export async function proposeQuestions(userId, candidates, { useModel = true } = {}) {
  const cfg = await getConfig(userId);
  const perDay = cfg['labels.questionsPerDay'];
  if (!perDay || !candidates.length) return 0;
  const { rows: existing } = await query('SELECT target_id, (answered_at IS NULL AND dropped_at IS NULL) AS open FROM hedwig_questions WHERE user_id = $1', [userId]);
  const room = perDay * 5 - existing.filter((r) => r.open).length;
  if (room <= 0) return 0;
  const fresh = dedupeCandidates(candidates, new Set(existing.map((r) => r.target_id))).slice(0, room);
  let n = 0;
  for (const c of fresh) {
    const facts = await gatherEvidence(userId, c.targetId);
    if (!facts) continue;
    const evidence = { ...facts, why: c.why, models: c.values || {} };
    const options = optionsFor(c.kind);
    const { text, by } = await writeQuestion(userId, c.kind, facts, options, { useModel });
    const { rowCount } = await query(
      `INSERT INTO hedwig_questions (user_id, kind, target_id, question, evidence, options, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, target_id) DO NOTHING`,
      [userId, c.kind, String(c.targetId), text, JSON.stringify({ ...evidence, writtenBy: by }), JSON.stringify(options), c.priority ?? 0],
    );
    n += rowCount || 0;
  }
  return n;
}

async function settleOpen(userId) {
  const corrections = await tableExists('hedwig_corrections');
  const { rows } = await query(
    `SELECT q.id, q.kind, q.target_id, q.created_at,
            EXISTS (SELECT 1 FROM messages m JOIN email_accounts a ON a.id = m.account_id AND a.user_id = q.user_id
                     WHERE m.id::text = q.target_id OR (q.evidence->>'mid' IS NOT NULL AND m.message_id = q.evidence->>'mid')) AS message_exists,
            ${corrections ? `EXISTS (SELECT 1 FROM hedwig_corrections c WHERE c.user_id = q.user_id AND c.target_id = q.target_id AND c.created_at > q.created_at)` : 'false'} AS corrected_after,
            (SELECT COALESCE(json_agg(json_build_object('suite', l.suite, 'label', l.label, 'grade', l.grade, 'source', l.source,
                                                        'created_at', l.created_at, 'rule', l.evidence->>'rule')), '[]'::json)
               FROM hedwig_labels l WHERE l.user_id = q.user_id AND l.target_id = q.target_id AND l.grade IN ('silver', 'gold') AND l.source <> 'judge') AS labels
       FROM hedwig_questions q
      WHERE q.user_id = $1 AND q.answered_at IS NULL AND q.dropped_at IS NULL`,
    [userId],
  );
  let dropped = 0;
  for (const q of rows) {
    const d = settleDecision(q, { messageExists: q.message_exists, correctedAfter: q.corrected_after, labels: q.labels });
    if (!d.drop) continue;
    await query('UPDATE hedwig_questions SET dropped_at = NOW(), drop_reason = $3 WHERE id = $1 AND user_id = $2 AND answered_at IS NULL', [q.id, userId, d.reason]);
    dropped++;
  }
  return dropped;
}

const toApi = (q) => ({ id: q.id, kind: q.kind, question: q.question, evidence: q.evidence, options: q.options, askedAt: q.asked_at });

/**
 * Today's questions: those already asked today and unanswered, topped up from the queue (marking
 * them asked) until labels.questionsPerDay have been asked today.
 */
export async function listOpenQuestions(userId) {
  const cfg = await getConfig(userId);
  const perDay = cfg['labels.questionsPerDay'];
  if (!perDay) return [];
  await settleOpen(userId);
  const { rows: [{ asked }] } = await query(
    `SELECT COUNT(*)::int AS asked FROM hedwig_questions WHERE user_id = $1 AND asked_at >= date_trunc('day', NOW())`,
    [userId],
  );
  const room = Math.max(0, perDay - asked);
  if (room > 0) {
    await query(
      `UPDATE hedwig_questions SET asked_at = NOW()
        WHERE id IN (SELECT id FROM hedwig_questions WHERE user_id = $1 AND asked_at IS NULL AND answered_at IS NULL AND dropped_at IS NULL
                      ORDER BY priority DESC, created_at LIMIT $2)`,
      [userId, room],
    );
  }
  const { rows } = await query(
    `SELECT * FROM hedwig_questions WHERE user_id = $1 AND asked_at >= date_trunc('day', NOW()) AND answered_at IS NULL AND dropped_at IS NULL
      ORDER BY priority DESC, asked_at LIMIT $2`,
    [userId, perDay],
  );
  return rows.map(toApi);
}

/** Read-only variant for the Brief: never marks anything asked. */
export async function peekOpenQuestions(userId) {
  const { rows } = await query(
    `SELECT * FROM hedwig_questions WHERE user_id = $1 AND asked_at >= date_trunc('day', NOW()) AND answered_at IS NULL AND dropped_at IS NULL
      ORDER BY priority DESC, asked_at LIMIT 3`,
    [userId],
  );
  return rows.map(toApi);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** What an option means for labels and for C's correction body. Pure. */
export function answerEffects(kind, optionId, evidence = {}) {
  switch (kind) {
    case 'stream':
      return { labels: [{ suite: 'sort', label: { stream: optionId } }], correction: { kind: 'sort', after: { stream: optionId } }, sort: { stream: optionId } };
    case 'needs_you': {
      const v = optionId === 'yes';
      return { labels: [{ suite: 'needs_you', label: { needs_you: v } }], correction: { kind: 'sort', after: { needs_you: v } }, sort: { needsYou: v } };
    }
    case 'spam': {
      const spam = optionId === 'spam';
      const labels = [{ suite: 'spam', label: { spam } }];
      if (evidence.inSpam) labels.push({ suite: 'rescue', label: { rescue: !spam } });
      // Sorting turns "clean" on mail in the spam folder into "rescued" itself.
      return { labels, correction: { kind: 'spam', after: { spam: spam ? 'suspected' : (evidence.inSpam ? 'rescued' : 'clean') } }, sort: { spam: spam ? 'suspected' : 'clean' } };
    }
    default: return null;
  }
}

export async function answerQuestionById(userId, id, { optionId, always } = {}) {
  const { rows } = await query('SELECT * FROM hedwig_questions WHERE id = $1 AND user_id = $2', [id, userId]);
  const q = rows[0];
  if (!q) throw httpError(404, 'Question not found');
  if (q.answered_at || q.dropped_at) throw httpError(409, 'Question already closed');
  const option = (q.options || []).find((o) => o.id === optionId);
  if (!option) throw httpError(400, 'Unknown option');
  const alwaysScope = always === true ? 'sender' : (['sender', 'list', 'kind'].includes(always) ? always : null);
  if (alwaysScope && !option.always) throw httpError(400, 'This option cannot be applied always');
  const effects = answerEffects(q.kind, optionId, q.evidence || {});
  const evidence = { rule: 'question', questionId: q.id, mid: q.evidence?.mid || null, answeredAt: new Date().toISOString(), always: alwaysScope };
  await upsertLabels(userId, effects.labels.map((l) => ({ ...l, targetId: q.target_id, grade: 'gold', source: 'question', evidence })));
  // Sorting's correction updates the message's sort decision and records hedwig_corrections (plus a
  // rule with `always`). Without sorting, "always" is queued for it and a plain answer is recorded
  // as a correction here.
  let applied;
  try {
    applied = await applySortCorrection(
      userId,
      { messageId: q.target_id, ...effects.sort, always: alwaysScope, note: 'Answered a Hedwig question' },
      { queueIfMissing: Boolean(alwaysScope) },
    );
  } catch (err) {
    // The gold label stands either way; the correction is still recorded below.
    console.warn(`[hedwig] labels: sorting could not apply the answer to ${q.target_id}:`, err.message);
    applied = { via: null };
  }
  if (applied.via === null) {
    await recordCorrection({
      userId, kind: effects.correction.kind, targetId: q.target_id, before: q.evidence?.models || null, after: effects.correction.after,
      note: 'Answered a Hedwig question', promptId: 'labels.question', promptVersion: null,
    });
  }
  await query(
    'UPDATE hedwig_questions SET answered_at = NOW(), answer = $3 WHERE id = $1 AND user_id = $2',
    [id, userId, JSON.stringify({ optionId, always: alwaysScope })],
  );
  return { ok: true, applied: applied.via };
}

export async function skipQuestion(userId, id) {
  const { rowCount } = await query(
    `UPDATE hedwig_questions SET dropped_at = NOW(), drop_reason = 'skipped' WHERE id = $1 AND user_id = $2 AND answered_at IS NULL AND dropped_at IS NULL`,
    [id, userId],
  );
  if (!rowCount) throw httpError(404, 'Question not found or already closed');
  return { ok: true };
}
