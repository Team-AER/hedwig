// Yahoo refusing every login except the live connection's, and what the engine does about it.
//
// Production, 2 October 2026, after a restart: Yahoo accepted each live reconnect and answered
// every other login with `NO [UNAVAILABLE] AUTHENTICATE Server error - Please try again later`.
// One mark-read was retried every 30 s for 23 minutes, two logins a time, all refused; the user's
// move to Trash failed; the folder status monitor, the staleness probe, the pool pre-warm and a
// backfill login per folder kept asking too. imapLoginGate.js says why that kept the throttle shut.
//
// ImapFlow is mocked, so one constructor call is one login sent to the provider.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('./emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('./aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'p***@yahoo.com') }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('./spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('./mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));

import { ImapManager, acquirePooledClient, releasePooledClient, evictPool, authCooldownMs } from './imapManager.js';
import { loginGate, LOGIN_BACKOFF_BASE_MS } from './imapLoginGate.js';
import { ImapFlow } from 'imapflow';
import { query } from './db.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const yahoo = { id: 'y1', user_id: 'u1', email_address: 'p@yahoo.com', imap_host: 'imap.mail.yahoo.com', imap_port: 993, imap_tls: true, auth_user: 'p', auth_pass: 'enc', enabled: true };

// What Yahoo sent: TLS and the greeting were fine, AUTHENTICATE was not.
const refusal = () => Object.assign(new Error('Command failed'), {
  serverResponseCode: 'UNAVAILABLE', responseText: 'AUTHENTICATE Server error - Please try again later',
});

let logins; // { cfg, client } per ImapFlow constructed
let accept; // (cfg) => whether the provider takes this login

function fakeClient() {
  const c = Object.assign(new EventEmitter(), {
    usable: true,
    mailbox: { path: 'INBOX', exists: 1 },
    connect: vi.fn().mockResolvedValue(),
    logout: vi.fn().mockResolvedValue(),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    messageMove: vi.fn().mockResolvedValue({ uidMap: new Map([[7, 70]]) }),
    search: vi.fn().mockResolvedValue([1, 2]),
    status: vi.fn(),
  });
  c.getMailboxLock = vi.fn(async (path) => { c.mailbox = { path, exists: 1 }; return { release: vi.fn() }; });
  c.close = vi.fn(() => { if (c.usable) { c.usable = false; c.emit('close'); } });
  return c;
}

function setup({ withLive = true } = {}) {
  const mgr = new ImapManager(null);
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer', '_folderStatusTimer']) clearInterval(mgr[key]);
  mgr.broadcast = vi.fn();
  const live = withLive ? fakeClient() : null;
  if (live) mgr.connections.set(yahoo.id, live);
  return { mgr, live };
}

