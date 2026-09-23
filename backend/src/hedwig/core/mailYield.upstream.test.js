// Pins what core/mailYield.js reads from the real upstream ImapManager, so an upstream merge that
// renames its sync/cooldown state fails here instead of silently turning the yield off, and keeps
// providerOf() in step with upstream's providerProfile().
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../../services/db.js', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: {} }));
vi.mock('../../services/messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p) }));
vi.mock('../../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../../services/emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('../../services/encryption.js', () => ({ decrypt: vi.fn(() => 'pw'), encrypt: vi.fn((v) => v), isEncrypted: vi.fn(() => false) }));
vi.mock('../../services/aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../../services/pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('../../services/hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('../../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../../services/spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('../../services/mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));

const { ImapManager, providerProfile } = await import('../../services/imapManager.js');
const { upstreamBusy, providerOf } = await import('./mailYield.js');

const ACCOUNT = { id: 'acct-yahoo', imap_host: 'imap.mail.yahoo.com', email: 'someone@yahoo.com' };

function manager() {
  const mgr = new ImapManager(null);
  for (const key of ['_healthCheckTimer', '_snippetSchedulerTimer', '_stalenessCheckTimer', '_flagPushReconcilerTimer']) clearInterval(mgr[key]);
  return mgr;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('upstream state the body fetch yields to', () => {
  it('still exists on ImapManager with the shapes mailYield reads', () => {
    const mgr = manager();
    expect(mgr._connectCooldown).toBeInstanceOf(Map);
    expect(mgr.snippetBackoff).toBeInstanceOf(Map);
    expect(mgr.lastUserActivity).toBeInstanceOf(Map);
    for (const k of ['syncingAccounts', 'connectingAccounts', 'backfillRunning', 'backfillAllRunning', 'onDemandSyncing', '_statusSyncRunning', 'snippetIndexerRunning']) {
      expect(mgr[k], k).toBeInstanceOf(Set);
    }
    expect(upstreamBusy(mgr, ACCOUNT)).toBeNull();
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringMatching(/cannot see the mail engine/));
  });

  it("sees upstream's own refusal cooldown and sync guard", () => {
    const mgr = manager();
    mgr._noteConnectionRefusal(ACCOUNT); // what a "Connection not available" on connect/sync does upstream
    expect(upstreamBusy(mgr, ACCOUNT)).toMatchObject({ reason: expect.stringMatching(/cooldown/) });
    mgr.clearConnectCooldown(ACCOUNT.id);
    expect(upstreamBusy(mgr, ACCOUNT)).toBeNull();
    mgr.syncingAccounts.add(ACCOUNT.id);
    expect(upstreamBusy(mgr, ACCOUNT)).toMatchObject({ reason: expect.stringMatching(/sync/) });
    mgr.syncingAccounts.delete(ACCOUNT.id);
    mgr.noteUserActivity(ACCOUNT.id);
    expect(upstreamBusy(mgr, ACCOUNT)).toMatchObject({ reason: expect.stringMatching(/opening/) });
  });

  it('names providers exactly as providerProfile() groups them', () => {
    const hosts = [
      { imap_host: 'imap.gmail.com' }, { imap_host: 'imap.googlemail.com' }, { imap_host: 'imap.mail.yahoo.com' },
      { imap_host: 'imap.ymail.com' }, { imap_host: 'imap.mail.me.com' }, { imap_host: 'imap.icloud.com' },
      { imap_host: 'outlook.office365.com' }, { imap_host: 'imap-mail.outlook.com' }, { imap_host: 'mail.example.org', oauth_provider: 'microsoft' },
      { imap_host: 'imap.purelymail.com' }, { imap_host: 'imap.fastmail.com' }, { imap_host: 'imap.zoho.com' },
    ];
    for (const a of hosts) {
      for (const b of hosts) {
        expect(providerOf(a) === providerOf(b), `${a.imap_host} vs ${b.imap_host}`).toBe(providerProfile(a) === providerProfile(b));
      }
    }
    expect(providerOf({ imap_host: 'imap.mail.yahoo.com' })).toBe('yahoo');
  });
});
