// Sending through Microsoft Graph: the Graph token from the account's refresh token, MIME through
// /me/sendMail, the draft path for a message over Graph's 4 MB request cap, and the fallback to
// SMTP for accounts that have not allowed Graph sending yet.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] }));
vi.mock('./db.js', () => ({ query: vi.fn(async (sql, params) => { db.calls.push({ sql, params }); return { rows: [], rowCount: 1 }; }) }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn((v) => v), encrypt: vi.fn((v) => `enc:${v}`) }));

process.env.MS_CLIENT_ID = 'hedwig-client';
process.env.MS_CLIENT_SECRET = 'hedwig-secret';
process.env.APP_URL = 'https://hedwig.test';

const { graphSendToken, sendViaGraph, graphFirstTransport, buildMime, GraphError, _resetGraphTokens } = await import('./microsoftGraph.js');

const ACCOUNT = { id: 'acc-1', oauth_provider: 'microsoft', oauth_refresh_token: 'rt-old', oauth_public_client: false };
const MAIL = {
  messageId: '<abc@example.org>', from: 'Me <me@example.org>', to: 'Ana <ana@example.com>', bcc: 'boss@example.com',
  subject: 'Re: RCA', text: 'Thanks for the RCA.', html: '<p>Thanks for the RCA.</p>', inReplyTo: '<rca@example.com>', references: '<rca@example.com>',
};

