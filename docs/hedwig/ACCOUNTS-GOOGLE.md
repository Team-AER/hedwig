# Gmail and Google Workspace accounts

Hedwig reads and sends Gmail over IMAP and SMTP. It can sign in two ways:

| How | Works for | What has to be set up |
|---|---|---|
| **Sign in with Google** (OAuth 2.0, SASL XOAUTH2) | Gmail and Google Workspace | An OAuth client, once per Hedwig install (below) |
| App password | Personal Gmail with 2-Step Verification | Nothing on the server. Workspace admins can switch app passwords off. |

## For users

Settings → Accounts → **Add account** → **Google**. A window opens at Google. Choose the
account, allow access, and the window closes. The account appears in the list with "Signed in
with Google". Hedwig fills in `imap.gmail.com` (993, TLS) and `smtp.gmail.com` (587, STARTTLS)
itself.

- For a company address on Google Workspace, pick **Other mail account** and type the address.
  Hedwig finds Google from the domain's MX records and opens the same sign-in with the address
  filled in.
- If Google sign-in is not set up yet, an admin sees a setup card instead (next section).
  Everyone else sees "Ask your Hedwig admin" and can use **Use a Gmail app password instead**.
  The app password comes from https://myaccount.google.com/apppasswords.
- An account that was added with an app password switches to Google sign-in when you sign in
  with Google for the same address.
- When Google ends the sign-in, the account shows an error and **Sign in again**. That happens
  when access is revoked, after a password change, or after 7 days for an app in Testing (see
  below).

## For the admin: create the OAuth client

The scope Hedwig needs for IMAP and SMTP, `https://mail.google.com/`, is a *restricted* scope.
Google does not let one shared client serve every Hedwig install without a paid security
assessment, so each install registers its own.

1. Open https://console.cloud.google.com and create a project, for example `Hedwig`.
2. **APIs & Services → Library → Gmail API → Enable.** IMAP itself does not use the API, but the
   scope picker only lists Gmail scopes once it is enabled.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **Branding:** app name `Hedwig` and a support email.
   - **Audience:** **Internal** if the project belongs to a Google Workspace organisation and only
     that organisation's mailboxes will connect. Otherwise **External** (see "Testing or in
     production" below).
   - **Data access → Add or remove scopes:** `https://mail.google.com/`, plus `openid`, `email`
     and `profile`.
4. **Clients → Create client:**
   - Application type: **Web application**.
   - Authorized redirect URI: `${APP_URL}/oauth/google/callback`. Use the exact address people
     open Hedwig at, with no trailing slash, such as `https://mail.example.org/oauth/google/callback`.
     The setup card in Hedwig shows it with a copy button.
   - Copy the **Client ID** and **Client secret**.

### Testing or in production (External only)

- **Testing:** works at once for the addresses listed under **Audience → Test users** (up to
  100). Google expires the refresh token after **7 days**, so each account needs **Sign in again**
  every week.
- **In production:** no weekly expiry. Until Google verifies the app, people see "Google hasn't
  verified this app" and continue through **Advanced → Go to Hedwig**, and the app is limited to
  100 users. That is usually fine for a household install. Full verification for a restricted
  scope needs a security assessment.

### Configure Hedwig

Pick one:

- **Settings → Accounts → Add account → Google** (admins): paste the client ID and secret into
  the setup card and click **Save**. The values are stored encrypted in the database.
- **Settings → Integrations → Google**, which writes the same thing.
- `.env` on the server, then redeploy:

  ```
  GOOGLE_CLIENT_ID=<client ID>
  GOOGLE_CLIENT_SECRET=<client secret>
  # Optional: defaults to ${APP_URL}/oauth/google/callback
  GOOGLE_REDIRECT_URI=
  ```

  `docker-compose.hedwig.yml` passes these to the backend and the worker. A deploy never
  overwrites an existing `.env`, so on an existing install add them by hand.

`GET /api/integrations/status` reports `google.configured: true` once a client ID and a
redirect URI (explicit, or derived from `APP_URL`) are set. The Add account screen then offers
the sign-in.

### Google Workspace admin settings

- **IMAP access:** Admin console → Apps → Google Workspace → Gmail → End User Access → POP and
  IMAP access must allow IMAP for the users.
- **Third-party app access:** if the organisation restricts it, go to Admin console →
  Security → Access and data control → API controls → App access control, and mark the Hedwig
  client ID as trusted.

### How the connection works

- Hedwig asks for `https://mail.google.com/ openid email profile` with `access_type=offline` and
  `prompt=consent select_account`. That is the only way Google returns a refresh token on every
  sign-in.
- It stores the access and refresh tokens encrypted on the account (`oauth_provider = 'google'`).
  It refreshes the access token when under five minutes are left, before every IMAP connect and
  SMTP send.
- IMAP and SMTP log in with `AUTHENTICATE XOAUTH2` as the signed-in address.

### Troubleshooting

| Symptom | Cause |
|---|---|
| "Google sign-in is not set up on this Hedwig yet" | No client ID, or no redirect URI and no `APP_URL`. |
| `Error 400: redirect_uri_mismatch` | The URI registered with the client differs from `${APP_URL}/oauth/google/callback` (scheme, host, port, trailing slash). |
| "Access blocked: Hedwig has not completed the Google verification process" | The app is External and in Testing, and the address is not a test user. |
| "Google did not return a refresh token" | Revoke Hedwig at https://myaccount.google.com/permissions and sign in again. |
| Sign-in lapses after a week | The app is in Testing. Publish it, or sign in again weekly. |
| IMAP `AUTHENTICATE failed` right after sign-in | IMAP is turned off for the Workspace user (see above). |
