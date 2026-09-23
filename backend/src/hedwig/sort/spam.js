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

// Bump when a change to the signals below should re-judge stored verdicts (sort.reevaluateSpam).
export const SPAM_SIGNALS_VERSION = '2026-09-24.1';

// CDN, asset and email-service link hosts: a link there says nothing about where a lure leads.
// Overridden per install by config spam.trustedLinkHosts.
export const DEFAULT_TRUSTED_LINK_HOSTS = Object.freeze([
  // CDNs and asset hosts
  // (not amazonaws.com, googleapis.com storage or pages.dev: phishing pages are hosted there)
  'media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com', 'cloudfront.net', 'akamaized.net',
  'akamaihd.net', 'akamai.net', 'edgekey.net', 'fastly.net', 'jsdelivr.net', 'imgix.net', 'wikimedia.org', 'wikipedia.org',
  'googleusercontent.com', 'gstatic.com', 'ggpht.com', 'ytimg.com', 'twimg.com', 'fbcdn.net', 'licdn.com',
  'gravatar.com', 'w3.org', 'schema.org',
  // email service providers, link wrappers and tracking
  'sendgrid.net', 'list-manage.com', 'mailchimp.com', 'mcusercontent.com', 'mailchi.mp', 'hubspot.com', 'hubspotemail.net',
  'hubspotlinks.com', 'hs-sites.com', 'hsforms.com', 'hs-analytics.net', 'mailgun.org', 'mandrillapp.com', 'sparkpostmail.com',
  'exacttarget.com', 'sfmc-content.com', 'rs6.net', 'ctctcdn.com', 'klaviyo.com', 'klclick.com', 'klclick1.com', 'createsend.com',
  'createsend1.com', 'cmail19.com', 'cmail20.com', 'mailjet.com', 'mjt.lu', 'sendinblue.com', 'brevo.com', 'amazonses.com',
  'awstrack.me', 'substack.com', 'substackcdn.com', 'customeriomail.com', 'braze.com', 'postmarkapp.com', 'mailerlite.com',
]);

const HOMOGLYPHS = [[/rn/g, 'm'], [/vv/g, 'w'], [/0/g, 'o'], [/1/g, 'l'], [/3/g, 'e'], [/5/g, 's'], [/\|/g, 'l']];

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions. */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m || !n) return m || n;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

function skeleton(label) {
  let s = label.toLowerCase();
  for (const [re, to] of HOMOGLYPHS) s = s.replace(re, to);
  return s.replace(/-/g, '');
}

const labelOf = (reg) => String(reg || '').split('.')[0];

/**
 * One registrable domain belongs to another's family: the same name on another suffix
 * (bookmyshow.com / bookmyshow.email, amazon.com / amazon.in) or the name as a hyphenated part
 * (media-amazon.com, amazon-adsystem.com for amazon.com).
 */
export function sameFamily(a, b) {
  const ra = registrable(a); const rb = registrable(b);
  if (!ra || !rb) return false;
  if (ra === rb) return true;
  const la = labelOf(ra); const lb = labelOf(rb);
  if (la === lb) return true;
  if (la.length >= 4 && lb.split('-').includes(la)) return true;
  if (lb.length >= 4 && la.split('-').includes(lb)) return true;
  return false;
}

/**
 * Is `label` a near miss for `target`? Short names need a stricter match: 5–7 letters only a
 * one-letter swap or transposition of the same length (vantaqe for vantage, not plane for planet),
 * 8–9 letters one edit, 10+ letters up to two.
 */
function nearMiss(label, target) {
  if (label === target || label.length < 5 || target.length < 5) return false;
  if (target.length <= 7) return label.length === target.length && editDistance(label, target) === 1;
  if (target.length <= 9) return editDistance(label, target) === 1;
  return editDistance(label, target) <= 2;
}

// Mail providers' own domains are never lookalikes of each other (ymail.com is not gmail.com).
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'zoho.com', 'yandex.com', 'yandex.ru', 'mail.com', 'mail.ru', 'fastmail.com', 'hey.com', 'rediffmail.com', 'tutanota.com',
]);

const BRAND_BAIT = /secure|login|log-in|signin|sign-in|verify|verification|account|support|update|billing|wallet|unlock|recover/;

/**
 * The domain `domain` imitates, or null.
 *   - `known`: domains the user corresponds with. Only these are targets for near-miss spellings
 *     (one or two edits, see nearMiss), and a known domain is never a lookalike itself.
 *   - Well-known brands (BRANDS) are targets only for homoglyph swaps (paypa1, rnicrosoft) and for
 *     the brand embedded with bait words (paypal-secure-login.com).
 * The same name on another suffix is the same brand, not a lookalike (bookmyshow.com vs .email).
 * `knownTargets: false` keeps known domains exempt but stops them being targets (authenticated mail).
 */
