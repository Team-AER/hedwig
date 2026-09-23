// hedwig_sort_log: the "Hedwig today" record of what sorting did, and the basis for undo.
// Actions: screen (auto sender decision), decide (user sender decision), block, correct, rescue,
// spam_move, deliver (a bundle released), rule (a rule created from a correction).
import { query } from '../../services/db.js';

/** Append one entry. Returns the row. */
export async function writeLog(userId, { messageId = null, action, from = null, to = null, by = 'auto' }) {
  const { rows } = await query(
    `INSERT INTO hedwig_sort_log (user_id, message_id, action, "from", "to", by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, messageId, action, from === null ? null : JSON.stringify(from), to === null ? null : JSON.stringify(to), by],
  );
  return rows[0];
}

export async function getLog(userId, id) {
  const { rows } = await query('SELECT * FROM hedwig_sort_log WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

export async function markUndone(userId, id) {
  const { rows } = await query(
    'UPDATE hedwig_sort_log SET undone_at = NOW() WHERE id = $1 AND user_id = $2 AND undone_at IS NULL RETURNING *',
    [id, userId],
  );
  return rows[0] || null;
}

/** Entries since `since`, newest first, with the message subject and sender when there is one. */
export async function logSince(userId, since, { limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT l.id, l.message_id, l.action, l."from", l."to", l.by, l.undone_at, l.created_at,
            m.subject, m.from_name, m.from_email
       FROM hedwig_sort_log l LEFT JOIN messages m ON m.id = l.message_id
      WHERE l.user_id = $1 AND l.created_at >= $2
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $3`,
    [userId, since, limit],
  );
  return rows;
}
