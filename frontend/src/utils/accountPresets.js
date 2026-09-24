// Add-account presets for Settings → Accounts, and the rules for when the form must hand
// off to Microsoft sign-in instead of taking a password. Pure so node --test can pin it.
//
// Microsoft removed password (basic) auth for IMAP/SMTP on Exchange Online / Microsoft 365
// (2022) and Outlook.com (September 2024); those mailboxes connect through
// /oauth/microsoft (backend/src/routes/oauth.js) when the server has Microsoft OAuth
// configured. On-premises Exchange still takes a password once IMAP and SMTP AUTH are on.

export const ACCOUNT_PRESETS = {
  gmail:    { imap_host: 'imap.gmail.com',       imap_port: 993, smtp_host: 'smtp.gmail.com',     smtp_port: 587 },
  outlook:  { imap_host: 'outlook.office365.com', imap_port: 993, smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_tls: 'STARTTLS', oauthProvider: 'microsoft' },
  yahoo:    { imap_host: 'imap.mail.yahoo.com',  imap_port: 993, smtp_host: 'smtp.mail.yahoo.com', smtp_port: 587 },
  icloud:   { imap_host: 'imap.mail.me.com',     imap_port: 993, smtp_host: 'smtp.mail.me.com',   smtp_port: 587 },
  // On-premises Exchange: the host is the organisation's own, so leave it for the user.
  exchange: { imap_host: '', imap_port: 993, smtp_host: '', smtp_port: 587, smtp_tls: 'STARTTLS', onPremExchange: true },
  custom:   {},
};

export const PRESET_ORDER = ['gmail', 'outlook', 'yahoo', 'icloud', 'exchange', 'custom'];

export const PRESET_LABEL_KEYS = {
  gmail: 'admin.accounts.presetGmail',
  outlook: 'admin.accounts.presetOutlook',
  yahoo: 'admin.accounts.presetYahoo',
  icloud: 'admin.accounts.presetIcloud',
  exchange: 'admin.accounts.presetExchange',
  custom: 'admin.accounts.presetCustom',
};

const FORM_FIELDS = ['imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'smtp_tls'];

/** The form after choosing a preset. Custom (no fields) leaves the form as it is. */
export function applyPreset(form, key) {
  const preset = ACCOUNT_PRESETS[key];
  if (!preset) return form;
  const next = { ...form };
  for (const field of FORM_FIELDS) {
    if (field in preset) next[field] = preset[field];
  }
  return next;
}

export function isMicrosoftImapHost(host) {
  const h = (host || '').toLowerCase();
  return h.includes('.outlook.com') || h.includes('office365.com') || h.includes('outlook.office.com')
    || h.includes('.hotmail.com') || h.includes('.live.com');
}

/**
 * How the form treats a Microsoft-hosted mailbox:
 *   'oauth'        — show "Sign in with Microsoft" instead of the password fields
 *   'unconfigured' — keep the password field but explain that the admin must configure
 *                    Microsoft sign-in (a password will be refused by Microsoft)
 *   null           — not a Microsoft mailbox, or already connected with Microsoft OAuth
 * integrations is the /api/integrations/status payload ({ microsoft: { configured } }).
 */
export function microsoftAuthMode({ presetKey = null, imapHost = '', account = null, integrations = null } = {}) {
  if (account?.oauth_provider === 'microsoft') return null;
  const microsoft = presetKey === 'outlook' || (presetKey !== 'exchange' && isMicrosoftImapHost(imapHost));
  if (!microsoft) return null;
  return integrations?.microsoft?.configured ? 'oauth' : 'unconfigured';
}
