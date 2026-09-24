import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_PRESETS, PRESET_ORDER, PRESET_LABEL_KEYS, applyPreset, isMicrosoftImapHost, microsoftAuthMode,
} from './accountPresets.js';

describe('account presets', () => {
  test('offers Gmail, Outlook, Yahoo, iCloud, Exchange, Custom in that order', () => {
    assert.deepEqual(PRESET_ORDER, ['gmail', 'outlook', 'yahoo', 'icloud', 'exchange', 'custom']);
    for (const key of PRESET_ORDER) {
      assert.ok(ACCOUNT_PRESETS[key], `${key} preset exists`);
      assert.match(PRESET_LABEL_KEYS[key], /^admin\.accounts\.preset/);
    }
  });

  test('Outlook / Microsoft 365 uses the Exchange Online hosts: IMAP 993 TLS, SMTP 587 STARTTLS', () => {
    const form = applyPreset({ imap_host: '', smtp_tls: 'SSL' }, 'outlook');
    assert.equal(form.imap_host, 'outlook.office365.com');
    assert.equal(form.imap_port, 993);
    assert.equal(form.smtp_host, 'smtp.office365.com');
    assert.equal(form.smtp_port, 587);
    assert.equal(form.smtp_tls, 'STARTTLS');
    assert.equal(ACCOUNT_PRESETS.outlook.oauthProvider, 'microsoft');
  });

  test('Exchange (on-premises) clears the hosts and sets ports 993/587', () => {
    const form = applyPreset({ imap_host: 'imap.gmail.com', smtp_host: 'smtp.gmail.com', imap_port: 143 }, 'exchange');
    assert.equal(form.imap_host, '');
    assert.equal(form.smtp_host, '');
    assert.equal(form.imap_port, 993);
    assert.equal(form.smtp_port, 587);
    assert.equal(ACCOUNT_PRESETS.exchange.onPremExchange, true);
  });

  test('Custom leaves what the user typed', () => {
    const typed = { imap_host: 'mail.example.org', imap_port: 993 };
    assert.deepEqual(applyPreset(typed, 'custom'), typed);
  });

  test('keeps the existing presets', () => {
    assert.equal(applyPreset({}, 'gmail').imap_host, 'imap.gmail.com');
    assert.equal(applyPreset({}, 'yahoo').imap_host, 'imap.mail.yahoo.com');
    assert.equal(applyPreset({}, 'icloud').imap_host, 'imap.mail.me.com');
  });
});

describe('Microsoft sign-in vs password', () => {
  const configured = { microsoft: { configured: true } };
  const notConfigured = { microsoft: { configured: false } };

  test('Outlook preset shows the Microsoft sign-in button when the server has Microsoft OAuth', () => {
    assert.equal(microsoftAuthMode({ presetKey: 'outlook', integrations: configured }), 'oauth');
  });

  test('Outlook preset keeps the password field with the admin note when Microsoft OAuth is not configured', () => {
    assert.equal(microsoftAuthMode({ presetKey: 'outlook', integrations: notConfigured }), 'unconfigured');
    assert.equal(microsoftAuthMode({ presetKey: 'outlook', integrations: null }), 'unconfigured');
  });

  test('a Microsoft host typed into Custom gets the same treatment', () => {
    assert.equal(microsoftAuthMode({ presetKey: 'custom', imapHost: 'outlook.office365.com', integrations: configured }), 'oauth');
    assert.equal(microsoftAuthMode({ imapHost: 'imap-mail.outlook.com', integrations: notConfigured }), 'unconfigured');
  });

  test('Exchange (on-premises) and other providers stay on password auth', () => {
    assert.equal(microsoftAuthMode({ presetKey: 'exchange', imapHost: 'mail.contoso.com', integrations: configured }), null);
    assert.equal(microsoftAuthMode({ presetKey: 'gmail', imapHost: 'imap.gmail.com', integrations: configured }), null);
  });

  test('an account already connected with Microsoft OAuth is left alone when edited', () => {
    assert.equal(microsoftAuthMode({ imapHost: 'outlook.office365.com', account: { oauth_provider: 'microsoft' }, integrations: notConfigured }), null);
  });

  test('host detection covers Exchange Online and consumer hosts but not look-alikes', () => {
    for (const h of ['outlook.office365.com', 'outlook.office.com', 'imap-mail.outlook.com', 'imap.hotmail.com']) {
      assert.equal(isMicrosoftImapHost(h), true, h);
    }
    for (const h of ['mail.contoso.com', 'imap.gmail.com', 'outlookfans.example', '']) {
      assert.equal(isMicrosoftImapHost(h), false, h);
    }
  });
});
