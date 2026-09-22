// Send guard rules. Pure: given the outgoing message, the user's settings and (optionally) the
// message being replied to plus the user's identities, return findings. No I/O.

const ATTACH_WORDS = [
  'attached', 'attachment', 'attachments', 'attaching', 'enclosed', 'please find', 'pfa', 'see the file',
  'anbei', 'angehängt', 'im anhang', 'pièce jointe', 'pièces jointes', 'ci-joint', 'adjunto', 'en el adjunto', 'in allegato',
];
const NEGATED = /\b(no|without|not|nothing)\s+(an?\s+)?attach/i;

export const RULE_MODES = ['off', 'warn', 'block'];

export function csvList(s) {
  return String(s || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The text the sender wrote: quoted lines ("> …") and everything after a reply header dropped. */
export function ownText(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200} wrote:\s*$/.test(line) || /^-{2,}\s*(Original|Forwarded) Message/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

export function mentionsAttachment(text, extraWords = []) {
  const t = ownText(text);
  if (NEGATED.test(t)) return null;
  for (const w of [...ATTACH_WORDS, ...extraWords]) {
    const re = new RegExp(`(^|[^\\p{L}])${escapeRe(w)}($|[^\\p{L}])`, 'iu');
    if (re.test(t)) return w;
  }
  return null;
}

export function domainOf(addr) {
  const m = /<([^>]+)>/.exec(String(addr || ''));
  const email = (m ? m[1] : String(addr || '')).trim().toLowerCase();
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(at + 1) : null;
}

function emailOf(addr) {
  const m = /<([^>]+)>/.exec(String(addr || ''));
  return (m ? m[1] : String(addr || '')).trim().toLowerCase();
}

export function externalRecipients(recipients, internalDomains) {
  const internal = new Set(internalDomains.map((d) => d.toLowerCase()));
  return recipients.filter((r) => {
    const d = domainOf(r);
    return d && !internal.has(d) && ![...internal].some((i) => d.endsWith(`.${i}`));
  });
}

export function confidentialWord(text, keywords) {
  const t = ownText(text);
  for (const k of keywords) {
    if (new RegExp(`(^|[^\\p{L}])${escapeRe(k)}($|[^\\p{L}])`, 'iu').test(t)) return k;
  }
  return null;
}

/**
 * Which of the user's identities the replied-to message was addressed to, if it differs from the
 * one sending now. `identities` is a flat list of the user's own addresses.
 */
export function identityMismatch(fromEmail, original, identities) {
  if (!original || !fromEmail) return null;
  const mine = new Set(identities.map((i) => i.toLowerCase()));
  const from = fromEmail.toLowerCase();
  const addressed = [...(original.to || []), ...(original.cc || [])].map((a) => String(a?.email || a || '').toLowerCase());
  const receivedOn = addressed.find((a) => mine.has(a));
  if (!receivedOn || receivedOn === from) return null;
  return { receivedOn, sendingAs: from };
}

/**
 * Evaluate every rule.
 * @param {object} msg { from: { email }, to, cc, bcc, subject, body, hasAttachments }
 * @param {object} settings the plugin's settings
 * @param {{ original?: object, identities?: string[] }} context
 * @returns {{ rule, level, message }[]}
 */
export function evaluate(msg, settings, { original = null, identities = [] } = {}) {
  const findings = [];
  const add = (rule, mode, message) => { if (mode === 'warn' || mode === 'block') findings.push({ rule, level: mode, message }); };
  const text = `${msg.subject || ''}\n${msg.body || ''}`;

  if (settings.attachmentRule !== 'off' && !msg.hasAttachments) {
    const word = mentionsAttachment(text, csvList(settings.attachmentWords));
    if (word) add('attachment', settings.attachmentRule, `The message mentions "${word}" but nothing is attached.`);
  }

  if (settings.identityRule !== 'off') {
    const mismatch = identityMismatch(msg.from?.email, original, identities);
    if (mismatch) add('identity', settings.identityRule, `This thread was sent to ${mismatch.receivedOn}, but you are replying as ${mismatch.sendingAs}.`);
  }

  if (settings.confidentialRule !== 'off') {
    const word = confidentialWord(text, csvList(settings.confidentialKeywords));
    if (word) {
      const own = domainOf(msg.from?.email);
      const internal = [own, ...csvList(settings.internalDomains)].filter(Boolean);
      const external = externalRecipients([...(msg.to || []), ...(msg.cc || []), ...(msg.bcc || [])], internal);
      if (external.length) {
        const shown = external.slice(0, 3).map(emailOf).join(', ') + (external.length > 3 ? ` and ${external.length - 3} more` : '');
        add('confidential', settings.confidentialRule, `The message says "${word}" and goes outside ${own || 'your domain'} (${shown}).`);
      }
    }
  }
  return findings;
}

/** Collapse findings into the beforeSend result shape. */
export function verdict(findings) {
  if (!findings.length) return undefined;
  const blocks = findings.filter((f) => f.level === 'block');
  return {
    block: blocks.length > 0,
    warn: findings.map((f) => f.message).join(' '),
    reason: blocks.length ? blocks.map((f) => f.message).join(' ') : undefined,
    findings,
  };
}
