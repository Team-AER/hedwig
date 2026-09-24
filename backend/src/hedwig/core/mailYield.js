// Hedwig's own IMAP fetches (message bodies, attachment text) step aside for mail.
//
// Mail reliability wins every trade-off (ARCHITECTURE.md §Principles). The upstream engine already
// paces itself around a provider that pushes back: a per-account refusal cooldown after
// "Connection not available" / [LIMIT] / "try again later", a host-level backoff for its snippet
// indexer, and flags for the syncs, backfills, folder checks and connects it has in flight. A
// background body fetch that ignores all that takes a pooled connection at exactly the moment the
// provider is refusing them, and the sync is what loses (Yahoo, overnight: 17 body-fetch refusals,
// 12 account cooldowns, 11 failed syncs in 8 hours).
//
// So every Hedwig fetch goes through guardedFetch():
//   1. per-account Hedwig backoff (hedwig_state 'index.fetchBackoff:<accountId>') still running → defer
//   2. upstream busy for the account (below) → defer
//   3. index.bodyConcurrency Hedwig fetches already in flight for the account → defer briefly
//   4. fetch. A refusal-shaped error arms or extends the per-account backoff (1, 2, 4, 8, 15 min
//      cap), pushes the account's queued fetches behind it, and defers the job; a success clears it.
// Deferring = jobs.js deferJob(): the job goes back to 'deferred' with run_at pushed out and its attempt
// refunded, recorded as 'deferred: …' like the gateway health gate does. It is not a failure.
//
// Upstream state is read, never written, straight off the ImapManager instance (the same way
// sort/spamMove.js uses its move guards); no upstream file changes. If a future upstream merge
// renames those fields, upstreamBusy() says so once in the log rather than silently never yielding.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { getState, setState } from '../state.js';
import { deferJob } from '../jobs.js';

export const BODY_JOB = 'mail.fetchBody';
export const ATTACHMENT_JOB = 'index.attachmentText';
export const FETCH_KINDS = [BODY_JOB, ATTACHMENT_JOB];

const BACKOFF_KEY = 'index.fetchBackoff:';
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const QUIET_AFTER_USER_MS = 30_000; // someone opening messages gets the connections to themselves
// A message the server refuses this many times in a row (while others may succeed) spends a real
// attempt, so one message the server will never return cannot keep an account's queue parked forever.
export const MAX_REFUSALS_PER_MESSAGE = 5;

// ── Provider and rate ─────────────────────────────────────────────────────────

/**
 * The provider name upstream's providerProfile() would pick for an account (same host tests; kept
 * in step by core/mailYield.test.js). Used for index.bodyRateByProvider. Pure.
 */
export function providerOf({ imap_host: imapHost, oauth_provider: oauthProvider } = {}) {
  const host = String(imapHost || '').toLowerCase();
  if (host.includes('.gmail.com') || host.includes('.googlemail.com')) return 'google';
  if (host.includes('.yahoo.com') || host.includes('.ymail.com')) return 'yahoo';
  if (host.includes('.icloud.com') || host.includes('.apple.com') || host.includes('.me.com')) return 'apple';
  if (host.includes('.outlook.com') || host.includes('office365.com') || host.includes('outlook.office.com') || host.includes('.hotmail.com') || host.includes('.live.com') || oauthProvider === 'microsoft') return 'microsoft';
  if (host.includes('purelymail.com')) return 'purelymail';
  return 'generic';
}

/**
 * Fetches per second for one mail host: index.bodyRateByProvider[host] or [provider] when set,
 * else index.bodyRatePerSec. Fractions are fine (0.5 = one every 2 s). Pure.
 */
export function bodyRateFor(cfg, { host = '', provider = 'generic' } = {}) {
  const map = cfg['index.bodyRateByProvider'];
  const table = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  const own = [String(host).toLowerCase(), provider].map((k) => Number(table[k])).find((v) => Number.isFinite(v) && v > 0);
  const base = Number(cfg['index.bodyRatePerSec']);
  const rate = own ?? (Number.isFinite(base) && base > 0 ? base : 1);
  return Math.min(100, Math.max(0.01, rate));
}

// ── Upstream state ────────────────────────────────────────────────────────────

let warnedShape = false;

function hasAccountKey(set, accountId) {
  if (!(set instanceof Set)) return false;
  const prefix = `${accountId}:`;
  for (const k of set) if (typeof k === 'string' && k.startsWith(prefix)) return true;
  return false;
}

