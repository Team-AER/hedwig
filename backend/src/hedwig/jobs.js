// Durable job queue and ledger on Postgres (FOR UPDATE SKIP LOCKED). No new infrastructure, survives
// restarts, and every job is inspectable in hedwig_jobs. Handlers are registered by kind; the worker
// process runs them with bounded concurrency and exponential backoff.
//
// Ledger states (hedwig_jobs.status, written on every transition):
//   queued → running → done | partial | (back to queued with backoff) | failed
//   failed → resolved   a later run of the same work succeeded, or rebuild() no longer lists it
//   failed → retried    retryFailed() enqueued a fresh job for it
//
//   defineJob(kind, handler, { timeoutMs, rebuild, needsGateway })
//   enqueue(kind, payload, { userId, dedupeKey, runAt, priority, maxAttempts })
//   handler returns { status: 'partial', note } for partial success; throwing = failed attempt
//   reconcile(), retryFailed(kind?), reapStuck(), healthGate(), queueStats()
//
// Deferral (queued again later, attempts untouched, last_error 'deferred: …'): the gateway is
// down (healthGate), a model lane stayed full past llm.lanes.<lane>.waitMs (lane_busy), or the
// handler threw deferJob() (e.g. a body fetch stepping aside for mail sync). A deferred job is
// waiting, not failing: it never lands in failed by morning for capacity other work holds.
import { createHash } from 'node:crypto';
import { hostname } from 'os';
import { query } from '../services/db.js';
import { getConfig } from './config.js';
import { runInContext } from './ledger/context.js';

const handlers = new Map(); // kind -> { handler, timeoutMs, rebuild, needsGateway }

/**
 * Thrown by a handler that should run later without spending an attempt (see deferJob).
 * `delayMs` is how long to wait; runJob puts the job back queued with run_at = now + delayMs.
 */
export class JobDeferred extends Error {
  constructor(reason, delayMs) {
    super(reason);
    this.name = 'JobDeferred';
    this.code = 'job_deferred';
    this.delayMs = Math.max(1000, Math.round(Number(delayMs) || 60_000));
  }
}

/** Stop this run and try again in `delayMs`, attempts untouched. Never returns. */
export function deferJob(reason, delayMs) {
  throw new JobDeferred(reason, delayMs);
}

export const JOB_STATES = ['queued', 'running', 'done', 'partial', 'failed', 'resolved', 'retried'];

/**
 * Register a job handler.
 * @param {string} kind
 * @param {(payload: object, job: object) => Promise<any>} handler  may return { status: 'partial', note }
 * @param {{ timeoutMs?: number, rebuild?: (userId: string|null) => Promise<object[]>, needsGateway?: boolean }} [opts]
 *   rebuild: the payloads this kind should have for a user right now; reconcile/retryFailed use it.
 *   needsGateway: the job cannot do anything without the model gateway; healthGate defers it
 *   while the gateway is unreachable. (Any job that fails because the gateway is down is deferred
 *   without losing an attempt either way.)
 */
export function defineJob(kind, handler, { timeoutMs = 10 * 60_000, rebuild = null, needsGateway = false } = {}) {
  if (handlers.has(kind)) throw new Error(`job kind ${kind} already defined`);
  if (typeof handler !== 'function') throw new Error(`job kind ${kind} needs a handler`);
  if (rebuild !== null && typeof rebuild !== 'function') throw new Error(`job kind ${kind}: rebuild must be a function`);
  handlers.set(kind, { handler, timeoutMs, rebuild, needsGateway: Boolean(needsGateway) });
}

export function definedJobs() {
  return [...handlers.keys()];
}

/** The in-code job kind registry, for the admin page. */
export function jobKinds() {
  return [...handlers.entries()].map(([kind, d]) => ({ kind, timeoutMs: d.timeoutMs, rebuild: Boolean(d.rebuild), needsGateway: d.needsGateway }));
}

