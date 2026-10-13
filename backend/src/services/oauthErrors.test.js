import { describe, it, expect } from 'vitest';
import { SignInError, providerErrorMessage, signInFailureMessage } from './oauthErrors.js';

describe('providerErrorMessage', () => {
  it('reads a cancelled consent as cancelled', () => {
    expect(providerErrorMessage('access_denied')).toBe('Sign-in was cancelled.');
    expect(providerErrorMessage('access_denied', 'AADSTS65004: User declined to consent to access the app.')).toBe('Sign-in was cancelled.');
  });

  it('keeps an AADSTS access_denied that is not a user decline (admin policy, for instance)', () => {
    expect(providerErrorMessage('access_denied', 'AADSTS50105: Your administrator has configured the application to block users.'))
      .toBe('AADSTS50105: Your administrator has configured the application to block users.');
  });

  it('keeps only the first line of a Microsoft description (no trace or correlation ids)', () => {
    const description = "AADSTS50011: The redirect URI 'https://h.example/oauth/microsoft/callback' does not match.\r\nTrace ID: 1\r\nCorrelation ID: 2\r\nTimestamp: 2026-10-12";
    expect(providerErrorMessage('invalid_request', description))
      .toBe("AADSTS50011: The redirect URI 'https://h.example/oauth/microsoft/callback' does not match.");
  });

  it('drops the Trace ID / Correlation ID tail a token response puts on the same line', () => {
    const description = "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '00000000-1111-2222-3333-444444444444'. Trace ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee Correlation ID: ffffffff-0000-1111-2222-333333333333 Timestamp: 2026-10-13 10:00:00Z";
    expect(providerErrorMessage('invalid_client', description))
      .toBe("AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '00000000-1111-2222-3333-444444444444'.");
  });

  it('falls back to the error code, strips control characters and caps the length', () => {
    expect(providerErrorMessage('invalid_client')).toBe('invalid_client');
    expect(providerErrorMessage('x', 'bad\u0000thing\u0007here')).toBe('bad thing here');
    expect(providerErrorMessage('x', 'y'.repeat(1000))).toHaveLength(300);
    expect(providerErrorMessage(undefined, undefined)).toBe('Sign-in failed.');
  });
});

describe('signInFailureMessage', () => {
  it('shows a SignInError and hides anything else', () => {
    expect(signInFailureMessage(new SignInError('Google did not return a refresh token.'))).toBe('Google did not return a refresh token.');
    expect(signInFailureMessage(new Error('duplicate key value violates unique constraint "email_accounts_pkey"')))
      .toBe('Sign-in failed. The server log has the details.');
  });
});