/** A fetch that answers by method + URL and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`;
    calls.push({ key, url, opts });
    const route = routes.find(([re]) => re.test(key));
    if (!route) throw new Error(`unexpected ${key}`);
    const [status, body] = typeof route[1] === 'function' ? route[1](opts, calls.length) : route[1];
    return { ok: status < 400, status, json: async () => body ?? {}, text: async () => (body ? JSON.stringify(body) : '') };
  });
  fn.calls = calls;
  return fn;
}

const TOKEN = [/^POST https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/, [200, { access_token: 'graph-at', refresh_token: 'rt-new', expires_in: 3600 }]];

beforeEach(() => {
  _resetGraphTokens();
  db.calls.length = 0;
});

describe('graphSendToken', () => {
  it('redeems the refresh token for Mail.Send, caches it and keeps the newer refresh token', async () => {
    const f = fakeFetch([TOKEN]);
    expect(await graphSendToken(ACCOUNT, { fetchImpl: f })).toBe('graph-at');
    expect(await graphSendToken(ACCOUNT, { fetchImpl: f })).toBe('graph-at');
    expect(f).toHaveBeenCalledTimes(1);
    const body = f.calls[0].opts.body;
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: 'refresh_token', refresh_token: 'rt-old', client_id: 'hedwig-client', client_secret: 'hedwig-secret',
      scope: 'https://graph.microsoft.com/Mail.Send offline_access',
    });
    expect(db.calls[0].params).toEqual(['enc:rt-new', 'acc-1']);
  });

  it('says consent is missing for an account connected before Hedwig asked for Mail.Send', async () => {
    const f = fakeFetch([[/token$/, [400, { error: 'invalid_grant', error_description: "AADSTS65001: The user or administrator has not consented to use the application with ID 'x'.\r\nTrace ID: 1" }]]]);
    const err = await graphSendToken(ACCOUNT, { fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.consentMissing).toBe(true);
    expect(err.message).not.toMatch(/Trace ID/);
  });

  it('never sends a secret for a public (device-code) client', async () => {
    const f = fakeFetch([TOKEN]);
    await graphSendToken({ ...ACCOUNT, id: 'acc-pub', oauth_public_client: true }, { fetchImpl: f });
    expect(f.calls[0].opts.body.has('client_secret')).toBe(false);
  });
});

describe('sendViaGraph', () => {
  it('hands a normal message over as MIME, keeping Bcc and the reply headers', async () => {
    const f = fakeFetch([[/^POST https:\/\/graph\.microsoft\.com\/v1\.0\/me\/sendMail$/, [202]]]);
    expect(await sendViaGraph('graph-at', MAIL, { fetchImpl: f })).toEqual({ via: 'graph' });
    const { opts } = f.calls[0];
    expect(opts.headers).toEqual({ Authorization: 'Bearer graph-at', 'Content-Type': 'text/plain' });
    const mime = Buffer.from(opts.body, 'base64').toString('utf8');
    expect(mime).toMatch(/^Message-ID: <abc@example\.org>/m);
    expect(mime).toMatch(/^In-Reply-To: <rca@example\.com>/m);
    expect(mime).toMatch(/^Bcc: boss@example\.com/m);
    expect(mime).toMatch(/^Subject: Re: RCA/m);
  });

  it('sends a message over 4 MB as a draft with its attachments added, an upload session for the big one', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    const small = Buffer.from('small file');
    const f = fakeFetch([
      [/^POST .*\/me\/messages$/, [201, { id: 'draft-1' }]],
      [/^POST .*\/me\/messages\/draft-1\/attachments$/, [201, { id: 'att' }]],
      [/^POST .*\/attachments\/createUploadSession$/, [201, { uploadUrl: 'https://upload.example/session' }]],
      [/^PUT https:\/\/upload\.example\/session$/, (opts) => [/\/5242880$/.test(opts.headers['Content-Range']) && opts.body.length <= 10 * 320 * 1024 ? 200 : 500]],
      [/^POST .*\/me\/messages\/draft-1\/send$/, [202]],
    ]);
    const out = await sendViaGraph('graph-at', { ...MAIL, attachments: [{ filename: 'a.txt', content: small, contentType: 'text/plain' }, { filename: 'big.bin', content: big }] }, { fetchImpl: f });
    expect(out).toEqual({ via: 'graph', large: true });
    const keys = f.calls.map((c) => c.key.replace('https://graph.microsoft.com/v1.0', ''));
    expect(keys[0]).toBe('POST /me/messages');
    expect(keys.filter((k) => k.startsWith('PUT'))).toHaveLength(Math.ceil(big.length / (10 * 320 * 1024)));
    expect(keys.at(-1)).toBe('POST /me/messages/draft-1/send');
    expect(Buffer.from(f.calls[0].opts.body, 'base64').toString()).not.toMatch(/big\.bin/);
    const put = f.calls.find((c) => c.key.startsWith('PUT'));
    expect(put.opts.headers.Authorization).toBeUndefined();
    const smallPost = f.calls.find((c) => /draft-1\/attachments$/.test(c.key));
    expect(JSON.parse(smallPost.opts.body)).toMatchObject({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.txt', contentBytes: small.toString('base64'), isInline: false });
  });

  it('deletes the draft when the big path fails half way', async () => {
    const f = fakeFetch([
      [/^POST .*\/me\/messages$/, [201, { id: 'draft-2' }]],
      [/^POST .*\/attachments\/createUploadSession$/, [403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }]],
      [/^DELETE .*\/me\/messages\/draft-2$/, [204]],
    ]);
    const err = await sendViaGraph('graph-at', { ...MAIL, attachments: [{ filename: 'big.bin', content: Buffer.alloc(5 * 1024 * 1024) }] }, { fetchImpl: f }).catch((e) => e);
    expect(err.message).toMatch(/Microsoft Graph 403 ErrorAccessDenied/);
    expect(f.calls.at(-1).key).toMatch(/^DELETE .*draft-2$/);
  });

  it('reports Graph errors with their status and code', async () => {
    const f = fakeFetch([[/sendMail$/, [403, { error: { code: 'ErrorSendAsDenied', message: 'not allowed' } }]]]);
    const err = await sendViaGraph('t', MAIL, { fetchImpl: f }).catch((e) => e);
    expect(err).toMatchObject({ status: 403, code: 'ErrorSendAsDenied' });
  });
});

describe('graphFirstTransport', () => {
  it('sends through Graph once the account allowed it, never touching SMTP', async () => {
    const smtp = { sendMail: vi.fn(), verify: vi.fn() };
    const f = fakeFetch([TOKEN, [/sendMail$/, [202]]]);
    expect(await graphFirstTransport(ACCOUNT, smtp, { fetchImpl: f }).sendMail(MAIL)).toEqual({ via: 'graph' });
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it('keeps sending over SMTP until the account is reconnected', async () => {
    const smtp = { sendMail: vi.fn(async () => ({ messageId: 'x' })), verify: vi.fn() };
    const f = fakeFetch([[/token$/, [400, { error: 'invalid_grant', error_description: 'AADSTS65001: not consented' }]]]);
    expect(await graphFirstTransport(ACCOUNT, smtp, { fetchImpl: f }).sendMail(MAIL)).toEqual({ messageId: 'x' });
    expect(smtp.sendMail).toHaveBeenCalledWith(MAIL);
  });

  it('says to reconnect when the tenant has SMTP AUTH off as well', async () => {
    const smtp = { sendMail: vi.fn(async () => { throw new Error('Invalid login: 535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.'); }) };
    const f = fakeFetch([[/token$/, [400, { error: 'invalid_grant', error_description: 'AADSTS65001: not consented' }]]]);
    const err = await graphFirstTransport(ACCOUNT, smtp, { fetchImpl: f }).sendMail(MAIL).catch((e) => e);
    expect(err).toMatchObject({ code: 'GraphConsentRequired', consentMissing: true });
  });

  it('never falls back to SMTP after Graph refused the message itself (it might go twice)', async () => {
    const smtp = { sendMail: vi.fn() };
    const f = fakeFetch([TOKEN, [/sendMail$/, [500, { error: { code: 'ErrorInternalServerError', message: 'boom' } }]]]);
    await expect(graphFirstTransport(ACCOUNT, smtp, { fetchImpl: f }).sendMail(MAIL)).rejects.toThrow(/Microsoft Graph 500/);
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
});

describe('buildMime', () => {
  it('builds CRLF MIME with an inline image as a related part', async () => {
    const mime = (await buildMime({ ...MAIL, attachments: [{ filename: 'logo.png', content: Buffer.from('png'), contentType: 'image/png', cid: 'logo@x' }] })).toString();
    expect(mime).toMatch(/\r\n/);
    expect(mime).toMatch(/Content-ID: <logo@x>/);
  });
});