/**
 * Enqueue a job. With a dedupeKey, a pending job with the same key is not duplicated.
 * @returns {Promise<number|null>} job id, or null when deduplicated
 */
export async function enqueue(kind, payload = {}, { userId = null, dedupeKey = null, runAt = null, priority = 5, maxAttempts = 5 } = {}) {
  const { rows } = await query(
    `INSERT INTO hedwig_jobs (kind, payload, user_id, dedupe_key, run_at, priority, max_attempts, status)
     VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), $6, $7, 'queued')
     ON CONFLICT (dedupe_key) WHERE done_at IS NULL AND failed_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [kind, JSON.stringify(payload), userId, dedupeKey, runAt, priority, maxAttempts],
  );
  return rows[0]?.id ?? null;
}

const WORKER_ID = `${hostname()}:${process.pid}`;

// A running job's lock is honoured for its kind's timeout plus this margin. Its handler is aborted
// at the timeout (runJob), so a lock older than this belongs to a worker that died.
const LOCK_MARGIN_SEC = 60;

/** Seconds a lock of each kind this process knows is honoured: its timeoutMs plus the margin. */
function lockSeconds() {
  return Object.fromEntries([...handlers.entries()].map(([k, d]) => [k, Math.ceil(d.timeoutMs / 1000) + LOCK_MARGIN_SEC]));
}

/**
 * Claim up to `limit` ready jobs whose kind has a handler in this process. A job still locked by a
 * run that started less than its kind's timeout (plus the margin) ago is never claimed again.
 */
export async function claim(limit) {
  const kinds = [...handlers.keys()];
  if (!kinds.length || limit <= 0) return [];
  const { rows } = await query(
    `UPDATE hedwig_jobs j SET locked_at = NOW(), locked_by = $3, attempts = attempts + 1, status = 'running'
      WHERE j.id IN (
        SELECT id FROM hedwig_jobs
         WHERE done_at IS NULL AND failed_at IS NULL AND run_at <= NOW()
           AND kind = ANY($1::text[])
           AND (locked_at IS NULL OR locked_at < NOW() - make_interval(secs => ($4::jsonb ->> kind)::int))
         ORDER BY priority, run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING j.*`,
    [kinds, limit, WORKER_ID, JSON.stringify(lockSeconds())],
  );
  return rows;
}

/**
 * Mark a job finished. `status` is 'done' or 'partial'; tokens are the model usage of the run.
 */
export async function complete(id, { status = 'done', note = null, tokensIn = 0, tokensOut = 0 } = {}) {
  await query(
    `UPDATE hedwig_jobs SET done_at = NOW(), locked_at = NULL, last_error = NULL, status = $2, note = $3,
            tokens_in = tokens_in + $4, tokens_out = tokens_out + $5
      WHERE id = $1`,
    [id, status === 'partial' ? 'partial' : 'done', note ? String(note).slice(0, 1000) : null, tokensIn | 0, tokensOut | 0],
  );
}

export async function fail(job, err, { tokensIn = 0, tokensOut = 0 } = {}) {
  const message = String(err?.message || err).slice(0, 1000);
  const permanent = err?.permanent === true || job.attempts >= job.max_attempts;
  // Budget exhaustion is not a failure: retry after midnight instead of burning attempts.
  if (err?.code === 'budget_exceeded') {
    await query(
      `UPDATE hedwig_jobs SET locked_at = NULL, attempts = GREATEST(attempts - 1, 0), last_error = $2, status = 'queued',
              tokens_in = tokens_in + $3, tokens_out = tokens_out + $4,
              run_at = date_trunc('day', NOW()) + INTERVAL '1 day' + INTERVAL '5 minutes' WHERE id = $1`,
      [job.id, message, tokensIn | 0, tokensOut | 0],
    );
    return;
  }
  if (permanent) {
    await query(
      `UPDATE hedwig_jobs SET failed_at = NOW(), locked_at = NULL, last_error = $2, status = 'failed',
              tokens_in = tokens_in + $3, tokens_out = tokens_out + $4 WHERE id = $1`,
      [job.id, message, tokensIn | 0, tokensOut | 0],
    );
    return;
  }
  const backoffSec = Math.min(3600, 15 * 2 ** (job.attempts - 1));
  await query(
    `UPDATE hedwig_jobs SET locked_at = NULL, last_error = $2, status = 'queued', run_at = NOW() + ($3 || ' seconds')::interval,
            tokens_in = tokens_in + $4, tokens_out = tokens_out + $5 WHERE id = $1`,
    [job.id, message, String(backoffSec), tokensIn | 0, tokensOut | 0],
  );
}

/**
 * Put a job back without consuming the attempt its claim took (the gateway was down, a lane stayed
 * full, or the handler deferred itself).
 */
async function defer(job, delayMs, reason, { tokensIn = 0, tokensOut = 0 } = {}) {
  await query(
    `UPDATE hedwig_jobs SET locked_at = NULL, attempts = GREATEST(attempts - 1, 0), status = 'queued',
            last_error = $2, run_at = NOW() + ($3 || ' seconds')::interval,
            tokens_in = tokens_in + $4, tokens_out = tokens_out + $5 WHERE id = $1`,
    [job.id, String(reason).slice(0, 1000), String(Math.max(1, Math.round(delayMs / 1000))), tokensIn | 0, tokensOut | 0],
  );
}

// ── Gateway health ─────────────────────────────────────────────────────────────
// A job that fails only because the model gateway is unreachable should wait, not burn attempts
// and land in "failed" by morning. healthGate() probes periodically; runJob consults the result and
// re-probes when a handler fails with a gateway-shaped error.
let gateway = { ok: true, checkedAt: 0, error: null };

export function gatewayHealth() {
  return { ...gateway };
}

async function probe() {
  const { probeGateway } = await import('./llm.js');
  const r = await probeGateway();
  gateway = { ok: r.ok, checkedAt: Date.now(), error: r.ok ? null : r.error };
  return r;
}

function gatewayShaped(err) {
  if (!err) return false;
  if (['budget_exceeded', 'llm_disabled', 'user_required', 'invalid_output', 'unknown_prompt'].includes(err.code)) return false;
  if (err.name === 'LlmError' || err.name === 'PromptOutputError') return (err.status || 0) >= 500;
  return err.name === 'TimeoutError' || /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(err.message || '');
}

/**
 * Probe the gateway; while it is unreachable, push queued gateway-dependent jobs back by
 * jobs.healthDeferMin minutes without touching their attempts.
 * @returns {Promise<{ ok: boolean, deferred: number, error?: string }>}
 */
export async function healthGate() {
  const r = await probe();
  if (r.ok) return { ok: true, deferred: 0 };
  const kinds = [...handlers.entries()].filter(([, d]) => d.needsGateway).map(([k]) => k);
  if (!kinds.length) return { ok: false, deferred: 0, error: r.error };
  const cfg = await getConfig();
  const { rowCount } = await query(
    `UPDATE hedwig_jobs SET run_at = NOW() + ($2 || ' minutes')::interval, last_error = $3
      WHERE done_at IS NULL AND failed_at IS NULL AND locked_at IS NULL AND run_at <= NOW() + ($2 || ' minutes')::interval
        AND kind = ANY($1::text[])`,
    [kinds, String(cfg['jobs.healthDeferMin']), `deferred: model gateway unreachable (${r.error})`.slice(0, 1000)],
  );
  if (rowCount) console.warn(`[hedwig] model gateway unreachable (${r.error}); deferred ${rowCount} job(s) by ${cfg['jobs.healthDeferMin']} min`);
  return { ok: false, deferred: rowCount || 0, error: r.error };
}

async function deferMinutes() {
  const cfg = await getConfig().catch(() => null);
  return cfg?.['jobs.healthDeferMin'] ?? 10;
}

async function laneDeferMinutes() {
  const cfg = await getConfig().catch(() => null);
  return cfg?.['jobs.laneDeferMin'] ?? 5;
}

/** Push a running job's lock forward by `ms` (the time its handler spent waiting for a lane slot). */
async function extendLock(job, ms) {
  await query(
    `UPDATE hedwig_jobs SET locked_at = locked_at + make_interval(secs => $2::double precision)
      WHERE id = $1 AND locked_at IS NOT NULL AND done_at IS NULL AND failed_at IS NULL`,
    [job.id, ms / 1000],
  ).catch((err) => console.warn(`[hedwig] job ${job.kind}#${job.id}: could not extend its lock:`, err?.message || err));
}

/**
 * The job timeout clock. It runs while the handler works and pauses while any of the job's model
 * calls waits for a lane slot (llm.js takeLane calls pause/resume through the ambient context):
 * waiting for capacity other work holds is not the job being slow. Each pause pushes the deadline
 * out by the wait. The job's lock is pushed out too (onExtend), so claim() and reapStuck() keep
 * honouring it for as long as the handler may legitimately run: every `heartbeatMs` while the wait
 * lasts (a background wait may be 20 min, far past a short kind's lock), and for the remainder when
 * a wait of a second or more ends.
 */
export function jobClock(timeoutMs, onTimeout, onExtend = () => {}, { heartbeatMs = 30_000 } = {}) {
  let timer = null; let deadline = 0; let depth = 0; let pausedAt = 0; let stopped = true;
  let beat = null; let extendedTo = 0;
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(onTimeout, Math.max(0, ms)); };
  const stopBeat = () => { clearInterval(beat); beat = null; };
  return {
    start() { stopped = false; deadline = Date.now() + timeoutMs; arm(timeoutMs); },
    pause() {
      if (stopped) return;
      if (depth++ === 0) {
        pausedAt = Date.now(); extendedTo = pausedAt; clearTimeout(timer);
        beat = setInterval(() => { const t = Date.now(); onExtend(t - extendedTo); extendedTo = t; }, heartbeatMs);
        beat.unref?.();
      }
    },
    resume() {
      if (stopped || depth === 0) return;
      if (--depth > 0) return;
      stopBeat();
      const now = Date.now();
      const waited = now - pausedAt;
      deadline += waited;
      arm(deadline - now);
      if (waited >= 1000 && now > extendedTo) onExtend(now - extendedTo);
    },
    stop() { stopped = true; clearTimeout(timer); stopBeat(); },
  };
}

/**
 * Run one claimed job. Exported for tests.
 *
 * The handler gets `(payload, job, { signal })`. The signal aborts when the job times out; it is
 * also carried in the ambient context, so every chat()/runPrompt() call the handler makes is
 * aborted with it even when the handler does not pass it on. Lane waits do not count against the
 * timeout (see jobClock).
 */
export async function runJob(job) {
  const def = handlers.get(job.kind);
  if (!def) { await fail({ ...job, attempts: job.max_attempts }, new Error(`no handler for ${job.kind}`)); return; }
  if (def.needsGateway && !gateway.ok) {
    const deferMin = await deferMinutes();
    if (Date.now() - gateway.checkedAt < deferMin * 60_000) {
      await defer(job, deferMin * 60_000, `deferred: model gateway unreachable (${gateway.error})`);
      return;
    }
  }
  const usage = { id: job.id, tokensIn: 0, tokensOut: 0 };
  const controller = new AbortController();
  const clock = jobClock(
    def.timeoutMs,
    () => controller.abort(Object.assign(new Error(`job timed out after ${def.timeoutMs} ms`), { code: 'job_timeout' })),
    (ms) => { extendLock(job, ms); },
  );
  try {
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    const timedOut = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    clock.start();
    const result = await runInContext({ lane: 'background', job: usage, signal: controller.signal, laneWait: clock }, () => Promise.race([
      def.handler(payload || {}, job, { signal: controller.signal }),
      timedOut,
    ]));
    const partial = result && typeof result === 'object' && result.status === 'partial';
    await complete(job.id, { status: partial ? 'partial' : 'done', note: partial ? (result.note || null) : null, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
  } catch (err) {
    const spent = { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut };
    // The handler asked to run later (e.g. a body fetch yielding to mail sync): waiting, not failing.
    if (err?.code === 'job_deferred') {
      await defer(job, err.delayMs, `deferred: ${err.message}`, spent);
      return;
    }
    // A model lane stayed full for its whole wait (llm.lanes.<lane>.waitMs): capacity other work
    // holds is not this job failing, so it waits its turn again instead of spending an attempt.
    if (err?.code === 'lane_busy') {
      const min = await laneDeferMinutes();
      console.warn(`[hedwig] job ${job.kind}#${job.id} deferred ${min} min: ${err.message}`);
      await defer(job, min * 60_000, `deferred: ${err.message}`, spent);
      return;
    }
    if (gatewayShaped(err)) {
      const r = await probe().catch(() => ({ ok: true }));
      if (!r.ok) {
        console.warn(`[hedwig] job ${job.kind}#${job.id} deferred: model gateway unreachable (${r.error})`);
        await defer(job, (await deferMinutes()) * 60_000, `deferred: model gateway unreachable (${r.error})`, spent);
        return;
      }
    }
    if (err?.code !== 'budget_exceeded' && err?.code !== 'llm_disabled') {
      console.warn(`[hedwig] job ${job.kind}#${job.id} failed (attempt ${job.attempts}):`, err?.message || err);
    }
    if (err?.code === 'llm_disabled') err.permanent = true;
    await fail(job, err, { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
  } finally {
    clock.stop();
  }
}

// ── Ledger maintenance ─────────────────────────────────────────────────────────

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

function payloadOf(row) {
  return typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
}

function rebuildKey(kind, payload) {
  return `rb:${kind}:${createHash('sha1').update(canonical(payload)).digest('hex')}`;
}

async function failedRows(kind = null) {
  const { rows } = await query(
    `SELECT id, kind, payload, user_id, dedupe_key, priority, max_attempts, failed_at
       FROM hedwig_jobs WHERE status = 'failed' AND ($1::text IS NULL OR kind = $1) ORDER BY id`,
    [kind],
  );
  return rows;
}

function groupByUser(rows) {
  const out = new Map();
  for (const r of rows) {
    const k = r.user_id || null;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

async function setStatus(ids, status, note) {
  if (!ids.length) return 0;
  const { rowCount } = await query(
    `UPDATE hedwig_jobs SET status = $2, note = COALESCE($3, note) WHERE id = ANY($1::bigint[]) AND status = 'failed'`,
    [ids, status, note],
  );
  return rowCount || 0;
}

/**
 * failed → resolved when a later run of the same work succeeded (same dedupe key, or same kind,
 * user and payload), or when the kind's rebuild() no longer lists the payload.
 * @returns {Promise<{ resolved: number }>}
 */
export async function reconcile() {
  const { rowCount } = await query(
    `UPDATE hedwig_jobs f SET status = 'resolved', note = 'a later run succeeded'
      WHERE f.status = 'failed' AND EXISTS (
        SELECT 1 FROM hedwig_jobs s
         WHERE s.kind = f.kind AND s.id <> f.id AND s.status IN ('done', 'partial') AND s.done_at > f.failed_at
           AND ((f.dedupe_key IS NOT NULL AND s.dedupe_key = f.dedupe_key)
             OR (s.user_id IS NOT DISTINCT FROM f.user_id AND s.payload = f.payload)))`,
  );
  let resolved = rowCount || 0;
  for (const [kind, def] of handlers) {
    if (!def.rebuild) continue;
    const rows = await failedRows(kind);
    for (const [userId, list] of groupByUser(rows)) {
      let wanted;
      try {
        wanted = new Set((await def.rebuild(userId) || []).map(canonical));
      } catch (err) {
        console.warn(`[hedwig] rebuild for ${kind} failed during reconcile:`, err?.message || err);
        continue;
      }
      const gone = list.filter((r) => !wanted.has(canonical(payloadOf(r)))).map((r) => r.id);
      resolved += await setStatus(gone, 'resolved', 'no longer needed (rebuild)');
    }
  }
  return { resolved };
}

/**
 * Re-enqueue failed work. Kinds with rebuild() are re-enqueued from it (per user with failed rows),
 * so the new jobs reflect what is needed now; others get a fresh copy of each failed job. Old rows
 * become retried (or resolved when rebuild() no longer lists them).
 * @param {string} [kind]
 * @returns {Promise<{ retried: number, enqueued: number, resolved: number }>}
 */
export async function retryFailed(kind = null) {
  const rows = await failedRows(kind);
  let retried = 0; let enqueued = 0; let resolved = 0;
  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  for (const [k, list] of byKind) {
    const def = handlers.get(k);
    if (def?.rebuild) {
      for (const [userId, userRows] of groupByUser(list)) {
        let payloads;
        try {
          payloads = await def.rebuild(userId) || [];
        } catch (err) {
          console.warn(`[hedwig] rebuild for ${k} failed:`, err?.message || err);
          continue;
        }
        const byCanon = new Map(userRows.map((r) => [canonical(payloadOf(r)), r]));
        const wanted = new Set();
        for (const payload of payloads) {
          const c = canonical(payload);
          wanted.add(c);
          const old = byCanon.get(c);
          const id = await enqueue(k, payload, {
            userId, dedupeKey: old?.dedupe_key || rebuildKey(k, payload), priority: old?.priority ?? 5, maxAttempts: old?.max_attempts ?? 5,
          });
          if (id) enqueued++;
        }
        retried += await setStatus(userRows.filter((r) => wanted.has(canonical(payloadOf(r)))).map((r) => r.id), 'retried', null);
        resolved += await setStatus(userRows.filter((r) => !wanted.has(canonical(payloadOf(r)))).map((r) => r.id), 'resolved', 'no longer needed (rebuild)');
      }
    } else {
      for (const r of list) {
        const id = await enqueue(k, payloadOf(r), { userId: r.user_id, dedupeKey: r.dedupe_key, priority: r.priority, maxAttempts: r.max_attempts });
        if (id) enqueued++;
        retried += await setStatus([r.id], 'retried', null);
      }
    }
  }
  return { retried, enqueued, resolved };
}

/**
 * Running jobs whose lock is older than their kind's timeout (plus a minute), or jobs.reapAfterMin
 * for kinds this process does not know, go back to queued. The attempt stays spent, so a job that
 * keeps hanging a worker still ends up failed. Run it only in the worker, which defines every job
 * kind (ledger/schedules.js); the API process would reap long kinds it does not know after
 * jobs.reapAfterMin while they are still running.
 * @returns {Promise<{ reaped: number }>}
 */
export async function reapStuck() {
  const cfg = await getConfig();
  const timeouts = lockSeconds();
  const { rowCount } = await query(
    `UPDATE hedwig_jobs SET locked_at = NULL, locked_by = NULL,
            status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            failed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
            last_error = 'stuck: running past its timeout; requeued by the reaper'
      WHERE done_at IS NULL AND failed_at IS NULL AND locked_at IS NOT NULL
        AND locked_at < NOW() - make_interval(secs => COALESCE(($1::jsonb ->> kind)::int, $2::int * 60))`,
    [JSON.stringify(timeouts), cfg['jobs.reapAfterMin']],
  );
  if (rowCount) console.warn(`[hedwig] reaped ${rowCount} stuck job(s)`);
  return { reaped: rowCount || 0 };
}

/** Queue health for the admin UI: counts by kind and ledger status. */
export async function queueStats() {
  const { rows } = await query(
    `SELECT kind,
            COUNT(*) FILTER (WHERE done_at IS NULL AND failed_at IS NULL) AS pending,
            COUNT(*) FILTER (WHERE locked_at IS NOT NULL AND done_at IS NULL AND failed_at IS NULL) AS running,
            COUNT(*) FILTER (WHERE status = 'failed' AND failed_at > NOW() - INTERVAL '24 hours') AS failed_24h,
            COUNT(*) FILTER (WHERE done_at > NOW() - INTERVAL '24 hours') AS done_24h,
            COUNT(*) FILTER (WHERE done_at IS NULL AND failed_at IS NULL AND locked_at IS NULL AND last_error LIKE 'deferred:%') AS deferred,
            COUNT(*) FILTER (WHERE status = 'queued' OR (status IS NULL AND done_at IS NULL AND failed_at IS NULL AND locked_at IS NULL)) AS s_queued,
            COUNT(*) FILTER (WHERE status = 'running' OR (status IS NULL AND done_at IS NULL AND failed_at IS NULL AND locked_at IS NOT NULL)) AS s_running,
            COUNT(*) FILTER (WHERE status = 'done' OR (status IS NULL AND done_at IS NOT NULL)) AS s_done,
            COUNT(*) FILTER (WHERE status = 'partial') AS s_partial,
            COUNT(*) FILTER (WHERE status = 'failed' OR (status IS NULL AND failed_at IS NOT NULL)) AS s_failed,
            COUNT(*) FILTER (WHERE status = 'resolved') AS s_resolved,
            COUNT(*) FILTER (WHERE status = 'retried') AS s_retried,
            COALESCE(SUM(tokens_in), 0) AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            (ARRAY_AGG(last_error ORDER BY failed_at DESC) FILTER (WHERE status = 'failed'))[1] AS last_error
       FROM hedwig_jobs
      WHERE created_at > NOW() - INTERVAL '7 days' OR status = 'failed'
      GROUP BY kind ORDER BY kind`,
  );
  return rows.map((r) => ({
    kind: r.kind,
    pending: Number(r.pending) || 0,
    running: Number(r.running) || 0,
    failed_24h: Number(r.failed_24h) || 0,
    done_24h: Number(r.done_24h) || 0,
    deferred: Number(r.deferred) || 0,
    last_error: r.last_error || null,
    tokens_in: Number(r.tokens_in) || 0,
    tokens_out: Number(r.tokens_out) || 0,
    status: Object.fromEntries(JOB_STATES.map((s) => [s, Number(r[`s_${s}`]) || 0])),
  }));
}

/** Failed rows (still failed), newest first, for the admin list. */
export async function listFailed({ kind = null, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id, kind, user_id, payload, dedupe_key, attempts, max_attempts, last_error, note, created_at, failed_at, tokens_in, tokens_out
       FROM hedwig_jobs WHERE status = 'failed' AND ($1::text IS NULL OR kind = $1)
      ORDER BY failed_at DESC NULLS LAST, id DESC LIMIT $2`,
    [kind, Math.max(1, Math.min(500, Number(limit) || 50))],
  );
  return rows;
}

/** Delete finished jobs older than `days`. Rows still failed are kept until reconciled or retried. */
export async function pruneJobs(days = 7) {
  await query(
    `DELETE FROM hedwig_jobs
      WHERE (done_at < NOW() - ($1 || ' days')::interval)
         OR (failed_at < NOW() - ($1 || ' days')::interval AND COALESCE(status, 'failed') <> 'failed')
         OR (failed_at < NOW() - ($1 || ' days')::interval * 4)`,
    [String(days)],
  );
}

export function _resetJobs() {
  handlers.clear();
  gateway = { ok: true, checkedAt: 0, error: null };
}