const jitter = (ms) => Math.round(ms * (1 + Math.random() * 0.2));

/**
 * Is the mail engine using, or protecting, this account's connections right now? Reads the
 * ImapManager instance only. Returns null when a Hedwig fetch may go ahead, else
 * `{ reason, retryMs }`.
 */
export function upstreamBusy(mgr, account, now = Date.now()) {
  if (!mgr || !account) return null;
  if (!(mgr._connectCooldown instanceof Map) || !(mgr.syncingAccounts instanceof Set)) {
    if (!warnedShape) {
      warnedShape = true;
      console.warn('[hedwig] body fetch cannot see the mail engine\'s sync state (ImapManager._connectCooldown / syncingAccounts missing); it will fetch without yielding to sync. Update core/mailYield.js.');
    }
  }
  const id = account.id;
  const host = String(account.imap_host || '').toLowerCase();
  const cd = mgr._connectCooldown?.get?.(id);
  if (cd && cd.until > now) return { reason: `the provider refused a connection (upstream cooldown, refusal #${cd.failures || 1})`, retryMs: jitter(cd.until - now) };
  const bo = mgr.snippetBackoff?.get?.(host);
  if (bo && bo.until > now) return { reason: 'the mail host is backing off after refusing the snippet indexer', retryMs: jitter(bo.until - now) };
  if (mgr.connectingAccounts?.has?.(id)) return { reason: 'the account is connecting', retryMs: jitter(30_000) };
  if (mgr.syncingAccounts?.has?.(id)) return { reason: 'mail sync is running', retryMs: jitter(15_000) };
  if (mgr.backfillAllRunning?.has?.(id) || hasAccountKey(mgr.backfillRunning, id)) return { reason: 'a folder backfill is running', retryMs: jitter(60_000) };
  if (hasAccountKey(mgr.onDemandSyncing, id)) return { reason: 'a folder sync is running', retryMs: jitter(15_000) };
  if (hasAccountKey(mgr._statusSyncRunning, id)) return { reason: 'a folder integrity sync is running', retryMs: jitter(30_000) };
  if (mgr.snippetIndexerRunning?.has?.(id)) return { reason: 'the snippet indexer is running', retryMs: jitter(60_000) };
  const opened = mgr.lastUserActivity?.get?.(id);
  if (opened && now - opened < QUIET_AFTER_USER_MS) return { reason: 'someone is opening messages', retryMs: jitter(QUIET_AFTER_USER_MS - (now - opened)) };
  return null;
}

// ── Per-account backoff ───────────────────────────────────────────────────────

/** Errors that mean "the server is at its limit, come back later", not "this message is broken". */
export function isMailBusyError(err) {
  return /\[LIMIT\]|\[UNAVAILABLE\]|\[INUSE\]|connection not available|too many|maximum number|number of connections|rate.?limit|temporarily|try again|connection limit|throttl|connect timeout|connections busy|cooldown active|pool evicted/i
    .test(String(err?.message || err || ''));
}

/** 1, 2, 4, 8, 15, 15 … minutes for consecutive refusals. Pure. */
export function fetchBackoffMs(failures) {
  const n = Number.isFinite(failures) ? Math.max(1, failures) : 1;
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 10), BACKOFF_MAX_MS);
}

export async function getFetchBackoff(accountId) {
  return getState(BACKOFF_KEY + accountId, null);
}

/** Every account's backoff, for the planner and /admin/health: Map accountId → state. */
export async function fetchBackoffs() {
  const { rows } = await query('SELECT key, value FROM hedwig_state WHERE key LIKE $1', [`${BACKOFF_KEY}%`]);
  return new Map(rows.map((r) => [r.key.slice(BACKOFF_KEY.length), typeof r.value === 'string' ? JSON.parse(r.value) : r.value]));
}

export async function clearFetchBackoff(accountId) {
  await query('DELETE FROM hedwig_state WHERE key = $1', [BACKOFF_KEY + accountId]);
}

/**
 * Push the account's queued (not running) body and attachment fetches to start after `untilMs`,
 * spaced at `rate` per second in their current order, so the queue resumes at its pace instead of
 * all at once. Attempts are untouched.
 */