export function lookalikeOf(domain, known = [], { knownTargets = true } = {}) {
  const reg = registrable(domain);
  if (!reg) return null;
  const label = labelOf(reg);
  const knownRegs = new Set(known.map(registrable).filter(Boolean));
  const brandRegs = new Set(Object.values(BRANDS).flat().map(registrable));
  if (knownRegs.has(reg) || brandRegs.has(reg) || FREEMAIL.has(reg)) return null;
  if ([...knownRegs, ...brandRegs].some((k) => labelOf(k) === label)) return null;
  const targets = knownTargets ? [...knownRegs, ...brandRegs] : [...brandRegs];
  for (const k of targets) {
    const kl = labelOf(k);
    if (kl.length < 4) continue;
    if (skeleton(label) === skeleton(kl)) return k;
    if (kl.length >= 5 && label.includes(kl) && BRAND_BAIT.test(label.replace(kl, ''))) return k;
  }
  if (knownTargets) {
    for (const k of knownRegs) if (nearMiss(label, labelOf(k))) return k;
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

/** Is `domain` (a registrable domain or host) one of the trusted link hosts or under one? */
export function trustedLinkHost(domain, hosts = DEFAULT_TRUSTED_LINK_HOSTS) {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!d) return false;
  const reg = registrable(d);
  return (Array.isArray(hosts) ? hosts : []).some((h) => {
    const x = String(h || '').toLowerCase().trim();
    return x && (d === x || reg === x || d.endsWith(`.${x}`));
  });
}

const CREDENTIAL_RE = /\b(?:verify (?:your )?(?:account|identity|password|payment|wallet)|confirm (?:your )?(?:password|identity|account|payment details)|log ?in to (?:avoid|restore|keep)|update (?:your )?(?:payment|billing) (?:details|information)|unusual (?:sign-?in|activity)|account (?:will be |has been )?(?:suspended|locked|limited|closed))\b/i;
const LINK_SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at']);

// Independent kinds of evidence. Phishing needs two of them, or a failed authentication and one.
const SIGNAL_GROUP = {
  lookalike: 'identity', brandName: 'identity', replyTo: 'replyTo', credential: 'lure', linkDomain: 'links', shortener: 'links',
};

/** Authentication passed on a trusted result (DMARC, or SPF and DKIM together). */
export function authPassed(auth = {}) {
  return Boolean(auth.trusted && (auth.dmarc === 'pass' || (auth.spf === 'pass' && auth.dkim === 'pass')));
}

/** Authentication failed on a trusted result (DMARC, or SPF and DKIM together). */
export function authFailed(auth = {}) {
  return Boolean(auth.trusted && (auth.dmarc === 'fail' || (auth.spf === 'fail' && auth.dkim === 'fail')));
}

/**
 * Phishing signals for one message.
 * @param {object} row
 * @param {{ auth?: object, knownDomains?: string[], text?: string, links?: string[], trustedSender?: boolean,
 *   trustedLinkHosts?: string[] }} ctx
 */
export function phishingSignals(row, { auth = {}, knownDomains = [], text = '', links = null, trustedSender = false, trustedLinkHosts = DEFAULT_TRUSTED_LINK_HOSTS } = {}) {
  const signals = [];
  const add = (name, label, weight) => signals.push({ name, label, weight: round(weight) });
  const from = String(row?.from_email || '').toLowerCase();
  const fromDomain = domainOf(from);
  const fromReg = registrable(fromDomain);
  if (!fromReg) return signals;
  const passed = authPassed(auth);
  const knownRegs = knownDomains.map(registrable);

  // A near miss of someone the user writes to only counts when the sender could not prove who it
  // is; a homoglyph or baited brand name counts either way (a phisher's own domain passes DMARC).
  const look = lookalikeOf(fromDomain, knownDomains, { knownTargets: !passed });
  if (look) add('lookalike', `Sender domain ${fromReg} looks like ${look}`, 0.55);

  const name = String(row?.from_name || '').toLowerCase();
  for (const [brand, domains] of Object.entries(BRANDS)) {
    if (!new RegExp(`\\b${brand}\\b`).test(name)) continue;
    // A domain the user already corresponds with is not an impersonation, whatever its name says.
    if (!domains.map(registrable).includes(fromReg) && !knownRegs.includes(fromReg)) add('brandName', `Named "${row.from_name}" but sent from ${fromReg}`, 0.3);
    break;
  }

  const replyTo = addressesOf(row?.reply_to).map((a) => registrable(domainOf(a.email))).filter(Boolean);
  const otherReply = replyTo.find((d) => !sameFamily(d, fromReg) && !knownRegs.includes(d) && !trustedLinkHost(d, trustedLinkHosts));
  if (otherReply) add('replyTo', `Replies go to ${otherReply}, not ${fromReg}`, 0.25);

  const linked = links || linkDomains({ text, html: row?.body_html });
  const foreign = linked.filter((d) => !sameFamily(d, fromReg) && !knownRegs.includes(d) && !trustedLinkHost(d, trustedLinkHosts));
  const credential = CREDENTIAL_RE.test(`${row?.subject || ''}\n${text}`);
  if (credential) add('credential', 'Asks you to verify an account, password or payment', trustedSender ? 0.05 : 0.25);
  if (linked.some((d) => LINK_SHORTENERS.has(d))) add('shortener', 'Links through a URL shortener', 0.15);
  if (credential && foreign.length && !linked.some((d) => sameFamily(d, fromReg))) {
    add('linkDomain', `Links go to ${foreign.slice(0, 2).join(', ')}, not ${fromReg}${passed ? ' (sender passed DMARC)' : ''}`, passed ? 0.1 : 0.3);
  }

  if (auth.dmarc === 'fail') add('authDmarc', `DMARC failed${auth.trusted ? '' : ' (unverified header)'}`, auth.trusted ? 0.35 : 0.1);
  if (auth.spf === 'fail') add('authSpf', `SPF failed${auth.trusted ? '' : ' (unverified header)'}`, auth.trusted ? 0.15 : 0.05);
  if (auth.dkim === 'fail') add('authDkim', `DKIM failed${auth.trusted ? '' : ' (unverified header)'}`, auth.trusted ? 0.15 : 0.05);
  return signals;
}

/**
 * Is this enough for a phishing verdict? Two independent kinds of evidence (identity, reply-to,
 * lure, links), or a failed trusted authentication plus one, and a combined weight of 0.5.
 * @returns {{ phishing: boolean, groups: string[], authFail: boolean, score: number }}
 */
export function phishingDecision(signals, auth = {}) {
  const groups = [...new Set(signals.map((s) => SIGNAL_GROUP[s.name]).filter(Boolean))];
  const fail = authFailed(auth);
  const score = round(Math.min(0.99, signals.reduce((s, x) => s + x.weight, 0)));
  const phishing = score >= 0.5 && (groups.length >= 2 || (fail && groups.length >= 1));
  return { phishing, groups, authFail: fail, score };
}

/** The two strongest signals as one plain reason. */
function phishingReason(signals) {
  return [...signals].sort((a, b) => b.weight - a.weight).slice(0, 2).map((s) => s.label).join('; ');
}

/**
 * Spam verdict from triage's evidence, phishing signals and the folder.
 * @returns {{ verdict: 'clean'|'suspected'|'phishing', confidence: number, reason: string|null, signals: Array, phishingScore: number }}
 */
export function assessSpam(row, { text = '', sender = null, auth = {}, knownDomains = [], spamFolder = false, trustedSender = false, links = null, trustedLinkHosts = DEFAULT_TRUSTED_LINK_HOSTS } = {}) {
  const phishing = phishingSignals(row, { auth, knownDomains, text, links, trustedSender, trustedLinkHosts });
  const decision = phishingDecision(phishing, auth);
  const phishingScore = decision.score;
  const evidence = spamEvidence(row, { text, sender });
  const signals = [...phishing];
  if (row?.spam_user_override === 'ham') return { verdict: 'clean', confidence: 0.99, reason: 'You marked this not spam', signals, phishingScore };
  if (row?.spam_user_override === 'spam') return { verdict: 'suspected', confidence: 0.99, reason: 'You marked this as spam', signals, phishingScore };
  if (decision.phishing && !trustedSender) {
    return { verdict: 'phishing', confidence: round(Math.min(0.97, 0.45 + phishingScore / 2)), reason: phishingReason(phishing), signals, phishingScore };
  }
  if (evidence.spam && evidence.source !== 'override') {
    signals.push(...evidence.reasons.map((r) => ({ name: `spam:${evidence.source}`, label: r.label, weight: round(Number(r.weight) || 0.5) })));
    const conf = round(Math.min(0.97, Math.max(0.6, Number(evidence.reasons[0]?.weight) || 0.7)));
    return { verdict: trustedSender ? 'clean' : 'suspected', confidence: trustedSender ? 0.6 : conf, reason: evidence.reasons[0]?.label || 'Spam filter verdict', signals, phishingScore };
  }
  if (spamFolder) {
    signals.push({ name: 'spamFolder', label: 'Your provider filed this as spam', weight: 0.4 });
    const one = phishingScore >= 0.45 && !trustedSender ? phishingReason(phishing) : null;
    return { verdict: 'suspected', confidence: 0.55, reason: one ? `Your provider filed this as spam; ${one}` : 'Your provider filed this as spam', signals, phishingScore };
  }
  // One sign of phishing on its own is worth a look, not a verdict.
  if (phishingScore >= 0.45 && !trustedSender) {
    return { verdict: 'suspected', confidence: round(0.4 + phishingScore / 2), reason: `${phishingReason(phishing)} (one sign of phishing)`, signals, phishingScore };
  }
  return { verdict: 'clean', confidence: round(1 - phishingScore / 2), reason: null, signals, phishingScore };
}

const ORDER_RE = /\b(?:order|booking|reservation|confirmation|receipt|invoice|ticket|itinerary)\s*(?:number|no\.?|#|ref(?:erence)?)?\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{4,}\b/i;
const RECEIPT_RE = /\b(?:your (?:order|booking|tickets?|e-?tickets?|receipt|invoice|reservation|purchase)|order (?:confirmed|confirmation|shipped|dispatched|delivered)|booking (?:confirmed|confirmation)|payment (?:receipt|received|confirmation)|tax invoice|thanks for (?:your order|shopping|booking))\b/i;

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * How legitimate a message in the spam folder looks. Any one strong sign that the user knows the
 * sender reaches spam.rescueAbove (0.7) on its own: you replied to them, wrote to them, started or
 * wrote in the thread, put them in a stream yourself, marked their mail not spam before, they are in
 * your contacts, or it is an order or receipt from a shop you already buy from. Weak signs (DMARC,
 * a person writing to you, a question) add up to a borderline score for Reflex to confirm.
 * Phishing signals subtract; a blocked sender scores zero.
 * @param {object} p
 * @param {string|null} [p.decision]        the sender decision (people/reading/records/block)
 * @param {string|null} [p.decisionSource]  user | import | auto | rule (default user)
 * @param {boolean} [p.wroteTo]             the user has sent mail to this address
 * @param {boolean} [p.contact]             in the user's contacts
 * @param {boolean} [p.replyToOwn]          a reply in a thread the user wrote in
 * @param {boolean} [p.markedNotSpam]       the user marked this sender's mail not spam before
 * @param {boolean} [p.alwaysIn]            legacy: an imported decision (wrote to them or a contact)
 * @returns {{ score: number, reasons: string[], strong: number }}
 */
export function rescueScore({
  row, sender = null, decision = null, decisionSource = 'user', alwaysIn = false, wroteTo = false, contact = false,
  replyToOwn = false, markedNotSpam = false, auth = {}, s1 = null, orderDomains = [], phishingScore = 0, text = '',
}) {
  let score = 0;
  let strong = 0;
  const reasons = [];
  const add = (w, label, isStrong = false) => { score += isStrong && strong ? Math.min(w, 0.1) : w; if (isStrong) strong++; reasons.push(label); };
  const who = row?.from_name || row?.from_email || 'them';
  if (Number(sender?.replied) > 0) add(0.75, `You have replied to ${who}`, true);
  if (wroteTo) add(0.75, `You have written to ${who}`, true);
  if (replyToOwn) add(0.8, 'A reply in a thread you wrote in', true);
  if (decision && decision !== 'block') {
    if (decisionSource === 'user') add(0.75, `You put this sender in ${cap(decision)}`, true);
    else if (decisionSource !== 'import') add(0.3, `Hedwig screened this sender into ${cap(decision)}`);
  }
  if (markedNotSpam) add(0.75, 'You marked their mail not spam before', true);
  if (contact) add(0.7, 'In your contacts', true);
  else if (alwaysIn && !wroteTo) add(0.7, 'You have written to them or they are in your contacts', true);
  const reg = registrable(domainOf(row?.from_email));
  const body = `${row?.subject || ''}\n${text}`;
  if (reg && orderDomains.map(registrable).includes(reg) && (ORDER_RE.test(body) || RECEIPT_RE.test(body))) add(0.7, `Looks like an order you placed with ${reg}`, true);
  if (auth.trusted && auth.dmarc === 'pass') add(0.1, 'Passed DMARC');
  else if (auth.trusted && auth.spf === 'pass' && auth.dkim === 'pass') add(0.05, 'Passed SPF and DKIM');
  const personal = s1 && s1.senderKind === 'person' && !s1.flags?.bulk && (s1.flags?.to || s1.flags?.ccOnly);
  if (personal) add(0.15, 'A person writing to you');
  if (personal && (s1.flags?.question || s1.flags?.request)) add(0.1, 'Asks you something');
  if (decision === 'block') { score -= 1; reasons.push('You blocked this sender'); }
  if (phishingScore > 0) { score -= phishingScore; reasons.push(`Signs of phishing (−${round(phishingScore, 2)})`); }
  return { score: round(Math.max(0, Math.min(0.99, score))), reasons, strong };
}
