// POST /work/sendguard — checks before sending, with no model call: an attachment mentioned but
// missing, a recipient outside the domains of the personal thread being answered, reply-all to a
// crowd, an empty subject; plus whatever beforeSend plugins (aer.sendguard) find, as 'custom'.
import { getConfig } from '../config.js';
import { collectHedwigHook, HEDWIG_HOOKS } from '../hooks.js';
import { senderKind } from '../triage/signals.js';
import { addressesOf, domainOf } from '../text.js';
import { loadThreadMessages, ownerOf, clampInt } from './util.js';

const ATTACH_RE = /(^|[^\p{L}])(attached|attachments?|attaching|enclosed|anbei|im anhang|pièce jointe|ci-joint|adjunto|in allegato)($|[^\p{L}])/iu;
const NEGATED_RE = /\b(no|without|not|nothing)\s+(an?\s+)?attach/i;

/** One recipient from "Name <a@b>", "a@b" or { email | address, name }. */
export function parseRecipient(r) {
  if (!r) return null;
  if (typeof r === 'object') {
    const email = String(r.email || r.address || '').trim().toLowerCase();
    return email.includes('@') ? { email, name: r.name || null } : null;
  }
  const s = String(r).trim();
  const m = /<([^>]+)>/.exec(s);
  const email = (m ? m[1] : s).trim().toLowerCase();
  return email.includes('@') ? { email, name: m ? s.slice(0, m.index).replace(/["']/g, '').trim() || null : null } : null;
}

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : []).map(parseRecipient).filter(Boolean);

/** The text the sender wrote now: quoted lines and everything after a reply header dropped. */
function ownText(body) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    if (/^On .{5,200} wrote:\s*$/.test(line) || /^-{2,}\s*(Original|Forwarded) Message/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Deterministic checks. Pure.
 * @param {{ to, cc, bcc?, subject, body, attachments?, replyAll? }} msg
 * @param {{ replyAllWarnAbove?: number, thread?: { personal: boolean, domains: string[], addresses: string[] } | null,
 *           ownDomains?: string[] }} ctx
 * @returns {{ kind, text }[]}
 */
export function checkMessage(msg, { replyAllWarnAbove = 8, thread = null, ownDomains = [] } = {}) {
  const warnings = [];
  const to = list(msg.to);
  const cc = list(msg.cc);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments.filter(Boolean) : [];
  const text = ownText(msg.body);

  if (!attachments.length && !NEGATED_RE.test(text)) {
    const m = ATTACH_RE.exec(`${msg.subject || ''}\n${text}`);
    if (m) warnings.push({ kind: 'missing_attachment', text: `You mention “${m[2].toLowerCase()}” but nothing is attached.` });
  }

  if (thread?.personal && thread.domains.length) {
    const known = new Set([...thread.domains, ...ownDomains].map((d) => d.toLowerCase()));
    const knownAddr = new Set(thread.addresses.map((a) => a.toLowerCase()));
    const strangers = [...to, ...cc].filter((r) => !knownAddr.has(r.email) && !known.has(domainOf(r.email)));
    if (strangers.length) {
      const shown = strangers.slice(0, 3).map((r) => r.email).join(', ');
      const more = strangers.length > 3 ? ` and ${strangers.length - 3} more` : '';
      warnings.push({ kind: 'wrong_recipient', text: `${shown}${more} ${strangers.length === 1 ? 'is' : 'are'} not on this conversation, which is with ${thread.domains.slice(0, 2).map((d) => `@${d}`).join(' and ')}.` });
    }
  }

  const count = new Set([...to, ...cc].map((r) => r.email)).size;
  if ((msg.replyAll || thread) && count > replyAllWarnAbove) {
    warnings.push({ kind: 'reply_all_large', text: `This goes to ${count} people. Reply to fewer?` });
  }

  if (!String(msg.subject || '').trim()) warnings.push({ kind: 'empty_subject', text: 'The subject is empty.' });
  return warnings;
}

/** What the thread being answered says about who belongs on it. Pure. */
export function threadContext(messages, ownerAddresses = []) {
  if (!messages?.length) return null;
  const mine = new Set(ownerAddresses.map((a) => a.toLowerCase()));
  const ownDomains = new Set([...mine].map(domainOf).filter(Boolean));
  const people = new Set();
  let personal = true;
  for (const m of messages) {
    if (!m.mine && (m.is_bulk || m.list_unsubscribe || senderKind(m.from_email) !== 'person')) personal = false;
    for (const a of [{ email: String(m.from_email || '').toLowerCase() }, ...addressesOf(m.to_addresses), ...addressesOf(m.cc_addresses)]) {
      if (a.email && !mine.has(a.email)) people.add(a.email);
    }
  }
  const domains = [...new Set([...people].map(domainOf).filter((d) => d && !ownDomains.has(d)))];
  return { personal, domains, addresses: [...people] };
}

export async function sendGuard(userId, body = {}) {
  const cfg = await getConfig(userId);
  const owner = await ownerOf(userId);
  const threadKey = typeof body.threadId === 'string' && body.threadId.trim() ? body.threadId.trim() : null;
  const messages = threadKey ? await loadThreadMessages(userId, threadKey, { addresses: owner.addresses }) : [];
  const thread = threadContext(messages, owner.addresses);
  const warnings = checkMessage(body, {
    replyAllWarnAbove: clampInt(cfg['work.replyAllWarnAbove'], 8, 1, 500),
    thread,
    ownDomains: owner.addresses.map(domainOf).filter(Boolean),
  });

  // beforeSend plugins (aer.sendguard's rules and any other): same context the send route gives them.
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter(Boolean) : [];
  const recipients = (v) => list(v).map((r) => r.email);
  let verdicts = [];
  try {
    verdicts = await collectHedwigHook(HEDWIG_HOOKS.beforeSend, {
      userId, accountId: body.accountId || null, preflight: true,
      from: body.from?.email ? { email: String(body.from.email) } : (owner.addresses[0] ? { email: owner.addresses[0] } : null),
      to: recipients(body.to), cc: recipients(body.cc), bcc: recipients(body.bcc),
      subject: String(body.subject || ''), body: String(body.body || '').slice(0, 200_000), bodyIsHtml: false,
      hasAttachments: attachments.length > 0,
      attachments: attachments.map((a) => ({ filename: a?.filename || (typeof a === 'string' ? a : null), contentType: a?.contentType || null })),
      inReplyTo: body.inReplyTo || null, references: null,
    });
  } catch (err) {
    console.warn('[hedwig] work: beforeSend preflight hooks failed:', err.message);
  }
  const mine = new Set(warnings.map((w) => w.kind));
  for (const v of verdicts || []) {
    const findings = Array.isArray(v?.findings) && v.findings.length ? v.findings : v?.warn ? [{ message: v.warn, level: v.block ? 'block' : 'warn' }] : [];
    for (const f of findings) {
      if (f.rule === 'attachment' && mine.has('missing_attachment')) continue;
      warnings.push({ kind: 'custom', text: String(f.message || ''), ...(v.pluginId ? { pluginId: v.pluginId } : {}), ...(f.level === 'block' ? { block: true } : {}) });
    }
  }
  return { warnings };
}