export async function pushQueueBack(accountId, untilMs, rate, reason) {
  const step = 1 / Math.max(0.01, rate);
  const { rowCount } = await query(
    `UPDATE hedwig_jobs j SET run_at = $2::timestamptz + s.rn * make_interval(secs => $3::double precision), last_error = $4
       FROM (SELECT q.id, row_number() OVER (ORDER BY q.priority, q.run_at, q.id) AS rn
               FROM hedwig_jobs q
               JOIN messages m ON m.id = CASE WHEN q.payload->>'messageId' ~* '^[0-9a-f-]{36}$' THEN (q.payload->>'messageId')::uuid END
              WHERE q.kind = ANY($1::text[]) AND q.done_at IS NULL AND q.failed_at IS NULL AND q.locked_at IS NULL
                AND m.account_id = $5) s
      WHERE j.id = s.id AND j.run_at < $2::timestamptz + s.rn * make_interval(secs => $3::double precision)`,
    [FETCH_KINDS, new Date(untilMs).toISOString(), step, `deferred: ${reason}`.slice(0, 1000), accountId],
  );
  return rowCount || 0;
}

/** A refusal: arm or extend the account's backoff and push its queue behind it. */
export async function noteFetchRefused(accountId, err, { rate = 1, now = Date.now() } = {}) {
  const prev = await getFetchBackoff(accountId);
  const failures = (prev?.failures || 0) + 1;
  const ms = fetchBackoffMs(failures);
  const until = now + ms;
  const error = String(err?.message || err || 'refused').slice(0, 300);
  const state = { failures, until: new Date(until).toISOString(), error, at: new Date(now).toISOString() };
  await setState(BACKOFF_KEY + accountId, state);
  await pushQueueBack(accountId, until, rate, `mail server pushed back ("${error}"); backing off ${Math.round(ms / 60_000)} min`);
  console.warn(`[hedwig] body fetch: mail server pushed back on account ${accountId} ("${error}"); backing off ${Math.round(ms / 60_000)} min (refusal #${failures})`);
  return { ...state, untilMs: until, ms };
}

// ── The guard ─────────────────────────────────────────────────────────────────

const inflight = new Map();  // accountId -> Hedwig fetches running in this (API) process
const refusals = new Map();  // `${kind}:${messageId}` -> consecutive refusals

/**
 * Run one Hedwig IMAP fetch for `account` only when mail sync can spare it (see the file comment).
 * Throws JobDeferred (via deferJob) when it should run later; any other error is the fetch's own.
 */
export async function guardedFetch({ imapManager, account, kind = BODY_JOB, messageId = null, now = Date.now() }, run) {
  const cfg = await getConfig();
  const host = String(account.imap_host || account.id || '').toLowerCase();
  const rate = bodyRateFor(cfg, { host, provider: providerOf(account) });
  const backoff = await getFetchBackoff(account.id);
  const backoffUntil = backoff?.until ? new Date(backoff.until).getTime() : 0;
  if (backoffUntil > now) {
    deferJob(`account backing off after the mail server pushed back ("${backoff.error}", refusal #${backoff.failures})`, backoffUntil - now + 1000);
  }
  const busy = upstreamBusy(imapManager, account, now);
  if (busy) {
    await pushQueueBack(account.id, now + busy.retryMs, rate, `mail first: ${busy.reason}`);
    deferJob(`mail first: ${busy.reason}`, busy.retryMs);
  }
  const limit = Math.max(1, Number(cfg['index.bodyConcurrency']) || 1);
  if ((inflight.get(account.id) || 0) >= limit) {
    deferJob('another Hedwig fetch is in flight for this account', Math.max(2000, 1000 / rate));
  }
  const key = `${kind}:${messageId}`;
  inflight.set(account.id, (inflight.get(account.id) || 0) + 1);
  try {
    const out = await run();
    refusals.delete(key);
    if (backoff) await clearFetchBackoff(account.id);
    return out;
  } catch (err) {
    if (!isMailBusyError(err)) throw err;
    const state = await noteFetchRefused(account.id, err, { rate });
    const n = (refusals.get(key) || 0) + 1;
    if (n >= MAX_REFUSALS_PER_MESSAGE) {
      refusals.delete(key);
      throw err; // spends an attempt: after maxAttempts such rounds the message is marked failed
    }
    refusals.set(key, n);
    deferJob(`mail server pushed back ("${state.error}"); account backs off ${Math.round(state.ms / 60_000)} min`, state.ms + 1000);
  } finally {
    const left = (inflight.get(account.id) || 1) - 1;
    if (left > 0) inflight.set(account.id, left); else inflight.delete(account.id);
  }
  return undefined; // unreachable: deferJob throws
}

export function _resetMailYield() {
  inflight.clear();
  refusals.clear();
  warnedShape = false;
}
