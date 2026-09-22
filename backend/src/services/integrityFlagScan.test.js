// How the folder integrity pass decides to get flag state.
//
// Measured against the production PurelyMail INBOX that had never once completed an
// integrity check (34,159 messages, 60 second budget):
//
//   connect + login          394ms
//   SELECT INBOX             177ms
//   UID SEARCH ALL        11,541ms   <- the whole membership
//   FETCH 1:* flags      119,251ms for the first 5,000  -> ~13.5 min for all of them
//   FETCH CHANGEDSINCE     3,132ms   <- only what changed
//
// So the pass was not flaky, it was arithmetically impossible, and each attempt spent a
// full minute of real FETCH load on the server before throwing the result away.

import { describe, it, expect, vi } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { planIntegrityFlagScan } from './imapManager.js';

const BIG = 34159;   // the folder from the report
const SMALL = 800;

describe('planIntegrityFlagScan', () => {
  it('fetches only what changed when CONDSTORE and a baseline are both available', () => {
    expect(planIntegrityFlagScan({
      condstore: true, storedModseq: '108000', serverModseq: '108244', exists: BIG,
    })).toBe('changedsince');
  });

  it('fetches nothing when the server modseq matches our checkpoint', () => {
    expect(planIntegrityFlagScan({
      condstore: true, storedModseq: '108244', serverModseq: '108244', exists: BIG,
    })).toBe('unchanged');
  });

  it('never asks a large folder for every flag when it has no baseline', () => {
    // This is the bug. A full scan here is the 13.5 minute fetch inside a 60s budget.
    expect(planIntegrityFlagScan({
      condstore: true, storedModseq: null, serverModseq: '108244', exists: BIG,
    })).toBe('skip');
    expect(planIntegrityFlagScan({
      condstore: false, storedModseq: null, serverModseq: null, exists: BIG,
    })).toBe('skip');
  });

  it('still scans a small folder in full, where it is affordable', () => {
    expect(planIntegrityFlagScan({
      condstore: false, storedModseq: null, serverModseq: null, exists: SMALL,
    })).toBe('full');
    expect(planIntegrityFlagScan({
      condstore: true, storedModseq: null, serverModseq: '5', exists: SMALL,
    })).toBe('full');
  });

  it('falls back to a full scan on a server that cannot do CONDSTORE, if it is small', () => {
    // A baseline is meaningless without CONDSTORE, so the stored value must not be trusted.
    expect(planIntegrityFlagScan({
      condstore: false, storedModseq: '108000', serverModseq: '108244', exists: SMALL,
    })).toBe('full');
  });

  it('asks for nothing at all in an empty folder', () => {
    expect(planIntegrityFlagScan({
      condstore: true, storedModseq: null, serverModseq: '1', exists: 0,
    })).toBe('unchanged');
  });

  it('handles modseq values that exceed a 32 bit integer', () => {
    // HIGHESTMODSEQ is a 63 bit counter; comparing these as Numbers loses precision.
    expect(planIntegrityFlagScan({
      condstore: true, storedModseq: '9007199254740993', serverModseq: '9007199254740993', exists: BIG,
    })).toBe('unchanged');
    expect(planIntegrityFlagScan({
      condstore: true, storedModseq: '9007199254740993', serverModseq: '9007199254740994', exists: BIG,
    })).toBe('changedsince');
  });

  it('respects an explicit affordability threshold', () => {
    const at = (exists, cheapScanMax) => planIntegrityFlagScan({
      condstore: false, storedModseq: null, serverModseq: null, exists, cheapScanMax,
    });
    expect(at(100, 100)).toBe('full');
    expect(at(101, 100)).toBe('skip');
  });
});

// ── The safety property the cheap path depends on ────────────────────────────
//
// A pass that skipped the full scan has only ONE view of the UID set (SEARCH, cross-checked
// against the count from SELECT). That is enough to detect a gap and schedule a backfill,
// which is non-destructive. It is NOT enough to prune cached rows: an expunge plus an
// arrival between SELECT and SEARCH leaves the count unchanged while the set differs, which
// is exactly the case the two-view check exists to catch.

import { ImapManager, createKeyedSemaphore } from './imapManager.js';
import { query } from './db.js';

