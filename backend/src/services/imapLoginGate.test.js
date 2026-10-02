// The login gate on its own, with a hand-driven clock. imapLoginBackoff.test.js covers how the
// IMAP engine uses it.

import { describe, it, expect } from 'vitest';
import {
  LoginGate, LoginDeferredError, isLoginDeferred, loginBackoffMs,
  LOGIN_BACKOFF_BASE_MS, LOGIN_BACKOFF_MAX_MS, LOGIN_REFUSAL_MEMORY_MS, LOGIN_PROBE_WAIT_MS,
} from './imapLoginGate.js';

const YAHOO = '[UNAVAILABLE] AUTHENTICATE Server error - Please try again later';

function gateAt(start = 1_000_000) {
  const clock = { t: start };
  const gate = new LoginGate({ now: () => clock.t });
  return { gate, clock };
}

describe('loginBackoffMs', () => {
  it('starts at a minute and doubles to a 30 minute cap', () => {
    expect(loginBackoffMs(1)).toBe(LOGIN_BACKOFF_BASE_MS);
    expect(loginBackoffMs(2)).toBe(2 * LOGIN_BACKOFF_BASE_MS);
    expect(loginBackoffMs(5)).toBe(16 * LOGIN_BACKOFF_BASE_MS);
    expect(loginBackoffMs(6)).toBe(LOGIN_BACKOFF_MAX_MS);
    expect(loginBackoffMs(60)).toBe(LOGIN_BACKOFF_MAX_MS);
  });

  it('never returns zero or NaN, which would reopen the gate', () => {
    for (const n of [0, -3, NaN, undefined]) expect(loginBackoffMs(n)).toBe(LOGIN_BACKOFF_BASE_MS);
  });
});

describe('LoginGate', () => {
  it('lets logins through until the provider refuses one', () => {
    const { gate } = gateAt();
    expect(gate.refusing('a')).toBe(false);
    expect(gate.waitMs('a')).toBe(0);
    expect(() => gate.admit('a')).not.toThrow();
    expect(gate.admitted('a')).toBe(0);
  });

  it('holds every login back for a minute after a refusal, without sending anything', () => {
    const { gate, clock } = gateAt();
    const r = gate.refused('a', YAHOO, gate.admit('a'));
    expect(r).toEqual({ ms: LOGIN_BACKOFF_BASE_MS, failures: 1, escalated: true });
    clock.t += 30_000;
    let err;
    try { gate.admit('a'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LoginDeferredError);
    expect(isLoginDeferred(err)).toBe(true);
    expect(err.retryInMs).toBe(30_000);
    expect(err.message).toContain(YAHOO);
  });

  it('keeps accounts apart', () => {
    const { gate } = gateAt();
    gate.refused('yahoo', YAHOO);
    expect(() => gate.admit('gmail')).not.toThrow();
  });

  it('lets one login go first after the wait, and holds the rest until it is answered', () => {
    const { gate, clock } = gateAt();
    gate.refused('a', YAHOO);
    clock.t += LOGIN_BACKOFF_BASE_MS;
    const started = gate.admit('a');
    expect(() => gate.admit('a')).toThrow(LoginDeferredError);
    expect(gate.waitMs('a')).toBe(LOGIN_PROBE_WAIT_MS);

    // Refused again: the wait doubles.
    clock.t += 9_000; // Yahoo takes about 10 s to refuse
    expect(gate.refused('a', YAHOO, started)).toMatchObject({ failures: 2, ms: 2 * LOGIN_BACKOFF_BASE_MS });

    // Accepted: open for everyone.
    clock.t += 2 * LOGIN_BACKOFF_BASE_MS;
    gate.admit('a');
    expect(gate.admitted('a')).toBe(2);
    expect(gate.refusing('a')).toBe(false);
    expect(() => gate.admit('a')).not.toThrow();
  });

  it('does not count the rest of a burst as new refusals', () => {
    // Three logins sent together, all refused: one refusal, not three doublings.
    const { gate, clock } = gateAt();
    const t0 = gate.admit('a'), t1 = gate.admit('a'), t2 = gate.admit('a');
    clock.t += 10_000;
    expect(gate.refused('a', YAHOO, t0).escalated).toBe(true);
    clock.t += 1_000;
    expect(gate.refused('a', YAHOO, t1)).toMatchObject({ escalated: false, failures: 1 });
    expect(gate.refused('a', YAHOO, t2)).toMatchObject({ escalated: false, failures: 1 });
    expect(gate.waitMs('a')).toBe(LOGIN_BACKOFF_BASE_MS - 1_000);
  });

  it('counts a refusal of a login that started after the last one', () => {
    const { gate, clock } = gateAt();
    gate.refused('a', YAHOO);
    clock.t += LOGIN_BACKOFF_BASE_MS;
    const started = gate.admit('a');
    clock.t += 5_000;
    expect(gate.refused('a', YAHOO, started).failures).toBe(2);
  });

  it('lets the next login try when the first ended without an answer about the throttle', () => {
    const { gate, clock } = gateAt();
    gate.refused('a', YAHOO);
    clock.t += LOGIN_BACKOFF_BASE_MS;
    gate.admit('a');
    gate.settled('a'); // DNS failed, say
    expect(() => gate.admit('a')).not.toThrow();
    expect(gate.refusing('a')).toBe(true); // still not proven open
  });

  it('presumes a first login lost after two minutes', () => {
    const { gate, clock } = gateAt();
    gate.refused('a', YAHOO);
    clock.t += LOGIN_BACKOFF_BASE_MS;
    gate.admit('a');
    clock.t += 2 * 60_000;
    expect(() => gate.admit('a')).not.toThrow();
  });

  it('starts the ladder over when the last refusal is old news', () => {
    const { gate, clock } = gateAt();
    gate.refused('a', YAHOO);
    gate.refused('a', YAHOO);
    clock.t += LOGIN_REFUSAL_MEMORY_MS + 1;
    expect(gate.refused('a', YAHOO).failures).toBe(1);
  });

  it('waits as long as the live connection does after a rejected password', () => {
    const { gate } = gateAt();
    const auth = (n) => 5 * 60_000 * 2 ** (n - 1);
    expect(gate.refused('a', '[AUTHENTICATIONFAILED] Invalid credentials', undefined, { ladder: auth }).ms).toBe(5 * 60_000);
    // and never shorter than its own ladder, whatever ladder is passed
    expect(gate.refused('b', YAHOO, undefined, { ladder: () => 0 }).ms).toBe(LOGIN_BACKOFF_BASE_MS);
  });

  it('opens at once when a human changes the account', () => {
    const { gate } = gateAt();
    gate.refused('a', YAHOO);
    gate.clear('a');
    expect(gate.refusing('a')).toBe(false);
    expect(gate.status('a')).toBeNull();
  });

  it('reports its state for diagnostics', () => {
    const { gate, clock } = gateAt();
    gate.refused('a', YAHOO);
    clock.t += 15_000;
    expect(gate.status('a')).toMatchObject({ failures: 1, retryInMs: 45_000, detail: YAHOO });
  });
});
