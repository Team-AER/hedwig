// Corrections: every time a person fixes something Hedwig decided (a sort, a Screener call, a spam
// verdict, a summary, an answer, an extraction, a topic, a card). Stream B owns the table; sorting
// and labels write to it; prompts read recent ones back as few-shot examples.
import { query } from '../../services/db.js';

export const CORRECTION_KINDS = ['sort', 'screener', 'spam', 'summary', 'answer', 'extraction', 'topic', 'card'];

const json = (v) => (v === undefined ? null : JSON.stringify(v));

/**
 * @param {{ userId: string, kind: string, targetId?: string, before?: any, after?: any, note?: string,
 *           promptId?: string, promptVersion?: string }} c
 * @returns {Promise<{ id: number, created_at: string }>}
 */
export async function recordCorrection({ userId, kind, targetId = null, before = null, after = null, note = null, promptId = null, promptVersion = null }) {
  if (!userId) throw Object.assign(new Error('recordCorrection needs a userId'), { status: 400 });
  if (!CORRECTION_KINDS.includes(kind)) throw Object.assign(new Error(`unknown correction kind ${kind}`), { status: 400 });
  const { rows } = await query(
    `INSERT INTO hedwig_corrections (user_id, kind, target_id, before, after, note, prompt_id, prompt_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [userId, kind, targetId == null ? null : String(targetId), json(before), json(after), note ? String(note).slice(0, 2000) : null, promptId, promptVersion],
  );
  return rows[0];
}

/**
 * The user's most recent corrections of a kind, newest first, for few-shot examples.
 * One per target (the latest), so a message corrected twice shows its final answer only.
 * @returns {Promise<Array<{ id, targetId, before, after, note, promptId, promptVersion, createdAt }>>}
 */
export async function recentCorrections(userId, kind, n = 5) {
  if (!userId) return [];
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (COALESCE(target_id, id::text)) id, target_id, before, after, note, prompt_id, prompt_version, created_at
         FROM hedwig_corrections
        WHERE user_id = $1 AND kind = $2
        ORDER BY COALESCE(target_id, id::text), created_at DESC
     ) latest
     ORDER BY created_at DESC
     LIMIT $3`,
    [userId, kind, Math.max(1, Math.min(100, Number(n) || 5))],
  );
  return rows.map((r) => ({
    id: r.id, targetId: r.target_id, before: r.before, after: r.after, note: r.note,
    promptId: r.prompt_id, promptVersion: r.prompt_version, createdAt: r.created_at,
  }));
}
