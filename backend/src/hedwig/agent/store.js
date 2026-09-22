// Persistence for agent runs and actions. Every read and write is scoped by user_id, so a run or an
// action id from another user behaves exactly like one that does not exist.
import { query } from '../../services/db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

export const RUN_STATUSES = ['queued', 'running', 'done', 'error', 'cancelled'];
// A run left 'running' by a crashed process can be continued after this long.
export const STALE_RUN_MS = 15 * 60_000;

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function toAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    tool: row.tool,
    args: row.args || {},
    summary: row.summary,
    status: row.status,
    result: row.result ?? null,
    created_at: row.created_at,
    decided_at: row.decided_at || null,
  };
}

export function toRunSummary(row) {
  return { id: row.id, title: row.title, status: row.status, trigger: row.trigger, automation_id: row.automation_id, created_at: row.created_at, updated_at: row.updated_at };
}

export function toRun(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    trigger: row.trigger,
    automation_id: row.automation_id,
    messages: row.messages || [],
    steps: row.steps || [],
    result: row.result,
    error: row.error,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createRun(userId, { trigger = 'chat', automationId = null, title = null, status = 'queued' } = {}) {
  const { rows } = await query(
    `INSERT INTO hedwig_agent_runs (user_id, trigger, automation_id, title, status) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, trigger, automationId, title ? String(title).slice(0, 200) : null, status],
  );
  return rows[0];
}

export async function getRunRow(userId, runId) {
  if (!isUuid(runId)) return null;
  const { rows } = await query('SELECT * FROM hedwig_agent_runs WHERE id = $1 AND user_id = $2', [runId, userId]);
  return rows[0] || null;
}

/**
 * Take a run for execution: only one execution at a time, but a run whose owner process died
 * (still 'running' long after its last write) can be taken over.
 */
export async function claimRun(userId, runId) {
  const { rows } = await query(
    `UPDATE hedwig_agent_runs SET status = 'running', error = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
        AND (status <> 'running' OR updated_at < NOW() - make_interval(secs => $3::int))
      RETURNING *`,
    [runId, userId, Math.round(STALE_RUN_MS / 1000)],
  );
  return rows[0] || null;
}

/**
 * Append messages and steps and add token counts, atomically. Appending (rather than rewriting the
 * arrays) keeps notes that action approvals add concurrently.
 */
export async function appendToRun(userId, runId, { messages = [], steps = [], promptTokens = 0, completionTokens = 0, status = null, result, error } = {}) {
  await query(
    `UPDATE hedwig_agent_runs
        SET messages = messages || $3::jsonb,
            steps = steps || $4::jsonb,
            prompt_tokens = prompt_tokens + $5,
            completion_tokens = completion_tokens + $6,
            status = COALESCE($7, status),
            result = CASE WHEN $8 THEN $9 ELSE result END,
            error = CASE WHEN $10 THEN $11 ELSE error END,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [runId, userId, JSON.stringify(messages), JSON.stringify(steps), promptTokens || 0, completionTokens || 0, status,
      result !== undefined, result ?? null, error !== undefined, error ?? null],
  );
}

export async function listRuns(userId, { limit = 30 } = {}) {
  const n = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 30));
  const { rows } = await query(
    `SELECT id, title, status, trigger, automation_id, created_at, updated_at FROM hedwig_agent_runs
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, n],
  );
  return rows.map(toRunSummary);
}

export async function insertAction(userId, runId, { tool, args, summary }) {
  const { rows } = await query(
    `INSERT INTO hedwig_agent_actions (run_id, user_id, tool, args, summary, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
    [runId, userId, tool, JSON.stringify(args || {}), String(summary || tool).slice(0, 500)],
  );
  return rows[0];
}

export async function getActionRow(userId, actionId) {
  if (!isUuid(actionId)) return null;
  const { rows } = await query('SELECT * FROM hedwig_agent_actions WHERE id = $1 AND user_id = $2', [actionId, userId]);
  return rows[0] || null;
}

export async function listActions(userId, { status = null, runId = null, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT * FROM hedwig_agent_actions
      WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR run_id = $3)
      ORDER BY created_at DESC LIMIT $4`,
    [userId, status, runId, Math.min(500, Math.max(1, limit))],
  );
  return rows.map(toAction);
}

/** Move an action from one status to another; null when it was not in `from` (someone else won). */
export async function transitionAction(userId, actionId, from, to, result) {
  const { rows } = await query(
    `UPDATE hedwig_agent_actions
        SET status = $4, decided_at = CASE WHEN $3 = 'pending' THEN NOW() ELSE decided_at END,
            result = CASE WHEN $5 THEN $6::jsonb ELSE result END
      WHERE id = $1 AND user_id = $2 AND status = $3
      RETURNING *`,
    [actionId, userId, from, to, result !== undefined, result === undefined ? null : JSON.stringify(result)],
  );
  return rows[0] || null;
}
