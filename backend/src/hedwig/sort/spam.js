// Spam, phishing and rescue signals. Pure: everything a verdict depends on is passed in.
// The server spam folder is a weak label; Hedwig never deletes, and moving is opt-in (spamMove.js).
import { spamEvidence } from '../triage/signals.js';
import { addressesOf, domainOf } from '../text.js';

const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc', 'me', 'nhs', 'police']);

/** Registrable domain: the last two labels, or three for co.uk-style suffixes. */
export function registrable(domain) {
  const parts = String(domain || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const [sld, tld] = parts.slice(-2);
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// Brands phishers impersonate most. Matched by registrable domain and by display name.
export const BRANDS = Object.freeze({
  paypal: ['paypal.com'], apple: ['apple.com', 'icloud.com'], microsoft: ['microsoft.com', 'outlook.com', 'live.com', 'office.com'],
  google: ['google.com', 'gmail.com', 'youtube.com'], amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.in'],
  netflix: ['netflix.com'], dhl: ['dhl.com', 'dhl.de'], fedex: ['fedex.com'], ups: ['ups.com'], 'royal mail': ['royalmail.com'],
  hmrc: ['hmrc.gov.uk', 'gov.uk'], linkedin: ['linkedin.com'], facebook: ['facebook.com', 'facebookmail.com'],
  instagram: ['instagram.com'], coinbase: ['coinbase.com'], binance: ['binance.com'], docusign: ['docusign.com', 'docusign.net'],
  dropbox: ['dropbox.com'], chase: ['chase.com'], hsbc: ['hsbc.com', 'hsbc.co.uk'], barclays: ['barclays.co.uk', 'barclays.com'],
  revolut: ['revolut.com'], wise: ['wise.com'],
});

const HOMOGLYPHS = [[/rn/g, 'm'], [/vv/g, 'w'], [/0/g, 'o'], [/1/g, 'l'], [/3/g, 'e'], [/5/g, 's'], [/\|/g, 'l']];

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function skeleton(label) {
  let s = label.toLowerCase();
  for (const [re, to] of HOMOGLYPHS) s = s.replace(re, to);
  return s.replace(/-/g, '');
}

/**
 * The known domain `domain` imitates, or null. A lookalike is close to (but not) a known domain:
 * one or two edits on a label of 5+ letters, a homoglyph swap (rn→m, 0→o), or the brand name
 * embedded in another registrable domain (paypal-secure.com).
 */
export function lookalikeOf(domain, known = []) {
  const reg = registrable(domain);
  if (!reg) return null;
  const label = reg.split('.')[0];
  const all = new Set([...known.map(registrable), ...Object.values(BRANDS).flat().map(registrable)]);
  if (all.has(reg)) return null;
  for (const k of all) {
    const kl = k.split('.')[0];
    if (kl.length < 4) continue;
    if (skeleton(label) === skeleton(kl) && label !== kl) return k;
    if (kl.length >= 5 && label.length >= 5 && levenshtein(label, kl) <= (kl.length >= 8 ? 2 : 1)) return k;
    if (kl.length >= 5 && label !== kl && label.includes(kl) && /[-.]|secure|login|verify|account|support|update/.test(label.replace(kl, ''))) return k;
  }
  return null;
}

const URL_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?[^\s"'<>)]*/gi;

/** Registrable domains linked from the text and HTML of a message (at most 20). */
export function linkDomains({ text = '', html = '' } = {}) {
  const out = new Set();
  for (const src of [String(html || ''), String(text || '')]) {
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(src)) && out.size < 20) out.add(registrable(m[1]));
  }
  return [...out];
}

const CREDENTIAL_RE = /\b(?:verify (?:your )?(?:account|identity|password|payment|wallet)|confirm (?:your )?(?:password|identity|account|payment details)|log ?in to (?:avoid|restore|keep)|update (?:your )?(?:payment|billing) (?:details|information)|unusual (?:sign-?in|activity)|account (?:will be |has been )?(?:suspended|locked|limited|closed))\b/i;
const LINK_SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at']);

/**
 * Phishing signals for one message.
 * @param {object} row
 * @param {{ auth?: object, knownDomains?: string[], text?: string, links?: string[], trustedSender?: boolean }} ctx
 */
export function phishingSignals(row, { auth = {}, knownDomains = [], text = '', links = null, trustedSender = false } = {}) {
  const signals = [];
  const add = (name, label, weight) => signals.push({ name, label, weight: round(weight) });
  const from = String(row?.from_email || '').toLowerCase();
  const fromDomain = domainOf(from);
  const fromReg = registrable(fromDomain);
  if (!fromReg) return signals;

  const look = lookalikeOf(fromDomain, knownDomains);
  if (look) add('lookalike', `Sender domain ${fromReg} looks like ${look}`, 0.55);

  const name = String(row?.from_name || '').toLowerCase();
  const knownRegs = knownDomains.map(registrable);
  for (const [brand, domains] of Object.entries(BRANDS)) {
    if (!new RegExp(`\\b${brand}\\b`).test(name)) continue;
    // A domain the user already corresponds with is not an impersonation, whatever its name says.
    if (!domains.map(registrable).includes(fromReg) && !knownRegs.includes(fromReg)) add('brandName', `Named "${row.from_name}" but sent from ${fromReg}`, 0.3);
    break;
  }

  const replyTo = addressesOf(row?.reply_to).map((a) => registrable(domainOf(a.email))).filter(Boolean);
  const otherReply = replyTo.find((d) => d !== fromReg);
  if (otherReply) add('replyTo', `Replies go to ${otherReply}, not ${fromReg}`, 0.25);

  const linked = links || linkDomains({ text, html: row?.body_html });
  const foreign = linked.filter((d) => d !== fromReg && !knownRegs.includes(d));
  const credential = CREDENTIAL_RE.test(`${row?.subject || ''}\n${text}`);
  if (credential) add('credential', 'Asks you to verify an account, password or payment', trustedSender ? 0.05 : 0.25);
  if (linked.some((d) => LINK_SHORTENERS.has(d))) add('shortener', 'Links through a URL shortener', 0.15);
  if (credential && foreign.length && !linked.includes(fromReg)) add('linkDomain', `Links go to ${foreign.slice(0, 2).join(', ')}, not ${fromReg}`, 0.3);

  if (auth.dmarc === 'fail') add('authDmarc', `DMARC failed${auth.trusted ? '' : ' (unverified header)'}`, auth.trusted ? 0.35 : 0.1);
  if (auth.spf === 'fail') add('authSpf', `SPF failed${auth.trusted ? '' : ' (unverified header)'}`, auth.trusted ? 0.15 : 0.05);
  if (auth.dkim === 'fail') add('authDkim', `DKIM failed${auth.trusted ? '' : ' (unverified header)'}`, auth.trusted ? 0.15 : 0.05);
  return signals;
}

/**
 * Spam verdict from triage's evidence, phishing signals and the folder.
 * @returns {{ verdict: 'clean'|'suspected'|'phishing', confidence: number, reason: string|null, signals: Array, phishingScore: number }}
 */
export function assessSpam(row, { text = '', sender = null, auth = {}, knownDomains = [], spamFolder = false, trustedSender = false, links = null } = {}) {
  const phishing = phishingSignals(row, { auth, knownDomains, text, links, trustedSender });
  const phishingScore = round(Math.min(0.99, phishing.reduce((s, x) => s + x.weight, 0)));
  const evidence = spamEvidence(row, { text, sender });
  const signals = [...phishing];
  if (row?.spam_user_override === 'ham') return { verdict: 'clean', confidence: 0.99, reason: 'You marked this not spam', signals, phishingScore };
  if (row?.spam_user_override === 'spam') return { verdict: 'suspected', confidence: 0.99, reason: 'You marked this as spam', signals, phishingScore };
  if (phishingScore >= 0.5 && !trustedSender) {
    return { verdict: 'phishing', confidence: round(Math.min(0.97, 0.45 + phishingScore / 2)), reason: phishing.sort((a, b) => b.weight - a.weight)[0].label, signals, phishingScore };
  }
  if (evidence.spam && evidence.source !== 'override') {
    signals.push(...evidence.reasons.map((r) => ({ name: `spam:${evidence.source}`, label: r.label, weight: round(Number(r.weight) || 0.5) })));
    const conf = round(Math.min(0.97, Math.max(0.6, Number(evidence.reasons[0]?.weight) || 0.7)));
    return { verdict: trustedSender ? 'clean' : 'suspected', confidence: trustedSender ? 0.6 : conf, reason: evidence.reasons[0]?.label || 'Spam filter verdict', signals, phishingScore };
  }
  if (spamFolder) {
    signals.push({ name: 'spamFolder', label: 'Your provider filed this as spam', weight: 0.4 });
    return { verdict: 'suspected', confidence: 0.55, reason: 'Your provider filed this as spam', signals, phishingScore };
  }
  if (phishingScore >= 0.45 && !trustedSender) {
    return { verdict: 'suspected', confidence: round(0.4 + phishingScore / 2), reason: phishing[0].label, signals, phishingScore };
  }
  return { verdict: 'clean', confidence: round(1 - phishingScore / 2), reason: null, signals, phishingScore };
}

const ORDER_RE = /\b(?:order|booking|reservation|confirmation|receipt|invoice|ticket|itinerary)\s*(?:number|no\.?|#|ref(?:erence)?)?\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{4,}\b/i;

/**
 * How legitimate a message in the spam folder looks. Signals: you replied to the sender or decided
 * them into a stream, they are a contact, DMARC passed, personal tone (a person writing to you, a
 * question or request), an order you placed (an order number from a domain you already receive
 * receipts from). Phishing signals subtract.
 * @returns {{ score: number, reasons: string[] }}
 */
export function rescueScore({ row, sender = null, decision = null, alwaysIn = false, auth = {}, s1 = null, orderDomains = [], phishingScore = 0, text = '' }) {
  let score = 0;
  const reasons = [];
  const add = (w, label) => { score += w; reasons.push(label); };
  if (decision && decision !== 'block') add(0.45, `You put this sender in ${decision[0].toUpperCase()}${decision.slice(1)}`);
  if (Number(sender?.replied) > 0) add(0.45, `You have replied to ${row.from_name || row.from_email}`);
  else if (alwaysIn) add(0.35, 'You have written to them or they are in your contacts');
  if (auth.trusted && auth.dmarc === 'pass') add(0.15, 'Passed DMARC');
  const personal = s1 && s1.senderKind === 'person' && !s1.flags?.bulk && (s1.flags?.to || s1.flags?.ccOnly);
  if (personal) add(0.15, 'A person writing to you');
  if (personal && (s1.flags?.question || s1.flags?.request)) add(0.1, 'Asks you something');
  const reg = registrable(domainOf(row?.from_email));
  if (reg && orderDomains.map(registrable).includes(reg) && ORDER_RE.test(`${row.subject || ''}\n${text}`)) add(0.35, `Looks like an order you placed with ${reg}`);
  if (decision === 'block') { score -= 1; reasons.push('You blocked this sender'); }
  score -= phishingScore;
  return { score: round(Math.max(0, Math.min(0.99, score))), reasons };
}
