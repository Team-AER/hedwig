// Durable job queue on Postgres (FOR UPDATE SKIP LOCKED). No new infrastructure, survives restarts,
// and every job is inspectable in hedwig_jobs. Handlers are registered by kind; the worker process
// runs them with bounded concurrency and exponential backoff.
import { hostname } from 'os';
import { query } from '../services/db.js';

const handlers = new Map(); // kind -> { handler, timeoutMs }

/**
 * Register a job handler.
 * @param {string} kind
 * @param {(payload: object, job: object) => Promise<any>} handler
 * @param {{ timeoutMs?: number }} [opts]
 */
export function defineJob(kind, handler, { timeoutMs = 10 * 60_000 } = {}) {
  if (handlers.has(kind)) throw new Error(`job kind ${kind} already defined`);
  handlers.set(kind, { handler, timeoutMs });
}

export function definedJobs() {
  return [...handlers.keys()];
}

/**
 * Enqueue a job. With a dedupeKey, a pending job with the same key is not duplicated.
 * @returns {Promise<number|null>} job id, or null when deduplicated
 */
export async function enqueue(kind, payload = {}, { userId = null, dedupeKey = null, runAt = null, priority = 5, maxAttempts = 5 } = {}) {
  const { rows } = await query(
    `INSERT INTO hedwig_jobs (kind, payload, user_id, dedupe_key, run_at, priority, max_attempts)
     VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), $6, $7)
     ON CONFLICT (dedupe_key) WHERE done_at IS NULL AND failed_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [kind, JSON.stringify(payload), userId, dedupeKey, runAt, priority, maxAttempts],
  );
  return rows[0]?.id ?? null;
}

const WORKER_ID = `${hostname()}:${process.pid}`;

/** Claim up to `limit` ready jobs whose kind has a handler in this process. */
export async function claim(limit) {
  const kinds = [...handlers.keys()];
  if (!kinds.length || limit <= 0) return [];
  const { rows } = await query(
    `UPDATE hedwig_jobs j SET locked_at = NOW(), locked_by = $3, attempts = attempts + 1
      WHERE j.id IN (
        SELECT id FROM hedwig_jobs
         WHERE done_at IS NULL AND failed_at IS NULL AND run_at <= NOW()
           AND kind = ANY($1::text[])
           AND (locked_at IS NULL OR locked_at < NOW() - INTERVAL '15 minutes')
         ORDER BY priority, run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING j.*`,
    [kinds, limit, WORKER_ID],
  );
  return rows;
}

export async function complete(id) {
  await query('UPDATE hedwig_jobs SET done_at = NOW(), locked_at = NULL, last_error = NULL WHERE id = $1', [id]);
}

export async function fail(job, err) {
  const message = String(err?.message || err).slice(0, 1000);
  const permanent = err?.permanent === true || job.attempts >= job.max_attempts;
  // Budget exhaustion is not a failure: retry after midnight instead of burning attempts.
  if (err?.code === 'budget_exceeded') {
    await query(
      `UPDATE hedwig_jobs SET locked_at = NULL, attempts = GREATEST(attempts - 1, 0), last_error = $2,
              run_at = date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '5 minutes' WHERE id = $1`,
      [job.id, message],
    );
    return;
  }
  if (permanent) {
    await query('UPDATE hedwig_jobs SET failed_at = NOW(), locked_at = NULL, last_error = $2 WHERE id = $1', [job.id, message]);
    return;
  }
  const backoffSec = Math.min(3600, 15 * 2 ** (job.attempts - 1));
  await query(
    `UPDATE hedwig_jobs SET locked_at = NULL, last_error = $2, run_at = NOW() + ($3 || ' seconds')::interval WHERE id = $1`,
    [job.id, message, String(backoffSec)],
  );
}

/** Run one claimed job. Exported for tests. */
export async function runJob(job) {
  const def = handlers.get(job.kind);
  if (!def) { await fail({ ...job, attempts: job.max_attempts }, new Error(`no handler for ${job.kind}`)); return; }
  let timer;
  try {
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    await Promise.race([
      def.handler(payload || {}, job),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`job timed out after ${def.timeoutMs} ms`)), def.timeoutMs); }),
    ]);
    await complete(job.id);
  } catch (err) {
    if (err?.code !== 'budget_exceeded' && err?.code !== 'llm_disabled') {
      console.warn(`[hedwig] job ${job.kind}#${job.id} failed (attempt ${job.attempts}):`, err?.message || err);
    }
    if (err?.code === 'llm_disabled') err.permanent = true;
    await fail(job, err);
  } finally {
    clearTimeout(timer);
  }
}

/** Queue health for the admin UI. */
export async function queueStats() {
  const { rows } = await query(
    `SELECT kind,
            COUNT(*) FILTER (WHERE done_at IS NULL AND failed_at IS NULL) AS pending,
            COUNT(*) FILTER (WHERE locked_at IS NOT NULL AND done_at IS NULL AND failed_at IS NULL) AS running,
            COUNT(*) FILTER (WHERE failed_at > NOW() - INTERVAL '24 hours') AS failed_24h,
            COUNT(*) FILTER (WHERE done_at > NOW() - INTERVAL '24 hours') AS done_24h,
            MAX(last_error) FILTER (WHERE failed_at > NOW() - INTERVAL '24 hours') AS last_error
       FROM hedwig_jobs
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY kind ORDER BY kind`,
  );
  return rows.map((r) => ({ ...r, pending: Number(r.pending), running: Number(r.running), failed_24h: Number(r.failed_24h), done_24h: Number(r.done_24h) }));
}

/** Delete finished jobs older than `days`. */
export async function pruneJobs(days = 7) {
  await query(`DELETE FROM hedwig_jobs WHERE (done_at < NOW() - ($1 || ' days')::interval) OR (failed_at < NOW() - ($1 || ' days')::interval)`, [String(days)]);
}

export function _resetJobs() { handlers.clear(); }
