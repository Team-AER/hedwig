// What a failed mailbox sign-in tells the user. routes/oauth.js ends every flow with a redirect
// to /?oauth_error=<message>, which the Add account screen shows as is, so the message has to be
// short, readable and safe in a URL. Provider errors are worth passing on (an AADSTS code tells
// the admin which Entra setting is wrong); anything else stays in the server log.

/** A failure whose message is meant for the user (our own wording, or the provider's). */
export class SignInError extends Error {}

const MAX_LENGTH = 300;

function clean(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\0-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LENGTH);
}

/**
 * The message for an OAuth `error` / `error_description` pair, from the callback query or a
 * token response. Microsoft appends Trace ID / Correlation ID / Timestamp lines to every
 * description; only the first line says what went wrong.
 */
export function providerErrorMessage(error, description) {
  if (error === 'access_denied' && !/AADSTS(?!65004)/.test(description || '')) {
    return 'Sign-in was cancelled.';
  }
  const firstLine = String(description || '').split(/\r?\n/)[0];
  return clean(firstLine) || clean(error) || 'Sign-in failed.';
}

/** The message for an error thrown while finishing a sign-in. */
export function signInFailureMessage(err) {
  if (err instanceof SignInError) return clean(err.message) || 'Sign-in failed.';
  return 'Sign-in failed. The server log has the details.';
}
