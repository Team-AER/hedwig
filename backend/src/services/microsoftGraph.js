// Sending through Microsoft Graph for mailboxes connected with Microsoft sign-in.
//
// Exchange Online lets a tenant turn off SMTP AUTH ("SmtpClientAuthentication is disabled for the
// Tenant", 535 5.7.139), and new tenants start with it off; XOAUTH2 tokens do not get around it.
// Graph's sendMail is not affected. The sign-in asks for Graph's Mail.Send next to the IMAP/SMTP
// scopes (oauthProviders.js); the account's refresh token is redeemed for a Graph token when a
// message goes out. Exchange files the sent copy in Sent Items itself, as it does for SMTP.
//
// Messages are handed over as MIME (built by nodemailer's MailComposer from the same mailOptions
// the SMTP path uses), so headers such as Message-ID, In-Reply-To and References survive. Graph
// takes at most 4 MB per request: a bigger message becomes a draft (its MIME without the
// attachments), each attachment is added (an upload session above 3 MB) and the draft is sent.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { query } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { oauthProvider, MICROSOFT_GRAPH_SEND_SCOPE } from './oauthProviders.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const REQUEST_LIMIT = 3_900_000; // Graph's 4 MB request cap, with room for the request itself
const SMALL_ATTACHMENT = 3 * 1024 * 1024; // larger attachments go through an upload session
const CHUNK = 10 * 320 * 1024; // upload-session chunks must be multiples of 320 KiB
const TOKEN_SKEW_MS = 5 * 60 * 1000;

export class GraphError extends Error {
  constructor(message, { status = 0, code = null, consentMissing = false } = {}) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
    this.consentMissing = consentMissing;
  }
}

// ── Token ────────────────────────────────────────────────────────────────────

const tokens = new Map(); // account id → { token, expiresAt }
const inFlight = new Map();
export function _resetGraphTokens() { tokens.clear(); inFlight.clear(); }

/**
 * A Graph access token that may send mail as this account, from its refresh token. Throws a
 * GraphError with consentMissing when the account was connected before Hedwig asked for Mail.Send
 * (or the consent was taken back): the person has to sign in again and allow sending.
 */
export function graphSendToken(account, { fetchImpl = fetch, now = Date.now } = {}) {
  const cached = tokens.get(account.id);
  if (cached && cached.expiresAt - now() > TOKEN_SKEW_MS) return Promise.resolve(cached.token);
  const pending = inFlight.get(account.id);
  if (pending) return pending;
  const p = redeem(account, { fetchImpl, now }).finally(() => inFlight.delete(account.id));
  inFlight.set(account.id, p);
  return p;
}

async function redeem(account, { fetchImpl, now }) {
  const provider = oauthProvider('microsoft');
  const cfg = provider.getConfig();
  const refreshToken = decrypt(account.oauth_refresh_token);
  if (!refreshToken) throw new GraphError('The Microsoft sign-in is missing; reconnect the account.', { consentMissing: true });
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: MICROSOFT_GRAPH_SEND_SCOPE,
  });
  // Public (device-code) clients must not send a secret (AADSTS90023).
  if (cfg.clientSecret && !account.oauth_public_client) body.set('client_secret', cfg.clientSecret);
  const res = await fetchImpl(provider.tokenUrl(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = String(data.error_description || data.error || `HTTP ${res.status}`);
    // AADSTS65001: not consented; AADSTS70000/invalid_scope: the grant does not cover Mail.Send.
    const consentMissing = /AADSTS65001|AADSTS70000|consent_required|invalid_scope|AADSTS650057/i.test(`${data.error} ${desc} ${data.suberror || ''}`);
    throw new GraphError(desc.split(/\r?\n/)[0], { status: res.status, code: data.error || null, consentMissing });
  }
  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  tokens.set(account.id, { token: data.access_token, expiresAt: now() + expiresIn * 1000 });
  // A newer refresh token is as good for IMAP as for Graph; keep it so the grant does not age out.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await query('UPDATE email_accounts SET oauth_refresh_token = $1 WHERE id = $2', [encrypt(data.refresh_token), account.id])
      .catch((err) => console.warn('Graph: could not store the refreshed token:', err.message));
  }
  return data.access_token;
}

// ── MIME ─────────────────────────────────────────────────────────────────────

/** The message as raw MIME, Bcc kept (Graph reads the recipients from the headers). */
export async function buildMime(mailOptions) {
  const node = new MailComposer({ ...mailOptions }).compile();
  node.keepBcc = true;
  return node.build();
}

// ── Graph calls ──────────────────────────────────────────────────────────────

