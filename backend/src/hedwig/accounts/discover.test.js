import { describe, it, expect } from 'vitest';
import { addressDomain, providerForDomain, providerForMx, discoverProvider } from './discover.js';

const mx = (...hosts) => hosts.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
const noMx = async () => { throw Object.assign(new Error('queryMx ENODATA'), { code: 'ENODATA' }); };

describe('addressDomain', () => {
  it('returns the lower-case ASCII domain of an address', () => {
    expect(addressDomain(' Ana@Example.ORG ')).toBe('example.org');
    expect(addressDomain('ana@bücher.example')).toBe('xn--bcher-kva.example');
    expect(addressDomain('ana@example.org.')).toBe('example.org');
  });

  it('rejects what is not an address', () => {
    for (const bad of [undefined, 42, '', 'ana', 'ana@', '@example.org', 'a@b@example.org', 'ana@localhost', 'ana@-bad.example', 'a b@example.org', 'ana@exa_mple.org']) {
      expect(addressDomain(bad)).toBeNull();
    }
  });
});

describe('providerForDomain', () => {
  it('knows the consumer domains of each provider', () => {
    expect(providerForDomain('gmail.com')).toBe('google');
    expect(providerForDomain('googlemail.com')).toBe('google');
    expect(providerForDomain('outlook.com')).toBe('microsoft');
    expect(providerForDomain('hotmail.co.uk')).toBe('microsoft');
    expect(providerForDomain('live.fr')).toBe('microsoft');
    expect(providerForDomain('msn.com')).toBe('microsoft');
    expect(providerForDomain('yahoo.co.in')).toBe('yahoo');
    expect(providerForDomain('ymail.com')).toBe('yahoo');
    expect(providerForDomain('icloud.com')).toBe('icloud');
    expect(providerForDomain('me.com')).toBe('icloud');
  });

  it('does not match look-alikes', () => {
    expect(providerForDomain('notgmail.com')).toBeNull();
    expect(providerForDomain('gmail.com.evil.example')).toBeNull();
    expect(providerForDomain('mail.outlook.com.evil.example')).toBeNull();
    expect(providerForDomain('example.org')).toBeNull();
  });
});

describe('providerForMx', () => {
  it('recognises Workspace, Microsoft 365, Yahoo and iCloud+ custom domains', () => {
    expect(providerForMx(mx('aspmx.l.google.com', 'alt1.aspmx.l.google.com'))).toBe('google');
    expect(providerForMx(mx('smtp.google.com.'))).toBe('google');
    expect(providerForMx(mx('contoso-com.mail.protection.outlook.com'))).toBe('microsoft');
    expect(providerForMx(mx('example-org.olc.protection.outlook.com'))).toBe('microsoft');
    expect(providerForMx(mx('mx-biz.mail.am0.yahoodns.net'))).toBe('yahoo');
    expect(providerForMx(mx('mx01.mail.icloud.com', 'mx02.mail.icloud.com'))).toBe('icloud');
  });

  it('follows MX preference, skipping hosts it does not know', () => {
    expect(providerForMx([
      { exchange: 'aspmx.l.google.com', priority: 20 },
      { exchange: 'filter.example-gateway.net', priority: 5 },
      { exchange: 'contoso-com.mail.protection.outlook.com', priority: 10 },
    ])).toBe('microsoft');
  });

  it('is null for other hosts, look-alikes and empty answers', () => {
    expect(providerForMx(mx('mx.example.org'))).toBeNull();
    expect(providerForMx(mx('google.com.evil.example'))).toBeNull();
    expect(providerForMx([])).toBeNull();
    expect(providerForMx(undefined)).toBeNull();
  });
});

describe('discoverProvider', () => {
  it('answers from the domain without a DNS lookup', async () => {
    const lookupMx = async () => { throw new Error('should not be called'); };
    expect(await discoverProvider('ana@gmail.com', { lookupMx })).toEqual({ domain: 'gmail.com', provider: 'google', source: 'domain' });
  });

  it('falls back to MX for a company domain', async () => {
    const lookupMx = async (domain) => (domain === 'contoso.example' ? mx('contoso-example.mail.protection.outlook.com') : []);
    expect(await discoverProvider('ana@contoso.example', { lookupMx })).toEqual({ domain: 'contoso.example', provider: 'microsoft', source: 'mx' });
  });

  it('is provider null for an unknown host or a failed lookup, never an error', async () => {
    expect(await discoverProvider('ana@example.org', { lookupMx: async () => mx('mx.example.org') }))
      .toEqual({ domain: 'example.org', provider: null, source: null });
    expect(await discoverProvider('ana@example.org', { lookupMx: noMx }))
      .toEqual({ domain: 'example.org', provider: null, source: null });
  });

  it('rejects something that is not an address with a 400', async () => {
    await expect(discoverProvider('ana', { lookupMx: noMx })).rejects.toMatchObject({ status: 400 });
  });
});