function managerFor({ uids, exists, condstore, storedModseq, localUids }) {
  const lock = { release: vi.fn() };
  const client = {
    mailbox: { exists, uidValidity: 8n, highestModseq: 999n },
    capabilities: condstore ? new Map([['CONDSTORE', true]]) : new Map(),
    getMailboxLock: async () => lock,
    search: async () => uids,
    fetch: async function* () { /* changedsince: nothing changed */ },
  };
  // Clear the call history, not just the implementation: assertions below search every
  // recorded call, and a previous test's checkpoint would otherwise be found first.
  query.mockClear();
  query.mockImplementation(async (sql) => {
    if (sql.includes('status_synced_modseq FROM folders')) return { rows: [{ status_synced_modseq: storedModseq }] };
    if (sql.includes('FROM messages')) return { rows: localUids.map(uid => ({ uid: String(uid), synced_at: null })) };
    if (sql.includes('unfetchable_uids')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
  const mgr = Object.assign(Object.create(ImapManager.prototype), {
    _withCountClient: async (_a, fn) => fn(client),
    syncMessages: vi.fn().mockResolvedValue({}),
    _applyFlagUpdates: vi.fn().mockResolvedValue(0),
    _isMoveUidGuarded: () => false,
    broadcast: vi.fn(), backfillMessages: vi.fn(), _bgConnSem: createKeyedSemaphore(2),
  });
  return mgr;
}

describe('a pass without the full scan', () => {
  const acct = { id: 'acct', user_id: 'u', imap_host: 'imap.example.com' };
  const observed = { uidValidity: 8n, uidNext: 20, highestModseq: 999n };

  it('never deletes cached rows, even when a row looks absent from the server', async () => {
    // Server holds {1}; we cached {1, 2}. On a full-scan pass uid 2 would be pruned. Here
    // the snapshot is uncorroborated, so pruning must not happen.
    const mgr = managerFor({
      uids: [1], exists: 1, condstore: true, storedModseq: '500', localUids: [1, 2],
    });
    await mgr._refreshObservedFolder(acct, 'INBOX', observed);
    const deletes = query.mock.calls.filter(([sql]) => /^DELETE/i.test(sql.trim()));
    expect(deletes).toHaveLength(0);
  });

  it('still detects a gap and schedules a backfill, which is the non-destructive half', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Server holds {1,2}; we cached {1}. That gap is real and must still be acted on.
    const mgr = managerFor({
      uids: [1, 2], exists: 2, condstore: true, storedModseq: '500', localUids: [1],
    });
    await mgr._refreshObservedFolder(acct, 'INBOX', observed);
    expect(mgr.backfillMessages).toHaveBeenCalledWith(acct, 'INBOX');
  });
});

describe('the flag watermark', () => {
  const acct = { id: 'acct', user_id: 'u', imap_host: 'imap.example.com' };
  const observed = { uidValidity: 8n, uidNext: 20, highestModseq: 999n };
  const modseqOf = () => {
    const call = query.mock.calls.find(([sql]) => sql.includes('status_synced_modseq=$5'));
    return call ? call[1][4] : undefined;
  };

  it('is seeded on a skipped folder, so later passes can use the cheap path', async () => {
    // A large folder with no baseline skips the scan. If the watermark were withheld here
    // it would stay null forever, and CHANGEDSINCE (the whole point of this change, 3s
    // against 13.5 minutes) could never engage for the folder that needs it most.
    const uids = Array.from({ length: 2001 }, (_, i) => i + 1);
    const mgr = managerFor({ uids, exists: uids.length, condstore: true, storedModseq: null, localUids: uids });
    await mgr._refreshObservedFolder(acct, 'INBOX', observed);
    expect(modseqOf()).toBe('999');
  });

  it('is withheld when a full scan was cut short, so the range is retried', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uids = [1, 2, 3];
    const mgr = managerFor({ uids, exists: 3, condstore: false, storedModseq: null, localUids: uids });
    // A scan that never finishes: the sub-budget must abandon it rather than fail the pass.
    mgr._withCountClient = async (_a, fn) => fn({
      mailbox: { exists: 3, uidValidity: 8n, highestModseq: 999n },
      capabilities: new Map(),
      getMailboxLock: async () => ({ release: vi.fn() }),
      search: async () => uids,
      // Hangs forever: the sub-budget must abandon it. The unreachable yield is only
      // there because an async generator without one is a lint error.
      fetch: async function* () { await new Promise(() => {}); yield null; },
    });
    const pass = mgr._refreshObservedFolder(acct, 'INBOX', observed);
    await vi.advanceTimersByTimeAsync(25000);
    await pass;

    // Membership was still verified, so no gap and no backfill...
    expect(mgr.backfillMessages).not.toHaveBeenCalled();
    // ...nothing was pruned, because there was no corroborated snapshot...
    expect(query.mock.calls.filter(([sql]) => /^DELETE/i.test(sql.trim()))).toHaveLength(0);
    // ...and the watermark did not move, so the next pass retries these flags.
    expect(modseqOf()).toBeNull();
    vi.useRealTimers();
  });
});
