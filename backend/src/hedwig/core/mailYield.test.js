// Body and attachment fetches yield to mail sync (core/mailYield.js): skipped while the account is
// syncing or cooling down, per-account exponential backoff after "Connection not available",
// deferred (attempts refunded) rather than failed, fractional and per-provider rates.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJobsDb } from '../ledger/fakeJobsDb.testutil.js';

const fake = createFakeJobsDb();
const state = new Map();   // hedwig_state
const pushes = [];         // pushQueueBack UPDATEs
let messageRow = null;
let dbHook = null;
vi.mock('../../services/db.js', () => ({
  pool: {},
  query: vi.fn(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (dbHook) { const r = dbHook(s, params); if (r) return r; }
    if (s.startsWith('SELECT value FROM hedwig_state')) return { rows: state.has(params[0]) ? [{ value: state.get(params[0]) }] : [] };
    if (s.startsWith('INSERT INTO hedwig_state')) { state.set(params[0], JSON.parse(params[1])); return { rowCount: 1 }; }
    if (s.startsWith('DELETE FROM hedwig_state')) { state.delete(params[0]); return { rowCount: 1 }; }
    if (s.startsWith('SELECT key, value FROM hedwig_state')) return { rows: [...state].map(([key, value]) => ({ key, value })) };
    if (s.startsWith('UPDATE hedwig_jobs j SET run_at')) { pushes.push(params); return { rowCount: 0 }; }
    if (/FROM messages m JOIN email_accounts a/.test(s)) return { rows: messageRow ? [messageRow] : [] };
    if (s.startsWith('UPDATE messages SET body_html')) return { rowCount: 1 };
    if (/system_settings|hedwig_user_settings/.test(s)) return { rows: [] };
    return fake.query(sql, params);
  }),
}));
vi.mock('../../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../../services/emailSanitizer.js', () => ({ sanitizeEmail: (h) => h }));
vi.mock('../../services/messageParser.js', () => ({ snippetFromBody: (t) => String(t || '').slice(0, 40) }));
vi.mock('../llm.js', () => ({ probeGateway: async () => ({ ok: true }) }));

const my = await import('./mailYield.js');
const { makeFetchBodyHandler } = await import('./bodies.js');
const jobs = await import('../jobs.js');
const { invalidateConfigCache, coerce, SCHEMA, getConfig } = await import('../config.js');

const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YAHOO = { id: ACC, imap_host: 'imap.mail.yahoo.com' };
const MSG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The ImapManager fields mailYield reads, idle. */
function mgr(extra = {}) {
  return {
    _connectCooldown: new Map(), syncingAccounts: new Set(), connectingAccounts: new Set(),
    backfillRunning: new Set(), backfillAllRunning: new Set(), onDemandSyncing: new Set(), _statusSyncRunning: new Set(),
    snippetIndexerRunning: new Set(), snippetBackoff: new Map(), lastUserActivity: new Map(),
    fetchMessageBody: vi.fn(async () => ({ html: null, text: 'hello there', attachments: [] })),
    ...extra,
  };
}

