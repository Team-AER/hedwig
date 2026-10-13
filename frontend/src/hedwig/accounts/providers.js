// Settings → Accounts → Add account: the provider list and how each one connects. Pure so
// node --test can pin it; AddAccount.jsx renders it. See docs/hedwig/PLAN-CLICK-TO-SIGN-IN.md.
//
// Google and Microsoft connect by signing in (routes/oauth.js) once an admin has registered
// Hedwig with them. Yahoo and iCloud do not let other mail apps sign in with OAuth, so they take
// an app password, with the servers filled in. Other asks for the address and finds the provider
// (GET /api/hedwig/accounts/discover), falling back to the full IMAP form.
import { ACCOUNT_PRESETS } from '../../utils/accountPresets.js';

export const PROVIDERS = [
  {
    id: 'google', label: 'Google', signIn: 'google', preset: 'gmail',
    // Consumer Gmail with 2-Step Verification still takes an app password; Workspace may not.
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
    setupDoc: 'https://github.com/Team-AER/hedwig/blob/main/docs/hedwig/ACCOUNTS-GOOGLE.md',
  },
  {
    id: 'microsoft', label: 'Microsoft', signIn: 'microsoft', preset: 'outlook',
    // Outlook.com and Microsoft 365 refuse passwords on IMAP: sign-in or nothing.
    appPasswordUrl: null,
    consoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupDoc: 'https://github.com/Team-AER/hedwig/blob/main/docs/hedwig/ACCOUNTS-MICROSOFT.md',
  },
  { id: 'yahoo', label: 'Yahoo', signIn: null, preset: 'yahoo', appPasswordUrl: 'https://login.yahoo.com/account/security' },
  { id: 'icloud', label: 'iCloud', signIn: null, preset: 'icloud', appPasswordUrl: 'https://account.apple.com/account/manage' },
  { id: 'other', label: null, signIn: null, preset: null, appPasswordUrl: null },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) || null;

/**
 * What choosing a provider opens:
 *   'signin'      the provider's sign-in window
 *   'setup'       sign-in is not configured and the user is an admin: the one-time setup card
 *   'unavailable' sign-in is not configured and the user cannot configure it
 *   'appPassword' address + app password, servers filled in
 *   'address'     Other: ask for the address first
 * integrations is the /api/integrations/status payload ({ google: { configured }, … }).
 */
export function providerFlow(id, { integrations = null, isAdmin = false } = {}) {
  const p = providerById(id);
  if (!p) return null;
  if (p.signIn) {
    if (integrations?.[p.signIn]?.configured) return 'signin';
    return isAdmin ? 'setup' : 'unavailable';
  }
  return p.id === 'other' ? 'address' : 'appPassword';
}

/** The provider tile an address belongs to, from a discover answer ({ provider }), else 'other'. */
export function providerForDiscovery(discovered) {
  const id = discovered?.provider;
  return id && providerById(id) && id !== 'other' ? id : 'other';
}

/** A loose address check for the form; the server validates for real. */
export function looksLikeAddress(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** The redirect URI the admin registers with the provider: this origin's callback route. */
export function redirectUriFor(signIn, origin) {
  return `${String(origin || '').replace(/\/+$/, '')}/oauth/${signIn}/callback`;
}

/** /oauth/<provider>?popup=1[&login_hint=<address>] — popup=1 marks the result for the sign-in window. */
export function signInPath(signIn, loginHint) {
  const q = new URLSearchParams({ popup: '1' });
  if (looksLikeAddress(loginHint)) q.set('login_hint', loginHint.trim());
  return `/oauth/${signIn}?${q}`;
}

// The palette Settings → Accounts offers (AdminPanel COLORS); a new account takes the first
// colour no other account has.
export const ACCOUNT_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#14b8a6'];

export function nextAccountColor(accounts = []) {
  const used = new Set((accounts || []).map((a) => String(a?.color || '').toLowerCase()));
  return ACCOUNT_COLORS.find((c) => !used.has(c)) || ACCOUNT_COLORS[(accounts?.length || 0) % ACCOUNT_COLORS.length];
}

/** POST /api/accounts body for an address + app password on a provider's own servers. */
export function appPasswordAccount(id, { email, password, accounts = [] }) {
  const p = providerById(id);
  const preset = ACCOUNT_PRESETS[p?.preset] || {};
  const address = String(email || '').trim();
  return {
    name: address,
    email_address: address,
    color: nextAccountColor(accounts),
    protocol: 'imap',
    imap_host: preset.imap_host,
    imap_port: preset.imap_port || 993,
    smtp_host: preset.smtp_host,
    smtp_port: preset.smtp_port || 587,
    smtp_tls: preset.smtp_tls || 'STARTTLS',
    auth_user: address,
    auth_pass: password,
  };
}

/** The full IMAP form's starting values for an address (Other, or "Server settings"). */
export function manualFormStart(id, { email = '', accounts = [] } = {}) {
  const p = providerById(id);
  const preset = ACCOUNT_PRESETS[p?.preset] || {};
  const address = String(email || '').trim();
  return {
    name: address, email_address: address, color: nextAccountColor(accounts), protocol: 'imap',
    imap_host: preset.imap_host || '', imap_port: preset.imap_port || 993, imap_skip_tls_verify: false,
    smtp_host: preset.smtp_host || '', smtp_port: preset.smtp_port || 587, smtp_tls: preset.smtp_tls || 'STARTTLS',
    smtp_auth_user: '', smtp_auth_pass: '',
    auth_user: address, auth_pass: '', categorization_enabled: false, antispam_enabled: true,
    trusted_authserv_id: '',
  };
}
