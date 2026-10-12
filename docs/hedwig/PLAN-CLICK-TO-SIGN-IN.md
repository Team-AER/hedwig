# Click to sign in: adding a mail account

Status: built 2026-10-12.

## Problem

Settings → Accounts → Add account opens an IMAP form for every provider. Picking **Gmail** or
**Outlook / Microsoft 365** fills in the host names and then asks for a username and an app
password. Outlook.com and Microsoft 365 refuse passwords altogether, and Google Workspace admins
can switch app passwords off. The server already has both OAuth flows (`routes/oauth.js`), but
the form only offers Microsoft sign-in, only once an admin has configured it, and never offers
Google sign-in.

## Goal

Adding an account is one click for the providers that allow it:

1. Settings → Accounts → **Add account** shows provider tiles: Google, Microsoft, Yahoo, iCloud,
   and Other.
2. **Google** or **Microsoft** opens the provider's sign-in in a popup. The account appears when
   the popup closes. Nothing to type.
3. **Yahoo** and **iCloud** do not let other mail apps sign in with OAuth (Yahoo restricts its
   mail scopes to approved partners; iCloud has no OAuth for IMAP). Their tiles ask for the
   address and an app password, link straight to the provider's app-password page, and fill in
   the servers.
4. **Other** asks for the address first. Domains hosted by Google Workspace or Microsoft 365
   (found by MX record) go to that provider's sign-in with the address pre-filled. Anything else
   goes to the full IMAP form, which keeps Exchange on-premises and custom servers.
5. An OAuth account whose sign-in has lapsed shows **Sign in again** in the account list, which
   re-runs the same popup for that address.

## Admin setup, once per install

OAuth needs a client registered with each provider. That cannot ship inside Hedwig: Google's
`https://mail.google.com/` scope is restricted, and a shared client would need Google's security
assessment.

- When a provider is not configured, an admin clicking its tile sees a short setup card: the
  exact redirect URI to register (with a copy button), a link to the provider's console and the
  setup doc, and fields for the client ID and secret. Saving it signs in straight away.
- A non-admin sees "Ask your Hedwig admin to turn on Google sign-in". For Google there is also
  an app-password fallback.
- Setup docs: `ACCOUNTS-GOOGLE.md` (new) and `ACCOUNTS-MICROSOFT.md`.

## Changes

Backend
- `services/oauthProviders.js`: the Google redirect URI defaults to
  `${APP_URL}/oauth/google/callback`, as Microsoft's already does. A provider counts as
  configured only when it has a client ID and a resolvable redirect URI, so the UI never offers
  a sign-in that fails with a 500. `login_hint` is passed to both providers.
- `routes/oauth.js`: `/oauth/{google,microsoft}?login_hint=` is accepted. A start that cannot
  proceed (not configured, signed out) now redirects with `oauth_error` instead of answering
  JSON, so the popup reports back. Callback failures carry a short, safe reason instead of
  "Authentication failed".
- New Hedwig module `hedwig/accounts`: `GET /api/hedwig/accounts/discover?email=` returns the
  provider for an address from a domain table, then from MX records. Pure lookup, with an
  injectable resolver for tests.
- `docker-compose.hedwig.yml` passes `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `GOOGLE_REDIRECT_URI`.

Frontend
- New `frontend/src/hedwig/accounts/`:
  - `providers.js`: the tile catalogue and the choice of flow. Pure.
  - `signIn.js`: opens the popup and waits for the result. The result arrives over
    `postMessage` or a `BroadcastChannel`, because Google's and Microsoft's pages can cut
    `window.opener` (Cross-Origin-Opener-Policy).
  - `AddAccount.jsx`: tiles, sign-in, admin setup card, app-password form, and the
    "Other" address step.
- `App.jsx`: the callback page reports on both channels. When the window cannot close itself,
  it says "Signed in. You can close this window".
- `AdminPanel.jsx`: Add account renders `AddAccount`. "Other" falls through to the existing
  `AccountForm`. OAuth accounts in the list get a provider badge, and **Sign in again** when
  they have a sync error.
- Locale keys under `hedwig.accounts.*` in all ten locales.

## Out of scope

- Yahoo / AOL OAuth needs Yahoo partner approval for mail scopes.
- iCloud has no OAuth for IMAP.
- Testing the login before saving an app-password account. It would add logins against Yahoo's
  login throttle (see the IMAP login gate). The account list shows the result within seconds.
