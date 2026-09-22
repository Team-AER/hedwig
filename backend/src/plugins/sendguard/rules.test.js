import { describe, it, expect } from 'vitest';
import { mentionsAttachment, externalRecipients, identityMismatch, evaluate, verdict, ownText } from './rules.js';
import activate from './index.js';

const defaults = {
  attachmentRule: 'warn', attachmentWords: '', identityRule: 'warn', confidentialRule: 'warn',
  confidentialKeywords: 'confidential, internal only', internalDomains: 'partner.example',
};

describe('attachment rule', () => {
  it('finds attachment words in the sender\'s own text only', () => {
    expect(mentionsAttachment('Please see the attached report.')).toBe('attached');
    expect(mentionsAttachment('Anbei die Rechnung.')).toBe('anbei');
    expect(mentionsAttachment('Thanks!\n\nOn Tue, 3 Sep 2026 at 10:00, Sam <s@x> wrote:\n> see attached')).toBeNull();
    expect(mentionsAttachment('No attachment needed, the link is below.')).toBeNull();
    expect(mentionsAttachment('We reattached the shelf.')).toBeNull();
    expect(mentionsAttachment('see the deck', ['deck'])).toBe('deck');
  });
  it('strips quoted lines', () => {
    expect(ownText('hi\n> quoted\nbye')).toBe('hi\nbye');
  });
});

describe('recipients and identities', () => {
  it('treats the sender domain, configured domains and their subdomains as internal', () => {
    expect(externalRecipients(['a@acme.com', 'Bob <b@eu.partner.example>', 'c@gmail.com'], ['acme.com', 'partner.example'])).toEqual(['c@gmail.com']);
  });
  it('spots a reply from a different identity than the thread was sent to', () => {
    const original = { to: [{ email: 'work@acme.com' }], cc: [] };
    expect(identityMismatch('me@home.example', original, ['work@acme.com', 'me@home.example'])).toEqual({ receivedOn: 'work@acme.com', sendingAs: 'me@home.example' });
    expect(identityMismatch('work@acme.com', original, ['work@acme.com'])).toBeNull();
    expect(identityMismatch('me@home.example', { to: [{ email: 'list@lists.example' }] }, ['me@home.example'])).toBeNull();
  });
});

describe('evaluate', () => {
  const msg = { from: { email: 'me@acme.com' }, to: ['client@gmail.com'], subject: 'Q3', body: 'Confidential: attached are the numbers.', hasAttachments: false };
  it('warns by default and blocks only when configured', () => {
    const f = evaluate(msg, defaults);
    expect(f.map((x) => [x.rule, x.level])).toEqual([['attachment', 'warn'], ['confidential', 'warn']]);
    expect(verdict(f)).toMatchObject({ block: false });
    const b = verdict(evaluate(msg, { ...defaults, attachmentRule: 'block' }));
    expect(b.block).toBe(true);
    expect(b.reason).toMatch(/nothing is attached/);
  });
  it('is quiet for internal recipients, attached files and rules that are off', () => {
    expect(evaluate({ ...msg, to: ['boss@acme.com', 'x@partner.example'], hasAttachments: true }, defaults)).toEqual([]);
    expect(evaluate(msg, { ...defaults, attachmentRule: 'off', confidentialRule: 'off' })).toEqual([]);
    expect(verdict([])).toBeUndefined();
  });
});

describe('beforeSend hook', () => {
  it('looks up the replied-to message and the user\'s identities through the facade', async () => {
    const hedwig = {
      settings: { get: async () => defaults },
      mail: {
        findByMessageId: async (_u, id) => (id === '<m1@x>' ? { to: [{ email: 'work@acme.com' }], cc: [] } : null),
        listAccounts: async () => [{ id: 'a', email: 'work@acme.com', aliases: [{ email: 'me@home.example' }] }],
      },
      router: () => ({ post() {} }),
    };
    const { hooks } = activate(hedwig);
    const res = await hooks.beforeSend({ userId: 'u', from: { email: 'me@home.example' }, to: ['sam@acme.com'], subject: 'Re: plan', body: 'Sounds good.', hasAttachments: false, inReplyTo: '<m1@x>' });
    expect(res).toMatchObject({ block: false, warn: expect.stringMatching(/sent to work@acme.com, but you are replying as me@home.example/) });
  });
});
