// Commitments and facts: listing, user edits, and the overdue sweep.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { COMMITMENT_ORDER, COMMITMENT_SELECT, FACT_SELECT, toCommitment, toFact } from './shapes.js';
import { clampInt, endOfDayInZone, httpError } from './util.js';

export const COMMITMENT_STATUSES = ['open', 'done', 'dismissed'];
export const DIRECTIONS = ['i_owe', 'they_owe'];

// Low-confidence extractions stay stored but hidden, unless the user has touched them.
export const VISIBLE_COMMITMENT = '(c.user_edited OR c.confidence IS NULL OR c.confidence >= $MIN)';

export function visibleCommitment(paramIndex) {
  return VISIBLE_COMMITMENT.replace('$MIN', `$${paramIndex}`);
}

/** Commitment[] for a user. status: 'open' (default) | 'done' | 'dismissed' | 'all'. */
export async function listCommitments(userId, { status = 'open', direction = null, limit = 50, entityId = null, topicId = null } = {}) {
  if (status !== 'all' && !COMMITMENT_STATUSES.includes(status)) throw httpError(400, 'invalid status');
  if (direction && !DIRECTIONS.includes(direction)) throw httpError(400, 'invalid direction');
  const cfg = await getConfig(userId);
  const params = [userId, cfg['context.extractMinConfidence'], clampInt(limit, 1, 500, 50)];
  const where = ['c.user_id = $1', visibleCommitment(2)];
  if (status !== 'all') { params.push(status); where.push(`c.status = $${params.length}`); }
  if (direction) { params.push(direction); where.push(`c.direction = $${params.length}`); }
  if (entityId) { params.push(entityId); where.push(`c.counterparty_entity_id = $${params.length}`); }
  if (topicId) { params.push(topicId); where.push(`c.topic_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT ${COMMITMENT_SELECT} FROM hedwig_commitments c WHERE ${where.join(' AND ')} ORDER BY ${COMMITMENT_ORDER} LIMIT $3`,
    params,
  );
  return rows.map(toCommitment);
}

/** Apply a user edit. Returns the Commitment, or null when it is not this user's. */
export async function updateCommitment(userId, id, patch = {}) {
  const sets = [];
  const params = [id, userId];
  if (patch.status !== undefined) {
    if (!COMMITMENT_STATUSES.includes(patch.status)) throw httpError(400, 'invalid status');
    params.push(patch.status);
    const p = `$${params.length}`;
    sets.push(`status = ${p}`);
    sets.push(`resolved_at = CASE WHEN ${p} = 'open' THEN NULL WHEN status = 'open' THEN NOW() ELSE resolved_at END`);
    sets.push(`resolved_by_message_id = CASE WHEN ${p} = 'open' THEN NULL ELSE resolved_by_message_id END`);
    sets.push(`overdue_at = CASE WHEN ${p} = 'open' THEN overdue_at ELSE NULL END`);
  }
  if (patch.what !== undefined) {
    const what = typeof patch.what === 'string' ? patch.what.replace(/\s+/g, ' ').trim() : '';
    if (!what || what.length > 500) throw httpError(400, 'what must be 1-500 characters');
    params.push(what);
    sets.push(`what = $${params.length}`);
  }
  if (patch.due_at !== undefined) {
    let due = null;
    if (patch.due_at !== null && patch.due_at !== '') {
      // A bare date means the end of that day where the user is, as for extracted deadlines.
      due = typeof patch.due_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.due_at)
        ? endOfDayInZone(patch.due_at, (await getConfig(userId))['insights.timezone'])
        : new Date(patch.due_at);
      if (!due || Number.isNaN(due.getTime())) throw httpError(400, 'invalid due_at');
    }
    params.push(due);
    sets.push(`due_at = $${params.length}`, 'overdue_at = NULL');
  }
  if (!sets.length) throw httpError(400, 'nothing to update');
  sets.push('user_edited = true', 'updated_at = NOW()');
  const { rows } = await query(
    `UPDATE hedwig_commitments c SET ${sets.join(', ')} WHERE c.id = $1 AND c.user_id = $2 RETURNING ${COMMITMENT_SELECT}`,
    params,
  );
  return rows[0] ? toCommitment(rows[0]) : null;
}

/** Apply a user edit to a fact. Returns the Fact, or null when it is not this user's. */
export async function updateFact(userId, id, patch = {}) {
  const sets = [];
  const params = [id, userId];
  if (patch.value !== undefined) {
    const value = typeof patch.value === 'string' ? patch.value.trim() : '';
    if (!value || value.length > 1000) throw httpError(400, 'value must be 1-1000 characters');
    params.push(value);
    sets.push(`value = $${params.length}`, 'user_edited = true');
  }
  for (const key of ['dismissed', 'pinned']) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') throw httpError(400, `${key} must be a boolean`);
    params.push(patch[key]);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) throw httpError(400, 'nothing to update');
  sets.push('updated_at = NOW()');
  const { rows } = await query(
    `UPDATE hedwig_facts f SET ${sets.join(', ')} WHERE f.id = $1 AND f.user_id = $2 RETURNING ${FACT_SELECT}`,
    params,
  );
  return rows[0] ? toFact(rows[0]) : null;
}

/**
 * Stamp commitments that have just gone overdue, so other modules can react to the transition.
 * `overdue` in API responses is computed at read time and does not depend on this.
 */
export async function sweepOverdue() {
  const { rowCount } = await query(
    `UPDATE hedwig_commitments SET overdue_at = NOW()
      WHERE status = 'open' AND due_at IS NOT NULL AND due_at < NOW() AND overdue_at IS NULL`,
  );
  return rowCount;
}
