// What the composer says when a send fails: the reason in words, never the server's internals.
import { describe, it, expect, vi } from 'vitest';
vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redisClient: {} }));
vi.mock('../index.js', () => ({ imapManager: {} }));
vi.mock('../services/smtpTransport.js', () => ({ createAccountSmtpTransport: vi.fn() }));

const { sanitizeSmtpError } = await import('./send.js');
const say = (message) => sanitizeSmtpError(new Error(message));

describe('send errors', () => {
  it('says the organisation turned SMTP off, and how to send anyway, instead of "check your credentials"', () => {
    const tenantOff = 'Invalid login: 535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant. Visit https://aka.ms/smtp_auth_disabled';
    expect(say(tenantOff)).toMatch(/does not let apps send over SMTP.*allow Hedwig to send mail/);
    expect(say('SmtpClientAuthentication is disabled and Graph sending is not allowed yet: reconnect to allow sending')).toBe(say(tenantOff));
    expect(say('Invalid login: 535 5.7.3 Authentication unsuccessful')).toBe('Authentication failed. Check your email account credentials.');
  });

  it('turns Microsoft Graph refusals into plain words', () => {
    expect(say('Microsoft Graph 403 ErrorAccessDenied: Access is denied.')).toMatch(/refused to send from this account/);
    expect(say('Microsoft Graph 403 ErrorSendAsDenied: no')).toBe('Microsoft does not let this account send as that address.');
    expect(say('Microsoft Graph 413 ErrorMessageSizeExceeded: too big')).toBe('The message is larger than Microsoft accepts.');
    expect(say('Microsoft Graph 429 ApplicationThrottled: slow down')).toMatch(/rate limiting/);
    expect(say('AADSTS700082: The refresh token has expired due to inactivity.')).toMatch(/sign-in for this account has expired/);
  });
});
