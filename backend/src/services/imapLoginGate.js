// Which logins a provider will take from us right now, per account.
//
// After a restart on 2 October 2026, Yahoo answered the reconnect burst with
// `NO [UNAVAILABLE] AUTHENTICATE Server error - Please try again later`, and went on refusing
// every login except the live sync connection's for as long as Hedwig kept asking. Hedwig
// kept asking: a mark-read retried every 30 s, the folder status monitor every minute, the
// staleness probe every three, and on each reconnect the pool pre-warm plus one backfill login
// per folder. Four refused logins a minute is what keeps a provider's throttle shut.
//
// The live connection's backoff (ImapManager._connectCooldown) did not help. Only some of those
// paths consulted it, and it was cleared every five minutes, when Yahoo cut the live session as
// it always does and the reconnect got through. So the ladder never climbed past 30 s.
//
// The gate covers every login except the live sync connection's:
// - A refused login closes it for 1 min, doubling to 30 min. Refusals of the live login count.
// - While it is closed, a login fails at once with LoginDeferredError and sends nothing.
// - When the wait is over, one login goes first; the others are deferred until it is answered.
// - Only one of these logins succeeding opens it again. The live login succeeding proves
//   nothing about a second session: Yahoo accepted every live reconnect while refusing the rest.
//
// While the gate is closed, withFreshClient runs the user's own actions on the live
// connection, so marking read, moving and opening mail keep working. Background work waits.

export const LOGIN_BACKOFF_BASE_MS = 60 * 1000;
export const LOGIN_BACKOFF_MAX_MS = 30 * 60 * 1000;
// A refusal older than this says nothing about the provider now: the next one starts over at 1 min.
export const LOGIN_REFUSAL_MEMORY_MS = 2 * 60 * 60 * 1000;
// How long the other logins wait for the one that goes first after a backoff.
export const LOGIN_PROBE_WAIT_MS = 15 * 1000;
// A first login unanswered for this long is presumed lost; the next caller may go instead.
// Comfortably above connectImapClient's 30 s timeout plus its IPv4 retry.
const PROBE_STALE_MS = 2 * 60 * 1000;

export function loginBackoffMs(failures) {
  // Guarded like authCooldownMs: NaN would make `now < until` false and silently reopen the gate.
  const n = Number.isFinite(failures) ? Math.max(1, failures) : 1;
  return Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 10), LOGIN_BACKOFF_MAX_MS);
}

export class LoginDeferredError extends Error {
  constructor(retryInMs, reason) {
    super(`Provider is refusing new IMAP logins${reason ? ` (${reason})` : ''}; next attempt in ${Math.ceil(retryInMs / 1000)}s`);
    this.name = 'LoginDeferredError';
    this.code = 'LOGIN_DEFERRED';
    this.retryInMs = retryInMs;
  }
}

export function isLoginDeferred(err) {
  return err?.code === 'LOGIN_DEFERRED';
}

export class LoginGate {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._state = new Map(); // accountId -> { failures, until, refusedAt, detail, probeAt }
  }

  // True from the first refusal until a login gets through, including the wait for the first try.
  refusing(accountId) {
    return this._state.has(accountId);
  }

  // How long a login must still wait: 0 when one may be tried now.
  waitMs(accountId) {
    const s = this._state.get(accountId);
    if (!s) return 0;
    const now = this._now();
    if (now < s.until) return s.until - now;
    if (s.probeAt != null && now - s.probeAt < PROBE_STALE_MS) return LOGIN_PROBE_WAIT_MS;
    return 0;
  }

  // Throws LoginDeferredError when a login may not be tried now. Reserves nothing.
  check(accountId) {
    const wait = this.waitMs(accountId);
    if (wait > 0) throw new LoginDeferredError(wait, this._state.get(accountId)?.detail);
  }

  // Call immediately before logging in. Throws LoginDeferredError, or returns the time the
  // attempt started, which refused() uses to tell a new refusal from the rest of a burst.
  admit(accountId) {
    this.check(accountId);
    const now = this._now();
    const s = this._state.get(accountId);
    if (s) s.probeAt = now; // this login goes first; the rest wait for its answer
    return now;
  }

  // The provider refused a login, ours or the live connection's. startedAt is admit()'s value;
  // a login sent before the latest refusal is the same burst and does not lengthen the wait.
  // ladder maps the refusal count to a wait: a rejected password takes the much longer one the
  // live connection uses (authCooldownMs), so extra logins never retry it more often than it does.
  // Returns { ms, failures, escalated }.
  refused(accountId, detail, startedAt = this._now(), { ladder = loginBackoffMs } = {}) {
    const now = this._now();
    const prev = this._state.get(accountId);
    if (prev && startedAt < prev.refusedAt) {
      return { ms: Math.max(0, prev.until - now), failures: prev.failures, escalated: false };
    }
    const fresh = !prev || now - prev.refusedAt > LOGIN_REFUSAL_MEMORY_MS;
    const failures = fresh ? 1 : prev.failures + 1;
    const ms = Math.max(ladder(failures), loginBackoffMs(failures));
    this._state.set(accountId, { failures, until: now + ms, refusedAt: now, detail: detail || null, probeAt: null });
    return { ms, failures, escalated: true };
  }

  // A gated login got through: the gate opens. Returns how many refusals that ends (0 if none).
  admitted(accountId) {
    const s = this._state.get(accountId);
    if (!s) return 0;
    this._state.delete(accountId);
    return s.failures;
  }

  // A login failed for a reason that is not the provider refusing (DNS, TLS, a dropped socket).
  // That answers nothing about the throttle, so let the next caller try.
  settled(accountId) {
    const s = this._state.get(accountId);
    if (s) s.probeAt = null;
  }

  // A human changed the account (new password, new server): retry at once.
  clear(accountId) {
    this._state.delete(accountId);
  }

  // For diagnostics: null when the gate is open.
  status(accountId) {
    const s = this._state.get(accountId);
    if (!s) return null;
    return { failures: s.failures, retryInMs: this.waitMs(accountId), refusedAt: s.refusedAt, detail: s.detail };
  }
}

// One gate per process; every login path in imapManager uses this instance.
export const loginGate = new LoginGate();
