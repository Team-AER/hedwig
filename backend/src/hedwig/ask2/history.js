// Saved answers: the Ask history returns each answer with its numbered sources, so the UI shows a
// past answer instead of asking again; "wrong answer" feedback becomes a correction and a gold label.
import { query } from '../../services/db.js';
import { loadMessagesLite } from '../context/shapes.js';
import { httpError, isUuid } from '../context/util.js';

const COLS = `id, question, created_at, completed_at, status, answer, citations, sources, unsupported, not_found,
  follow_up_of, plan, feedback, entity_id, topic_id, model`;

function shape(row, lite) {
  const ids = Array.isArray(row.sources) ? row.sources : [];
  return {
    id: row.id,
    question: row.question,
    created_at: row.created_at,
    completed_at: row.completed_at,
    status: row.status,
    answer: row.answer,
    citations: Array.isArray(row.citations) ? row.citations : [],
    // n is the position in the stored list, which is the numbering the answer cites.
    sources: ids.map((id, i) => ({ n: i + 1, message: lite.get(id) || null })).filter((s) => s.message),
    unsupported: row.unsupported ?? null,
    notFound: row.not_found ?? null,
    followUpOf: row.follow_up_of || null,
    entityId: row.entity_id || null,
    topicId: row.topic_id || null,
    feedback: row.feedback || null,
    plan: row.plan || null,
    model: row.model || null,
    // Answered by the fallback model while Tier 2 was degraded (null for answers saved before this was kept).
    lighterModel: typeof row.plan?.answer?.lighterModel === 'boolean' ? row.plan.answer.lighterModel : null,
  };
}

async function liteFor(userId, rows) {
  const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.sources) ? r.sources : [])).filter(isUuid))];
  return new Map((await loadMessagesLite(userId, ids, { dedupe: false })).map((m) => [m.id, m]));
}

/** Newest first. Each entry: { id, question, created_at, status, answer, citations, sources: [{ n, message }], … }. */
export async function askHistory(userId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT ${COLS} FROM hedwig_ask_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(200, Number(limit) || 50))],
  );
  const lite = await liteFor(userId, rows);
  return rows.map((r) => shape(r, lite));
}

export async function getAnswer(userId, id) {
  if (!isUuid(id)) throw httpError(400, 'invalid id');
  const { rows } = await query(`SELECT ${COLS} FROM hedwig_ask_log WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) return null;
  return shape(rows[0], await liteFor(userId, rows));
}

/**
 * The user marked an answer wrong (or right again). D's answerFeedback writes the gold label and the
 * correction (kind 'answer'); the mark is kept on the log row so the history shows it.
 */
export async function answerFeedback(userId, id, { wrong = true, note = null } = {}) {
  if (!isUuid(id)) throw httpError(400, 'invalid id');
  const { rows } = await query('SELECT id FROM hedwig_ask_log WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) throw httpError(404, 'Answer not found');
  const cleanNote = note == null || note === '' ? null : String(note).slice(0, 1000);
  const labels = await import('../labels/askTriples.js');
  await labels.answerFeedback(userId, { askLogId: id, wrong: Boolean(wrong), note: cleanNote });
  const feedback = { wrong: Boolean(wrong), note: cleanNote, at: new Date().toISOString() };
  await query('UPDATE hedwig_ask_log SET feedback = $3 WHERE id = $1 AND user_id = $2', [id, userId, JSON.stringify(feedback)]);
  return { ok: true, feedback };
}