beforeEach(() => {
  state.clear(); pushes.length = 0; dbHook = null;
  fake.state.rows.length = 0; fake.state.nextId = 1; fake.state.now = Date.now();
  messageRow = { id: MSG, uid: 7, folder: 'INBOX', body_text: null, body_html: null, account_id: ACC, imap_host: YAHOO.imap_host };
  jobs._resetJobs();
  my._resetMailYield();
  invalidateConfigCache();
  delete process.env.HEDWIG_INDEX_BODY_RATE_PER_SEC;
  delete process.env.HEDWIG_INDEX_BODY_RATE_BY_PROVIDER;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('rates', () => {
  it('accepts fractional rates and defaults Yahoo lower than everyone else', async () => {
    const field = SCHEMA.find((f) => f.key === 'index.bodyRatePerSec');
    expect(coerce(field, '0.5')).toBe(0.5);
    expect(coerce(field, 0.25)).toBe(0.25);
    const cfg = await getConfig();
    expect(cfg['index.bodyConcurrency']).toBe(1);
    expect(my.bodyRateFor(cfg, { host: 'imap.mail.yahoo.com', provider: my.providerOf(YAHOO) })).toBe(0.5);
    expect(my.bodyRateFor(cfg, { host: 'imap.gmail.com', provider: my.providerOf({ imap_host: 'imap.gmail.com' }) })).toBe(cfg['index.bodyRatePerSec']);
  });

  it('lets index.bodyRateByProvider name a provider or an exact host, and index.bodyRatePerSec cover the rest', async () => {
    process.env.HEDWIG_INDEX_BODY_RATE_PER_SEC = '0.5';
    process.env.HEDWIG_INDEX_BODY_RATE_BY_PROVIDER = '{"yahoo":0.2,"mail.example.org":3}';
    invalidateConfigCache();
    const cfg = await getConfig();
    expect(my.bodyRateFor(cfg, { host: 'imap.mail.yahoo.com', provider: 'yahoo' })).toBe(0.2);
    expect(my.bodyRateFor(cfg, { host: 'mail.example.org', provider: 'generic' })).toBe(3);
    expect(my.bodyRateFor(cfg, { host: 'imap.fastmail.com', provider: 'generic' })).toBe(0.5);
  });

  it('plans 0.5/s as one fetch every two seconds', async () => {
    const { planSlots } = await import('../indexer/acquire.js');
    const now = 1_000_000;
    expect(planSlots({ now, rate: 0.5, want: 3 }).map((d) => d.getTime() - now)).toEqual([0, 2000, 4000]);
  });
});

describe('yielding to upstream', () => {
  it('is busy while the account is in a refusal cooldown, syncing, backfilling, or being read', () => {
    const now = Date.now();
    const m = mgr();
    expect(my.upstreamBusy(m, YAHOO, now)).toBeNull();
    m._connectCooldown.set(ACC, { until: now + 60_000, failures: 2 });
    expect(my.upstreamBusy(m, YAHOO, now)).toMatchObject({ reason: expect.stringMatching(/cooldown/), retryMs: expect.any(Number) });
    expect(my.upstreamBusy(m, YAHOO, now).retryMs).toBeGreaterThanOrEqual(60_000);
    m._connectCooldown.set(ACC, { until: now - 1, failures: 2 }); // expired
    expect(my.upstreamBusy(m, YAHOO, now)).toBeNull();
    m.syncingAccounts.add(ACC);
    expect(my.upstreamBusy(m, YAHOO, now).reason).toMatch(/sync/);
    m.syncingAccounts.clear();
    m.backfillRunning.add(`${ACC}:INBOX`);
    expect(my.upstreamBusy(m, YAHOO, now).reason).toMatch(/backfill/);
    m.backfillRunning.clear();
    m._statusSyncRunning.add(`${ACC}:Archive`);
    expect(my.upstreamBusy(m, YAHOO, now).reason).toMatch(/integrity/);
    m._statusSyncRunning.clear();
    m.snippetBackoff.set('imap.mail.yahoo.com', { until: now + 5000, failures: 1 });
    expect(my.upstreamBusy(m, YAHOO, now).reason).toMatch(/host/);
    m.snippetBackoff.clear();
    m.lastUserActivity.set(ACC, now - 5000);
    expect(my.upstreamBusy(m, YAHOO, now).reason).toMatch(/opening/);
    m.lastUserActivity.set(ACC, now - 60_000);
    expect(my.upstreamBusy({ ...m, syncingAccounts: new Set(['other']) }, YAHOO, now)).toBeNull();
  });

  it('skips the fetch during a provider cooldown and defers the job without spending an attempt', async () => {
    const m = mgr();
    m._connectCooldown.set(ACC, { until: Date.now() + 90_000, failures: 3 });
    jobs.defineJob('mail.fetchBody', makeFetchBodyHandler(m));
    const id = await jobs.enqueue('mail.fetchBody', { messageId: MSG }, { maxAttempts: 3 });
    const [job] = await jobs.claim(5);
    await jobs.runJob(job);
    expect(m.fetchMessageBody).not.toHaveBeenCalled();
    const row = fake.row(id);
    expect(row).toMatchObject({ status: 'deferred', attempts: 0, failed_at: null });
    expect(row.last_error).toMatch(/^deferred: mail first: the provider refused a connection/);
    expect(row.run_at - fake.state.now).toBeGreaterThanOrEqual(90_000);
    expect(pushes).toHaveLength(1); // the rest of the account's queue moves behind the cooldown too
    expect(pushes[0][4]).toBe(ACC);
  });

  it('skips the fetch while the account is mid-sync', async () => {
    const m = mgr();
    m.syncingAccounts.add(ACC);
    jobs.defineJob('mail.fetchBody', makeFetchBodyHandler(m));
    const id = await jobs.enqueue('mail.fetchBody', { messageId: MSG }, { maxAttempts: 3 });
    await jobs.runJob((await jobs.claim(5))[0]);
    expect(m.fetchMessageBody).not.toHaveBeenCalled();
    expect(fake.row(id)).toMatchObject({ status: 'deferred', attempts: 0 });
    expect(fake.row(id).last_error).toMatch(/mail sync is running/);
    // sync over: the next run fetches
    m.syncingAccounts.clear();
    fake.advance(60_000);
    await jobs.runJob((await jobs.claim(5))[0]);
    expect(m.fetchMessageBody).toHaveBeenCalledTimes(1);
    expect(fake.row(id).status).toBe('done');
  });

  it('keeps at most index.bodyConcurrency fetches in flight per account', async () => {
    let release;
    const m = mgr({ fetchMessageBody: vi.fn(() => new Promise((r) => { release = () => r({ text: 'x', html: null, attachments: [] }); })) });
    const first = my.guardedFetch({ imapManager: m, account: YAHOO, messageId: 'm1' }, () => m.fetchMessageBody());
    await vi.waitFor(() => expect(m.fetchMessageBody).toHaveBeenCalledTimes(1));
    await expect(my.guardedFetch({ imapManager: m, account: YAHOO, messageId: 'm2' }, () => m.fetchMessageBody()))
      .rejects.toMatchObject({ code: 'job_deferred', message: expect.stringMatching(/in flight/) });
    // another account is not held up
    await expect(my.guardedFetch({ imapManager: m, account: { id: 'other', imap_host: 'imap.gmail.com' }, messageId: 'm3' }, async () => 'ok')).resolves.toBe('ok');
    release();
    await first;
    await expect(my.guardedFetch({ imapManager: m, account: YAHOO, messageId: 'm2' }, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('per-account backoff', () => {
  it('backs off 1 → 2 → 4 … 15 min after "Connection not available", deferring instead of failing', async () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => my.fetchBackoffMs(n) / 60_000)).toEqual([1, 2, 4, 8, 15, 15]);
    const m = mgr({ fetchMessageBody: vi.fn(async () => { throw new Error('Connection not available'); }) });
    jobs.defineJob('mail.fetchBody', makeFetchBodyHandler(m));
    const id = await jobs.enqueue('mail.fetchBody', { messageId: MSG }, { maxAttempts: 3 });
    const key = `index.fetchBackoff:${ACC}`;
    const waits = [];
    for (let i = 0; i < 3; i++) {
      const before = fake.state.now;
      const realNow = Date.now;
      Date.now = () => before; // guardedFetch reads the clock; keep it on the fake DB's
      try { await jobs.runJob((await jobs.claim(5))[0]); } finally { Date.now = realNow; }
      const row = fake.row(id);
      expect(row).toMatchObject({ status: 'deferred', attempts: 0, failed_at: null });
      expect(row.last_error).toMatch(/deferred: mail server pushed back \("Connection not available"\)/);
      expect(state.get(key)).toMatchObject({ failures: i + 1, error: 'Connection not available' });
      waits.push(Math.round((row.run_at - before) / 60_000));
      fake.state.now = row.run_at; // the next attempt runs when the backoff ends
    }
    expect(waits).toEqual([1, 2, 4]);
    expect(m.fetchMessageBody).toHaveBeenCalledTimes(3);
    expect(pushes.map((p) => p[4])).toEqual([ACC, ACC, ACC]); // queued fetches moved behind each backoff
    expect(pushes[0][2]).toBe(2); // spaced at Yahoo's 0.5/s

    // a success clears the backoff, so the next refusal starts at 1 min again
    m.fetchMessageBody.mockImplementationOnce(async () => ({ html: null, text: 'finally', attachments: [] }));
    const realNow = Date.now;
    Date.now = () => fake.state.now;
    try { await jobs.runJob((await jobs.claim(5))[0]); } finally { Date.now = realNow; }
    expect(fake.row(id).status).toBe('done');
    expect(state.has(key)).toBe(false);
  });

  it('defers a fetch while its account is still backing off, without touching IMAP', async () => {
    state.set(`index.fetchBackoff:${ACC}`, { failures: 2, until: new Date(Date.now() + 120_000).toISOString(), error: 'Connection not available' });
    const m = mgr();
    await expect(my.guardedFetch({ imapManager: m, account: YAHOO, messageId: MSG }, () => m.fetchMessageBody()))
      .rejects.toMatchObject({ code: 'job_deferred', delayMs: expect.any(Number) });
    expect(m.fetchMessageBody).not.toHaveBeenCalled();
  });

  it('treats server "try again later" as backoff, a broken message as an ordinary failure', async () => {
    expect(my.isMailBusyError(new Error('UID FETCH Server error - Please try again later'))).toBe(true);
    expect(my.isMailBusyError(new Error('Provider connection cooldown active'))).toBe(true);
    expect(my.isMailBusyError(new Error('IMAP connections busy, please retry'))).toBe(true);
    expect(my.isMailBusyError(new Error('Unexpected token in BODYSTRUCTURE'))).toBe(false);
    const m = mgr({ fetchMessageBody: vi.fn(async () => { throw new Error('Unexpected token in BODYSTRUCTURE'); }) });
    await expect(my.guardedFetch({ imapManager: m, account: YAHOO, messageId: MSG }, () => m.fetchMessageBody())).rejects.toThrow('BODYSTRUCTURE');
    expect(state.size).toBe(0);
  });

  it('lets a message the server keeps refusing spend an attempt eventually', async () => {
    const m = mgr({ fetchMessageBody: vi.fn(async () => { throw new Error('Server error - Please try again later'); }) });
    const run = () => my.guardedFetch({ imapManager: m, account: YAHOO, messageId: MSG, now: Date.now() + 3600_000 * 10 }, () => m.fetchMessageBody());
    for (let i = 1; i < my.MAX_REFUSALS_PER_MESSAGE; i++) {
      state.delete(`index.fetchBackoff:${ACC}`); // pretend each backoff ran out
      await expect(run()).rejects.toMatchObject({ code: 'job_deferred' });
    }
    state.delete(`index.fetchBackoff:${ACC}`);
    await expect(run()).rejects.toThrow('try again later');
  });

  it('stops requesting bodies for an account that is backing off', async () => {
    const { requestBodies } = await import('../indexer/acquire.js');
    state.set(`index.fetchBackoff:${ACC}`, { failures: 1, until: new Date(Date.now() + 60_000).toISOString(), error: 'x' });
    const enqueued = [];
    dbHook = (s, params) => {
      if (s.startsWith('SELECT m.id, m.account_id, a.user_id')) {
        return { rows: [
          { id: MSG, account_id: ACC, user_id: 'u', date: new Date(), thread_key: 't', host: 'imap.mail.yahoo.com', imap_host: 'imap.mail.yahoo.com' },
          { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', account_id: 'acc2', user_id: 'u', date: new Date(), thread_key: 't2', host: 'imap.gmail.com', imap_host: 'imap.gmail.com' },
        ] };
      }
      if (s.startsWith("SELECT payload->>'host'")) return { rows: [] };
      if (s.startsWith('INSERT INTO hedwig_jobs')) { enqueued.push(JSON.parse(params[1])); return { rows: [{ id: enqueued.length }] }; }
      if (s.startsWith('INSERT INTO hedwig_index_msg')) return { rowCount: 1 };
      return null;
    };
    expect(await requestBodies()).toBe(1);
    expect(enqueued.map((p) => p.host)).toEqual(['imap.gmail.com']);
  });
});
