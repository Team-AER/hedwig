import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requireAuth: (req, _res, next) => { req.session = { userId: 'u1' }; next(); } }));
vi.mock('../services/redis.js', () => ({ redisClient: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));
vi.mock('../utils/mailUtils.js', () => ({ resolveSentFolder: vi.fn() }));
import express from 'express';
import routes from './send.js';
import { query } from '../services/db.js';
import { redisClient } from '../services/redis.js';
import { createAccountSmtpTransport } from '../services/smtpTransport.js';
import { resolveSentFolder } from '../utils/mailUtils.js';
import { pluginRegistry } from '../plugins/registry.js';
import { HEDWIG_HOOKS } from '../hedwig/hooks.js';

const account = { id: 'a1', email_address: 'me@example.com', name: 'Me', oauth_provider: 'google' };
const sendMail = vi.fn();
let verdicts = [];
let seenCtx = null;

pluginRegistry.register({
  id: 'send-test-guard',
  name: 'Send test guard',
  version: '1.0.0',
  tier: 1,
  hooks: {
    [HEDWIG_HOOKS.beforeSend]: async (ctx) => { seenCtx = ctx; return verdicts.shift(); },
  },
});
pluginRegistry.register({
  id: 'send-test-thrower',
  name: 'Send test thrower',
  version: '1.0.0',
  tier: 1,
  hooks: { [HEDWIG_HOOKS.beforeSend]: async () => { throw new Error('plugin bug'); } },
});

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mail', routes);
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  vi.clearAllMocks();
  verdicts = [];
  seenCtx = null;
  query.mockImplementation(async sql => ({ rows: sql.includes('FROM email_accounts') ? [account] : [{ preferences: {}, id: 'book1' }] }));
  redisClient.get.mockResolvedValue(null);
  redisClient.set.mockResolvedValue('OK');
  createAccountSmtpTransport.mockResolvedValue({ account, transport: { sendMail } });
  sendMail.mockResolvedValue({});
  resolveSentFolder.mockResolvedValue(null);
});

const post = (extra = {}) => fetch(`${base}/api/mail/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountId: 'a1', to: ['you@other.org'], subject: 'Report', body: '<p>Please see the attached report.</p>', bodyIsHtml: true, inReplyTo: '<m1@x>', ...extra }),
});

describe('beforeSend plugin hook', () => {
  it('hands plugins the outgoing message as plain data', async () => {
    await post();
    expect(seenCtx).toMatchObject({
      userId: 'u1', accountId: 'a1', from: { email: 'me@example.com', name: 'Me' }, to: ['you@other.org'],
      subject: 'Report', body: 'Please see the attached report.', hasAttachments: false, inReplyTo: '<m1@x>',
    });
    expect(seenCtx.imapManager).toBeUndefined();
  });

  it('blocks the send with 409 and the reason when a plugin blocks', async () => {
    verdicts = [{ block: true, reason: 'Nothing is attached.', pluginId: 'aer.sendguard' }];
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Nothing is attached.', blockedBy: 'aer.sendguard', warnings: [] });
    expect(createAccountSmtpTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();
  });

  it('sends and returns warnings when a plugin only warns', async () => {
    verdicts = [{ block: false, warn: 'Nothing is attached.', pluginId: 'aer.sendguard' }];
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warnings: [{ pluginId: 'aer.sendguard', message: 'Nothing is attached.' }] });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('sends normally when no plugin objects, even if one throws', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendMail).toHaveBeenCalledOnce();
  });
});