async function graphCall(fetchImpl, token, method, path, { body, contentType = 'application/json', expect = [200, 201, 202, 204] } = {}) {
  const res = await fetchImpl(path.startsWith('https://') ? path : `${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': contentType } : {}) },
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  if (expect.includes(res.status)) {
    const text = await res.text().catch(() => '');
    return text ? JSON.parse(text) : null;
  }
  const data = await res.json().catch(() => ({}));
  const code = data?.error?.code || null;
  const message = data?.error?.message || `HTTP ${res.status}`;
  throw new GraphError(`Microsoft Graph ${res.status}${code ? ` ${code}` : ''}: ${message}`, { status: res.status, code });
}

function attachmentBytes(a) {
  if (Buffer.isBuffer(a.content)) return a.content;
  if (typeof a.content === 'string') return Buffer.from(a.content, a.encoding === 'base64' ? 'base64' : 'utf8');
  return Buffer.alloc(0);
}

async function addAttachment(fetchImpl, token, messageId, a) {
  const bytes = attachmentBytes(a);
  const name = a.filename || 'attachment';
  const contentType = a.contentType || 'application/octet-stream';
  const inline = Boolean(a.cid);
  if (bytes.length <= SMALL_ATTACHMENT) {
    await graphCall(fetchImpl, token, 'POST', `/me/messages/${encodeURIComponent(messageId)}/attachments`, {
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.fileAttachment', name, contentType, contentBytes: bytes.toString('base64'),
        isInline: inline, ...(inline ? { contentId: a.cid } : {}),
      }),
    });
    return;
  }
  const session = await graphCall(fetchImpl, token, 'POST', `/me/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`, {
    body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name, size: bytes.length, contentType, isInline: inline, ...(inline ? { contentId: a.cid } : {}) } }),
  });
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    // The upload URL carries its own authorization; a Bearer header on it is refused.
    const res = await fetchImpl(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`, 'Content-Type': 'application/octet-stream' },
      body: bytes.subarray(start, end),
      signal: AbortSignal.timeout(120_000),
    });
    if (![200, 201, 202].includes(res.status)) {
      const data = await res.json().catch(() => ({}));
      throw new GraphError(`Microsoft Graph ${res.status}: uploading ${name} failed${data?.error?.message ? ` (${data.error.message})` : ''}`, { status: res.status, code: data?.error?.code || null });
    }
  }
}

/** Send one message (nodemailer mailOptions) as the account behind `token`. */
export async function sendViaGraph(token, mailOptions, { fetchImpl = fetch } = {}) {
  const mime = (await buildMime(mailOptions)).toString('base64');
  if (mime.length <= REQUEST_LIMIT) {
    await graphCall(fetchImpl, token, 'POST', '/me/sendMail', { body: mime, contentType: 'text/plain' });
    return { via: 'graph' };
  }
  // Too big for one request: a draft from the MIME without attachments, then each attachment,
  // then send. A draft left by a failure is deleted, so nothing half-made stays in Drafts.
  const { attachments = [], ...rest } = mailOptions;
  const bare = (await buildMime(rest)).toString('base64');
  if (bare.length > REQUEST_LIMIT) throw new GraphError('Microsoft Graph 413: the message text alone is larger than 4 MB', { status: 413, code: 'ErrorMessageSizeExceeded' });
  const draft = await graphCall(fetchImpl, token, 'POST', '/me/messages', { body: bare, contentType: 'text/plain' });
  try {
    for (const a of attachments) await addAttachment(fetchImpl, token, draft.id, a);
    await graphCall(fetchImpl, token, 'POST', `/me/messages/${encodeURIComponent(draft.id)}/send`);
  } catch (err) {
    await graphCall(fetchImpl, token, 'DELETE', `/me/messages/${encodeURIComponent(draft.id)}`).catch(() => {});
    throw err;
  }
  return { via: 'graph', large: true };
}

/**
 * The transport for a Microsoft-connected account: Graph first; SMTP when the account has not
 * allowed Graph sending yet (connected before Hedwig asked for Mail.Send), so nothing that sends
 * today stops working before the person reconnects.
 */
export function graphFirstTransport(account, smtp, { fetchImpl = fetch } = {}) {
  return {
    async sendMail(mailOptions) {
      let token;
      try {
        token = await graphSendToken(account, { fetchImpl });
      } catch (err) {
        if (!(err instanceof GraphError) || !err.consentMissing) throw err;
        try {
          return await smtp.sendMail(mailOptions);
        } catch (smtpErr) {
          // SMTP is off for the tenant too: the only way out is to allow Graph sending.
          if (/5\.7\.139|SmtpClientAuthentication/i.test(smtpErr.message || '')) {
            throw new GraphError('SmtpClientAuthentication is disabled and Graph sending is not allowed yet: reconnect to allow sending', { status: 403, code: 'GraphConsentRequired', consentMissing: true });
          }
          throw smtpErr;
        }
      }
      return sendViaGraph(token, mailOptions, { fetchImpl });
    },
    verify: () => smtp.verify(),
  };
}
