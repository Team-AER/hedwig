# Outlook.com, Microsoft 365 and Exchange accounts

Hedwig reads and sends mail over IMAP and SMTP. For Microsoft mailboxes that means one of two
paths:

| Mailbox | How Hedwig signs in | What has to be set up |
|---|---|---|
| Outlook.com, Hotmail, Live (personal) | Microsoft sign-in (OAuth 2.0, SASL XOAUTH2) | An app registration, once per Hedwig install |
| Microsoft 365 / Exchange Online (work or school) | Microsoft sign-in (OAuth 2.0, SASL XOAUTH2) | The app registration, plus IMAP and SMTP AUTH enabled on the mailbox |
| Exchange Server (on-premises) | Username and password | IMAP4 and SMTP AUTH enabled by the Exchange admin |

Microsoft no longer accepts a password on IMAP or SMTP for Exchange Online (basic auth was
switched off in 2022) or for Outlook.com (September 2024). An app password does not help. Those
accounts only work once an admin has registered Hedwig with the Microsoft identity platform.

Hedwig talks IMAP/SMTP only. Exchange Web Services (EWS), Microsoft Graph mail and ActiveSync
are not supported.

## For users

**Outlook.com or Microsoft 365.** Settings → Accounts → Add account → **Outlook / Microsoft 365**
→ **Sign in with Microsoft**. A new tab opens at Microsoft; sign in, accept the permissions, and
the account appears in the list. Hedwig fills in `outlook.office365.com` (IMAP 993, TLS) and
`smtp.office365.com` (SMTP 587, STARTTLS) itself.

If the form shows a password field with the note "Outlook.com and Microsoft 365 no longer accept
passwords for IMAP", the admin has not configured Microsoft sign-in yet (next section). The Add
button stays disabled for these hosts because Microsoft would refuse the password.

Settings → Integrations → Microsoft 365 / Outlook.com offers the same sign-in, and a
**device code** option for personal accounts (needs "Allow public client flows", below).

An account that was added earlier with a password can be fixed by signing in with Microsoft for
the same address: Hedwig switches the existing account to OAuth and the Exchange Online hosts.

**Exchange Server (on-premises).** Add account → **Exchange**. Enter your server's IMAP and SMTP
host names (often the same, such as `mail.example.com`), keep ports 993 and 587, and use your
email address or `DOMAIN\username` with your normal password. A `DOMAIN\username` or
`user@domain\shared-mailbox` login makes the IMAP client use `LOGIN` instead of
`AUTHENTICATE PLAIN`, which is what Exchange expects for those forms.

## For the admin: register Hedwig with Microsoft (Outlook.com and Microsoft 365)

1. Open the **Microsoft Entra admin center** (entra.microsoft.com) → **Identity → Applications →
   App registrations → New registration**.
   - Name: `Hedwig`.
   - Supported account types:
     - **Accounts in any organizational directory and personal Microsoft accounts** if anyone will
       connect an Outlook.com / Hotmail / Live address. Personal accounts only work with this
       choice.
     - **Accounts in this organizational directory only** if only your Microsoft 365 tenant's
       mailboxes will connect.
   - Redirect URI: platform **Web**,
     `https://hedwig.brainfc.uk/oauth/microsoft/callback`
     (generally `${APP_URL}/oauth/microsoft/callback`; the OAuth routes are served at `/oauth`,
     not under `/api`).
2. **Certificates & secrets → Client secrets → New client secret.** Copy the **Value** (not the
   Secret ID). Secrets expire (24 months at most): put a reminder in the calendar. When it
   expires, sign-in fails with `AADSTS7000222` and connected accounts stop refreshing until a new
   secret is set.
3. **API permissions → Add a permission.**
   - **APIs my organization uses → Office 365 Exchange Online → Delegated permissions**:
     `IMAP.AccessAsUser.All` and `SMTP.Send`. (The portal also lists these two under
     Microsoft Graph; either entry works, because Hedwig asks for the
     `https://outlook.office.com/...` scopes.)
   - **Microsoft Graph → Delegated permissions**: `offline_access`, `openid`, `email`, `profile`.
   - For a work tenant, **Grant admin consent for <tenant>**, or each user consents on first
     sign-in if the tenant allows user consent.
4. Optional, for the device-code button in Settings → Integrations: **Authentication → Advanced
   settings → Allow public client flows → Yes**.
5. Copy the **Application (client) ID** and, for a single-tenant app, the **Directory (tenant)
   ID** from the Overview page.

### Configure Hedwig

Either fill in Settings → Integrations → Microsoft 365 / Outlook.com (stored encrypted in the
database), or set these in `/opt/hedwig/.env` on the Hedwig LXC and redeploy:

```
MICROSOFT_CLIENT_ID=<Application (client) ID>
MICROSOFT_CLIENT_SECRET=<client secret Value>
MICROSOFT_TENANT=common
MICROSOFT_REDIRECT_URI=https://hedwig.brainfc.uk/oauth/microsoft/callback
```

- `MICROSOFT_TENANT`: `common` (work and personal accounts), `organizations` (work/school
  only), `consumers` (personal only), or your tenant ID / `contoso.onmicrosoft.com` for a
  single-tenant app. Defaults to `common`.
