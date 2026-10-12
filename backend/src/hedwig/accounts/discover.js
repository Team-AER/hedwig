// Which mail provider hosts an address, so Add account can send it to the right sign-in: the
// address's own domain first (gmail.com, outlook.com…), then the domain's MX records, which is how
// a Google Workspace or Microsoft 365 company domain is recognised. Pure apart from the injected
// MX resolver, and it never fails: an unknown or unresolvable domain is provider null, and the
// screen falls back to the IMAP form.
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';

export const PROVIDERS = ['google', 'microsoft', 'yahoo', 'icloud'];

const DOMAIN_RULES = [
  ['google', /^(gmail|googlemail)\.com$/],
  ['microsoft', /^(outlook|hotmail|live)\.[a-z.]+$|^(msn|passport|windowslive)\.com$/],
  ['yahoo', /^yahoo\.[a-z.]+$|^(ymail|rocketmail)\.com$/],
  ['icloud', /^(icloud|me|mac)\.com$/],
];

// MX hosts per provider: Workspace (aspmx.l.google.com, smtp.google.com), Microsoft 365 and
// Outlook.com custom domains (*.mail.protection.outlook.com, *.olc.protection.outlook.com),
// Yahoo small business (*.yahoodns.net), iCloud+ custom domains (mx01.mail.icloud.com).
const MX_RULES = [
  ['google', /(^|\.)(google|googlemail)\.com$/],
  ['microsoft', /(^|\.)outlook\.com$/],
  ['yahoo', /(^|\.)yahoodns\.net$/],
  ['icloud', /(^|\.)mail\.icloud\.com$/],
];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** The address's domain in ASCII (punycode) lower case, or null when it is not an address. */
export function addressDomain(email) {
  if (typeof email !== 'string') return null;
  const v = email.trim();
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (v.length > 254 || /[\s\0-\x1f\x7f]/.test(v)) return null;
  const at = v.lastIndexOf('@');
  if (at < 1 || at === v.length - 1 || v.indexOf('@') !== at) return null;
  const domain = domainToASCII(v.slice(at + 1).replace(/\.$/, '').toLowerCase());
  if (!domain || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return domain;
}

const match = (rules, host) => rules.find(([, re]) => re.test(host))?.[0] ?? null;

export function providerForDomain(domain) {
  return match(DOMAIN_RULES, domain);
}

/** The provider the lowest-preference MX host belongs to, or null. */
export function providerForMx(records) {
  const hosts = [...(records || [])]
    .filter((r) => r && typeof r.exchange === 'string')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
  for (const host of hosts) {
    const provider = match(MX_RULES, host);
    if (provider) return provider;
  }
  return null;
}

let defaultResolver = null;
function resolveMx(domain) {
  // Two short tries: the Add account screen is waiting on this.
  defaultResolver ??= new Resolver({ timeout: 2000, tries: 2 });
  return defaultResolver.resolveMx(domain);
}

/**
 * { domain, provider, source } for an address. source is 'domain' or 'mx' when a provider was
 * found, else null. Throws only for something that is not an address (status 400).
 */
export async function discoverProvider(email, { lookupMx = resolveMx } = {}) {
  const domain = addressDomain(email);
  if (!domain) {
    const err = new Error('Enter a full email address, like name@example.com');
    err.status = 400;
    throw err;
  }
  const byDomain = providerForDomain(domain);
  if (byDomain) return { domain, provider: byDomain, source: 'domain' };
  try {
    const provider = providerForMx(await lookupMx(domain));
    return { domain, provider, source: provider ? 'mx' : null };
  } catch {
    return { domain, provider: null, source: null };
  }
}
