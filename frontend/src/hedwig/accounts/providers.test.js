// Add account: which way each provider connects, and what the screen sends. Run with
// node --test src/hedwig/accounts/providers.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, providerFlow, providerForDiscovery, looksLikeAddress, redirectUriFor, signInPath,
  nextAccountColor, ACCOUNT_COLORS, appPasswordAccount, manualFormStart,
} from './providers.js';

const configured = (google, microsoft) => ({ google: { configured: google }, microsoft: { configured: microsoft } });

describe('the provider list', () => {
  test('Google, Microsoft, Yahoo, iCloud, Other in that order', () => {
    assert.deepEqual(PROVIDERS.map((p) => p.id), ['google', 'microsoft', 'yahoo', 'icloud', 'other']);
  });

  test('only Google and Microsoft sign in; Microsoft has no app-password fallback', () => {
    assert.deepEqual(PROVIDERS.filter((p) => p.signIn).map((p) => p.id), ['google', 'microsoft']);
    assert.equal(PROVIDERS.find((p) => p.id === 'microsoft').appPasswordUrl, null);
    for (const id of ['google', 'yahoo', 'icloud']) {
      assert.match(PROVIDERS.find((p) => p.id === id).appPasswordUrl, /^https:\/\//);
    }
  });
});

describe('providerFlow', () => {
  test('a configured provider signs in, for admins and everyone else', () => {
    assert.equal(providerFlow('google', { integrations: configured(true, false), isAdmin: false }), 'signin');
    assert.equal(providerFlow('microsoft', { integrations: configured(false, true), isAdmin: true }), 'signin');
  });

  test('an unconfigured provider is the setup card for an admin and unavailable for anyone else', () => {
    assert.equal(providerFlow('google', { integrations: configured(false, true), isAdmin: true }), 'setup');
    assert.equal(providerFlow('microsoft', { integrations: configured(true, false), isAdmin: false }), 'unavailable');
    assert.equal(providerFlow('google', { integrations: null, isAdmin: false }), 'unavailable', 'status not loaded yet');
  });

  test('Yahoo and iCloud take an app password; Other asks for the address; unknown is null', () => {
    assert.equal(providerFlow('yahoo', { integrations: configured(true, true) }), 'appPassword');
    assert.equal(providerFlow('icloud'), 'appPassword');
    assert.equal(providerFlow('other'), 'address');
    assert.equal(providerFlow('aol'), null);
  });
});

test('providerForDiscovery maps a discover answer to a tile, anything unknown to other', () => {
  assert.equal(providerForDiscovery({ provider: 'microsoft', source: 'mx' }), 'microsoft');
  assert.equal(providerForDiscovery({ provider: 'icloud' }), 'icloud');
  assert.equal(providerForDiscovery({ provider: null }), 'other');
  assert.equal(providerForDiscovery({ provider: 'aol' }), 'other');
  assert.equal(providerForDiscovery(null), 'other');
});

test('looksLikeAddress', () => {
  assert.equal(looksLikeAddress(' ana@example.org '), true);
  for (const bad of ['', 'ana', 'ana@example', 'a b@example.org', null, 42]) assert.equal(looksLikeAddress(bad), false);
});

describe('sign-in URLs', () => {
  test('the redirect URI is the origin callback, with no doubled slash', () => {
    assert.equal(redirectUriFor('google', 'https://mail.example.org/'), 'https://mail.example.org/oauth/google/callback');
    assert.equal(redirectUriFor('microsoft', 'https://mail.example.org'), 'https://mail.example.org/oauth/microsoft/callback');
  });

  test('the start path marks the sign-in window and carries a plain address as login_hint', () => {
    assert.equal(signInPath('google'), '/oauth/google?popup=1');
    assert.equal(signInPath('microsoft', ' ana@contoso.example '), '/oauth/microsoft?popup=1&login_hint=ana%40contoso.example');
    assert.equal(signInPath('google', 'not an address'), '/oauth/google?popup=1');
  });
});

describe('new account values', () => {
  test('nextAccountColor takes the first unused colour, ignoring case', () => {
    assert.equal(nextAccountColor([]), ACCOUNT_COLORS[0]);
    assert.equal(nextAccountColor([{ color: '#6366F1' }, { color: '#8b5cf6' }]), ACCOUNT_COLORS[2]);
    const all = ACCOUNT_COLORS.map((color) => ({ color }));
    assert.ok(ACCOUNT_COLORS.includes(nextAccountColor(all)), 'still a palette colour when all are taken');
  });

  test('appPasswordAccount fills in the provider servers and logs in as the address', () => {
    assert.deepEqual(appPasswordAccount('yahoo', { email: ' ana@yahoo.com ', password: 'abcdefghijklmnop', accounts: [{ color: '#6366f1' }] }), {
      name: 'ana@yahoo.com', email_address: 'ana@yahoo.com', color: '#8b5cf6', protocol: 'imap',
      imap_host: 'imap.mail.yahoo.com', imap_port: 993, smtp_host: 'smtp.mail.yahoo.com', smtp_port: 587, smtp_tls: 'STARTTLS',
      auth_user: 'ana@yahoo.com', auth_pass: 'abcdefghijklmnop',
    });
    const icloud = appPasswordAccount('icloud', { email: 'ana@icloud.com', password: 'x' });
    assert.equal(icloud.imap_host, 'imap.mail.me.com');
    assert.equal(appPasswordAccount('google', { email: 'ana@gmail.com', password: 'x' }).imap_host, 'imap.gmail.com');
  });

  test('manualFormStart prefills the address and the provider servers, empty for Other', () => {
    const other = manualFormStart('other', { email: 'ana@example.org' });
    assert.equal(other.email_address, 'ana@example.org');
    assert.equal(other.auth_user, 'ana@example.org');
    assert.equal(other.imap_host, '');
    assert.equal(other.imap_port, 993);
    assert.equal(other.auth_pass, '');
    assert.equal(manualFormStart('yahoo', { email: 'ana@yahoo.com' }).smtp_host, 'smtp.mail.yahoo.com');
    assert.equal('id' in other, false, 'no id: AccountForm opens in add mode');
  });
});