- `MICROSOFT_REDIRECT_URI` may be left empty: it defaults to `${APP_URL}/oauth/microsoft/callback`.
  It must match the URI registered in Entra exactly.
- Upstream MailFlow's names `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` and
  `MS_REDIRECT_URI` still work. They are what the Integrations tab writes, and they take
  precedence over the `MICROSOFT_*` names.
- `docker-compose.hedwig.yml` passes the four `MICROSOFT_*` variables to the backend and
  worker. `deploy/deploy-lxc.sh` never overwrites an existing `.env`, so add them by hand on
  an install that already has one.

`GET /api/integrations/status` reports `microsoft.configured: true` once a client ID is set,
and the Add account form then offers **Sign in with Microsoft**.

### Microsoft 365 mailbox settings

OAuth replaces the password, but the protocols still have to be allowed for the mailbox. In
Exchange Online PowerShell:

```powershell
Set-CASMailbox -Identity user@contoso.com -ImapEnabled $true
# SMTP AUTH is off by default in newer tenants; OAuth sending still needs it on.
Set-TransportConfig -SmtpClientAuthenticationDisabled $false          # tenant-wide, or
Set-CASMailbox -Identity user@contoso.com -SmtpClientAuthenticationDisabled $false   # per mailbox
```

The Microsoft 365 admin center exposes the same switches under Users → Active users → Mail →
Manage email apps (IMAP, Authenticated SMTP).

### How the connection works

- Hedwig asks for `offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send`.
- It stores the access and refresh tokens encrypted on the account (`oauth_provider = 'microsoft'`)
  and refreshes the access token when it has under five minutes left, before every IMAP connect
  and SMTP send. Refreshes of one account are serialised because Microsoft rotates the refresh
  token each time.
- IMAP logs in with `AUTHENTICATE XOAUTH2` as the account's user principal name (the id_token's
  `preferred_username`), which is what Exchange Online checks the token against.
- Exchange ends an IMAP IDLE after 30 minutes and drops a session that has been quiet for 30
  minutes, so Hedwig re-issues IDLE every 25 minutes and sends a NOOP every 10 minutes when
  IDLE is not running.

### Troubleshooting

| Symptom | Cause |
|---|---|
| "Microsoft OAuth not configured" | No client ID, or no redirect URI and no `APP_URL`. |
| `AADSTS50011` redirect URI mismatch | The URI in Entra differs from `MICROSOFT_REDIRECT_URI` / `${APP_URL}/oauth/microsoft/callback` (scheme, host, trailing slash). |
| `AADSTS50020` / personal account refused | The app registration allows only organisational accounts, or `MICROSOFT_TENANT` is a tenant ID. Use "any organizational directory and personal Microsoft accounts" with `common`. |
| `AADSTS65001` consent required | Grant admin consent in Entra for the tenant. |
| `AADSTS7000222` / `AADSTS7000215` | Client secret expired or wrong value (the Secret ID was copied instead of the Value). |
| IMAP `AUTHENTICATE failed` after sign-in | IMAP disabled for the mailbox (`ImapEnabled`), or the account logs in as an alias. Sign in again so Hedwig records the UPN. |
| Sending fails with `535 5.7.139` | SMTP AUTH disabled for the tenant or mailbox (see above). |

## For the Exchange admin: on-premises Exchange Server

1. **Enable IMAP4.** Start the services and set them to automatic on each Mailbox server:
   `Microsoft Exchange IMAP4` and `Microsoft Exchange IMAP4 Backend`. Then:
   ```powershell
   Set-ImapSettings -ExternalConnectionSettings "mail.example.com:993:SSL" -X509CertificateName mail.example.com
   Set-ImapSettings -LoginType SecureLogin     # accept passwords only over TLS
   Set-CASMailbox -Identity user@example.com -ImapEnabled $true
   Restart-Service MSExchangeIMAP4; Restart-Service MSExchangeIMAP4BE
   ```
2. **Enable SMTP AUTH for client submission** on the "Client Frontend" receive connector (port
   587, TLS, "Exchange users" permission group). It is on by default in Exchange 2013 and later.
3. **Ports.** Hedwig needs 993 (IMAPS) and 587 (SMTP with STARTTLS) reachable from the Hedwig
   host. Plain IMAP on 143 is refused unless an admin enables "Allow insecure TLS".
4. **Certificate.** Use a certificate the Hedwig host trusts (a public CA, or your internal CA
   added to the backend container's trust store) and bind it to IMAP and SMTP. For a
   self-signed certificate, a Hedwig admin must turn on **Settings → Security → Allow insecure
   TLS**; the account form then shows **Skip TLS certificate verification** below the password.
   Use that only on a trusted network.
5. **Private hosts.** If the Exchange server resolves to a private address, a Hedwig admin must
   also allow private hosts under Settings → Security.
6. **Username.** Usually the email address. `DOMAIN\username` works as well.

Exchange Server does not speak XOAUTH2 unless it is set up for hybrid Modern Authentication.
Hedwig's Microsoft sign-in only targets Exchange Online.