// The folder status monitor's own queries: one folder to check, and a sample revision.
function folderStatusQueries(extra = () => null) {
  query.mockImplementation(async (sql) => {
    const own = extra(sql);
    if (own) return own;
    if (/FROM folders f WHERE/.test(sql)) return { rows: [{ path: 'INBOX', cached_total: 0, cached_unread: 0 }] };
    if (/nextval\('folder_status_revision'\)/.test(sql)) return { rows: [{ revision: '1', started_at: new Date() }] };
    if (/FROM email_accounts/.test(sql)) return { rows: [yahoo] };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  loginGate.clear(yahoo.id);
  evictPool(yahoo.id);
  logins = [];
  // As on the day: the live login (IDLE enabled) gets through, every other login is refused.
  accept = (cfg) => cfg.maxIdleTime != null;
  query.mockReset();
  query.mockImplementation(async (sql) => ({ rows: /FROM email_accounts/.test(sql) ? [yahoo] : [] }));
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });
  resolveForConnection.mockResolvedValue({ host: '192.0.2.10', addresses: ['192.0.2.10'], servername: null });
  ImapFlow.mockImplementation(function (cfg) {
    const c = fakeClient();
    c.connect = vi.fn(() => (accept(cfg) ? Promise.resolve() : Promise.reject(refusal())));
    logins.push({ cfg, client: c });
    return c;
  });
  for (const m of ['log', 'warn', 'error']) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  evictPool(yahoo.id);
  loginGate.clear(yahoo.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('while Yahoo refuses every login but the live one', () => {
  it('sends one refused login, then marks read on the live connection without logging in', async () => {
    const { mgr, live } = setup();
    for (let i = 0; i < 10; i++) {
      await mgr.setFlag(yahoo, 4242, 'INBOX', '\\Seen', true).catch(() => {});
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(logins).toHaveLength(1);
    expect(live.messageFlagsAdd).toHaveBeenCalledTimes(10);
    expect(loginGate.refusing(yahoo.id)).toBe(true);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringMatching(/setFlag failed/), expect.anything());
  });

  it('moves to Trash on the live connection, and selects INBOX again for IDLE', async () => {
    const { mgr, live } = setup();
    loginGate.refused(yahoo.id, 'refused');
    await expect(mgr.moveMessage(yahoo, 7, 'Archive', 'Trash')).resolves.toBe(70);
    expect(logins).toHaveLength(0);
    expect(live.messageMove).toHaveBeenCalledWith('7', 'Trash', { uid: true });
    expect(live.getMailboxLock.mock.calls.map(c => c[0])).toEqual(['Archive', 'INBOX']);
    expect(live.mailbox.path).toBe('INBOX');
  });

  it('does not take new mail in a folder an action selected for new INBOX mail', async () => {
    const { mgr, live } = setup();
    mgr._attachIdleListeners(live, yahoo);
    const tick = vi.spyOn(mgr, '_syncTick').mockResolvedValue();
    live.emit('exists', { path: 'Trash', count: 12, prevCount: 11 });
    expect(tick).not.toHaveBeenCalled();
    expect(mgr.broadcast).not.toHaveBeenCalled();
    live.emit('exists', { path: 'INBOX', count: 320, prevCount: 319 });
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('never closes the live connection when an action on it fails', async () => {
    const { mgr, live } = setup();
    loginGate.refused(yahoo.id, 'refused');
    live.messageMove.mockRejectedValue(new Error('Command failed'));
    await expect(mgr.moveMessage(yahoo, 7, 'INBOX', 'Trash')).rejects.toThrow('Command failed');
    expect(live.close).not.toHaveBeenCalled();
    expect(live.logout).not.toHaveBeenCalled();
    expect(mgr.connections.get(yahoo.id)).toBe(live);
  });

  it('does not reopen for other logins when the live reconnect gets through', async () => {
    const { mgr, live } = setup();
    mgr.syncMessages = vi.fn().mockResolvedValue({ insertedCount: 0 });
    mgr.syncFolders = vi.fn().mockResolvedValue();
    mgr._syncSpamFolder = vi.fn().mockResolvedValue();
    mgr.syncIntervals.set(yahoo.id, 'scheduled');
    await mgr.setFlag(yahoo, 1, 'INBOX', '\\Seen', true).catch(() => {});
    expect(logins).toHaveLength(1);

    // Yahoo ends the live session at 300 s; the tick reconnects and Yahoo takes that login.
    live.usable = false;
    mgr.connections.delete(yahoo.id);
    await mgr._syncTick(yahoo);
    expect(logins).toHaveLength(2);
    const relogged = logins[1].client;
    expect(mgr.connections.get(yahoo.id)).toBe(relogged);

    expect(loginGate.refusing(yahoo.id)).toBe(true);
    await mgr.setFlag(yahoo, 2, 'INBOX', '\\Seen', true);
    expect(logins).toHaveLength(2);
    expect(relogged.messageFlagsAdd).toHaveBeenCalledTimes(1);
  });

  it('after the wait, lets one background login go first while the user carries on', async () => {
    const { mgr, live } = setup();
    await mgr.setFlag(yahoo, 1, 'INBOX', '\\Seen', true).catch(() => {});
    await vi.advanceTimersByTimeAsync(LOGIN_BACKOFF_BASE_MS);

    // Yahoo is slow to answer the first login after the wait.
    let answer;
    ImapFlow.mockImplementationOnce(function (cfg) {
      const c = fakeClient();
      c.connect = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
      logins.push({ cfg, client: c });
      return c;
    });
    const background = acquirePooledClient(yahoo);
    await vi.advanceTimersByTimeAsync(0);
    expect(logins).toHaveLength(2);

    await mgr.setFlag(yahoo, 2, 'INBOX', '\\Seen', true);
    await expect(acquirePooledClient(yahoo)).rejects.toMatchObject({ code: 'LOGIN_DEFERRED' });
    expect(logins).toHaveLength(2);
    expect(live.messageFlagsAdd).toHaveBeenCalledTimes(2);

    answer(); // accepted: logins are open again, and the pool serves the user
    const pooled = await background;
    expect(loginGate.refusing(yahoo.id)).toBe(false);
    releasePooledClient(yahoo, pooled);
    await mgr.setFlag(yahoo, 3, 'INBOX', '\\Seen', true);
    expect(pooled.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(live.messageFlagsAdd).toHaveBeenCalledTimes(2);
  });

  it('keeps background work off the live connection: reconcile waits instead', async () => {
    const { mgr, live } = setup();
    loginGate.refused(yahoo.id, 'refused');
    query.mockImplementation(async (sql) => ({ rows: /SELECT DISTINCT m\.folder/.test(sql) ? [{ folder: 'INBOX' }, { folder: 'Archive' }] : [] }));
    await mgr.reconcileDeletes(yahoo);
    expect(live.getMailboxLock).not.toHaveBeenCalled();
    expect(logins).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringMatching(/Reconcile connection error/));
  });

  it('does not spend the flag-push give-up budget on logins it held back', async () => {
    const { mgr, live } = setup();
    live.usable = false; // Yahoo has just ended the session and the reconnect is not in yet
    loginGate.refused(yahoo.id, 'refused');
    mgr._enqueueFlagPush(yahoo.id, 'm1', '\\Seen', true);
    query.mockImplementation(async (sql) => ({
      rows: /FROM email_accounts/.test(sql) ? [yahoo] : /SELECT uid, folder FROM messages/.test(sql) ? [{ uid: 4242, folder: 'INBOX' }] : [],
    }));
    const run = mgr._reconcileFlagPushes();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(logins).toHaveLength(0);
    expect(mgr._pendingFlagPush.get(yahoo.id).get('m1:\\Seen').attempts).toBe(0);
  });
});

describe('what closes the gate', () => {
  it('a rejected password holds extra logins back as long as the live connection waits', async () => {
    const { mgr } = setup();
    accept = () => false;
    ImapFlow.mockImplementation(function (cfg) {
      const c = fakeClient();
      c.connect = vi.fn(() => Promise.reject(Object.assign(new Error('Command failed'), {
        serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'AUTHENTICATE Invalid credentials',
      })));
      logins.push({ cfg, client: c });
      return c;
    });
    folderStatusQueries();
    await mgr.folderStatusMonitor.refresh(yahoo);
    expect(logins).toHaveLength(1);
    expect(loginGate.waitMs(yahoo.id)).toBe(authCooldownMs(1));
  });

  it('pushback on the live connection itself, not only on a login', async () => {
    const { mgr } = setup();
    mgr.syncIntervals.set(yahoo.id, 'scheduled');
    mgr.syncMessages = vi.fn().mockRejectedValue(Object.assign(new Error('Command failed'), { serverResponseCode: 'LIMIT', responseText: 'Rate limit hit.' }));
    await mgr._syncTick(yahoo);
    expect(mgr._connectCooldown.get(yahoo.id)?.failures).toBe(1);
    expect(loginGate.refusing(yahoo.id)).toBe(true);
    expect(logins).toHaveLength(0);
  });

  it('counts a refused live reconnect once, not again in the tick that made it', async () => {
    const { mgr } = setup({ withLive: false });
    mgr.syncIntervals.set(yahoo.id, 'scheduled');
    accept = () => false;
    await mgr._syncTick(yahoo);
    expect(logins).toHaveLength(1);
    expect(loginGate.status(yahoo.id)?.failures).toBe(1);
  });
});

describe('folder status checks', () => {
  it('wait for the gate instead of logging in and warning every minute', async () => {
    const { mgr } = setup();
    await mgr.setFlag(yahoo, 1, 'INBOX', '\\Seen', true).catch(() => {});
    folderStatusQueries();
    await mgr.folderStatusMonitor.refresh(yahoo);
    expect(logins).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringMatching(/Folder status cycle failed/));
    expect(mgr.folderStatusMonitor.nextCheck.get(yahoo.id)).toBeGreaterThanOrEqual(Date.now() + 55_000);
  });

  it('close the gate when refused, without holding up the live reconnect', async () => {
    const { mgr } = setup();
    folderStatusQueries();
    await mgr.folderStatusMonitor.refresh(yahoo);
    expect(logins).toHaveLength(1);
    expect(loginGate.refusing(yahoo.id)).toBe(true);
    expect(mgr._connectCooldown.has(yahoo.id)).toBe(false);
  });

  it('run on an idle pooled connection when there is one, without a login', async () => {
    accept = () => true;
    const { mgr } = setup();
    const pooled = await acquirePooledClient(yahoo);
    releasePooledClient(yahoo, pooled);
    pooled.status.mockResolvedValue({ messages: 3, unseen: 1, uidNext: 10, uidValidity: 5n });
    folderStatusQueries();
    await mgr.folderStatusMonitor.refresh(yahoo);
    expect(logins).toHaveLength(1);
    expect(pooled.status).toHaveBeenCalledWith('INBOX', expect.any(Object));
    expect(pooled.close).not.toHaveBeenCalled();
  });
});

describe('the live connection after Yahoo ends a session', () => {
  function closingLive(ageMs) {
    const { mgr, live } = setup();
    mgr.syncIntervals.set(yahoo.id, 'scheduled');
    mgr._persistentMeta.set(live, { connectedAt: Date.now() - ageMs, idleSeen: true });
    live.on('close', () => mgr._onPersistentClose(yahoo, live));
    const tick = vi.spyOn(mgr, '_syncTick').mockResolvedValue();
    return { live, tick };
  }

  it('reconnects two seconds after a full-length session ends, not at the next tick', async () => {
    const { live, tick } = closingLive(298_000);
    live.close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('leaves a session that died young to the tick and its refusal handling', async () => {
    const { live, tick } = closingLive(5_000);
    live.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
