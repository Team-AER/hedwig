// aer.sendguard — checks outgoing mail before it is handed to SMTP: a missing attachment, replying
// from a different identity than the thread was addressed to, and "confidential" mail leaving the
// organisation. Each rule warns by default and blocks only when the user sets it to block.
// Tier-1 v2 plugin: facade only.
import { evaluate, verdict } from './rules.js';

export const manifest = {
  id: 'aer.sendguard',
  name: 'Send guard',
  version: '1.0.0',
  api: '^1.0.0',
  tier: 1,
  description: 'Catches a forgotten attachment, a reply from the wrong address, or confidential mail going outside before it is sent.',
  author: 'Team AER',
  permissions: [
    { name: 'mail.read', reason: 'Check outgoing messages and look up the message you are replying to' },
    { name: 'views', reason: 'Show the send guard settings' },
  ],
  hooks: ['beforeSend'],
  settings: {
    type: 'object',
    properties: {
      attachmentRule: { type: 'string', enum: ['off', 'warn', 'block'], default: 'warn', title: 'Mentions an attachment but has none' },
      attachmentWords: { type: 'string', default: '', maxLength: 500, title: 'Extra attachment words', description: 'Comma-separated, in addition to the built-in list.' },
      identityRule: { type: 'string', enum: ['off', 'warn', 'block'], default: 'warn', title: 'Replying from a different address than the thread was sent to' },
      confidentialRule: { type: 'string', enum: ['off', 'warn', 'block'], default: 'warn', title: 'Confidential mail to an outside domain' },
      confidentialKeywords: { type: 'string', default: 'confidential, internal only, do not forward, not for distribution', maxLength: 500, title: 'Confidential keywords' },
      internalDomains: { type: 'string', default: '', maxLength: 1000, title: 'Internal domains', description: 'Comma-separated. The sending address\'s own domain always counts as internal.' },
    },
  },
  views: ['aer.sendguard.settings'],
};

export default function activate(hedwig) {
  async function check(userId, msg) {
    const settings = await hedwig.settings.get(userId);
    let original = null;
    let identities = [];
    if (settings.identityRule !== 'off' && msg.inReplyTo) {
      original = await hedwig.mail.findByMessageId(userId, msg.inReplyTo);
      if (original) {
        const accounts = await hedwig.mail.listAccounts(userId);
        identities = accounts.flatMap((a) => [a.email, ...a.aliases.map((x) => x.email)]).filter(Boolean);
      }
    }
    return evaluate(msg, settings, { original, identities });
  }

  const router = hedwig.router();

  // Pre-flight for the composer: same checks as the send hook, without sending.
  // Body: { accountId?, from?: { email }, to, cc, bcc, subject, body, hasAttachments, inReplyTo }
  router.post('/check', async (req) => {
    const b = req.body || {};
    let from = b.from?.email ? { email: String(b.from.email) } : null;
    if (!from && typeof b.accountId === 'string') {
      const acct = (await hedwig.mail.listAccounts(req.userId)).find((a) => a.id === b.accountId);
      if (acct) from = { email: acct.email };
    }
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : []);
    const findings = await check(req.userId, {
      from, to: list(b.to), cc: list(b.cc), bcc: list(b.bcc),
      subject: String(b.subject || ''), body: String(b.body || '').slice(0, 200_000),
      hasAttachments: b.hasAttachments === true, inReplyTo: typeof b.inReplyTo === 'string' ? b.inReplyTo : null,
    });
    return verdict(findings) || { block: false, findings: [] };
  });

  return {
    hooks: {
      beforeSend: async (ctx) => verdict(await check(ctx.userId, ctx)),
    },
    router,
  };
}
