// Guard: a threat check on new mail from senders the user has not corresponded with. The decision
// model (aer-laya-guard, served by Avifors behind llm-proxy as Ollama/Nimble-compatible
// POST /v1/systemone) reads the message with the same identity lines it was trained on and says
// whether it is safe, spam, a scam, phishing, impersonation or malware. It adds to the rules in
// spam.js and never lowers a verdict: a confident threat moves the message to Spam with the
// model's reason (layer 'decision', prompt 'sort.guard'), and that verdict stays until the user
// corrects it or decides the sender. Anything else leaves the message exactly as sorted.
//
// The state and question wording must match training (llm/decision-models/dm/threat.py): change
// them together or not at all.
import { query } from '../../services/db.js';
import { systemOne } from '../llm.js';
import { addressesOf, domainOf } from '../text.js';
import { lookalikeOf, personKey, registrable } from './spam.js';

export const GUARD_VERSION = '2026-10-02.1';
const BODY_CHARS = 1000;
const SPAM_FOLDER_RE = /\\junk|\bspam\b|\bbulk\b/i;

export const THREATS = Object.freeze({
  safe: 'Ordinary mail: people the user knows, real companies, newsletters, receipts and notifications, even if promotional',
  spam: 'Unwanted bulk or cold sales mail that is not trying to deceive or steal',
  scam: 'Fraud from a stranger: advance-fee, fake prizes, awards or funding, extortion, romance or crypto bait',
  phishing: 'Pretends to be a service or brand to steal a password, payment details or access: fake login, account locked, shared-document or tender lures',
  impersonation: 'Pretends to be someone the user knows or works with: a colleague, executive, vendor, client or contact, from an address or domain that is not theirs',
  malware: 'Tries to get the user to open or run something harmful: risky attachments, fake invoices, fake meeting updates, job tests that ask to clone and run code',
});
export const QUESTIONS = Object.freeze({
  threat: { type: 'choice', instructions: 'Is this email a threat, and if so what kind?', criteria: THREATS },
});
const LABEL = { scam: 'a scam', phishing: 'phishing', impersonation: 'impersonation of someone you know', malware: 'malware delivery' };
// spam.js phishing signals quoted as supporting evidence in the guard's reason.
const RULE_SIGNALS = new Set(['lookalike', 'brandName', 'impersonation', 'displayAddress', 'replyTo', 'credential', 'accountThreat', 'prize', 'payment', 'document',
  'linkDomain', 'riskyHost', 'shortener', 'attachment', 'selfAddressed']);
const INLINE_IMAGE_RE = /^(image|logo|outlook)\d*\.(png|jpe?g|gif)$/i;

const capped = (n) => `${Math.min(n, 10)}${n > 10 ? '+' : ''}`;

/** Registrable domains of the HTML's link targets, in the training order (hosts sorted, then deduplicated). */
export function hrefDomains(html) {
  const hosts = new Set();
  const re = /href\s*=\s*["']?(https?:\/\/[^"' >]+)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const host = m[1].replace(/^https?:\/\//i, '').split(/[/:?#]/)[0].toLowerCase();
    if (host) hosts.add(host);
  }
  const out = [];
  for (const h of [...hosts].sort()) {
    const d = registrable(h);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Visible link text that names one site while the link goes to another (first one only). */
function linkTextMismatch(html) {
  const re = /<a\s[^>]*href\s*=\s*["']?(https?:\/\/[^"' >]+)[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(String(html || ''))) && n++ < 40) {
    const text = m[2].replace(/<[^>]*>|\s+/g, ' ').trim().toLowerCase();
    const host = m[1].replace(/^https?:\/\//i, '').split(/[/:?#]/)[0].toLowerCase();
    const shown = text.match(/(?:https?:\/\/|www\.)?((?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|in|co|uk|us|de|app|dev|me|info|biz))\b/);
    if (shown && host && registrable(shown[1]) !== registrable(host)) return `Link text: shows "${shown[1]}" but goes to ${registrable(host)}`;
  }
  return null;
}

/**
 * The identity lines (see dm/threat.py context_lines): history with the address, a known person's
 * name from a new address, a display name hiding another address, a look-alike domain, diverted replies.
 * @param {object} row
 * @param {{ written: number, received: number, knownPeople?: Map<string,string[]>, knownDomains?: string[], own?: boolean }} h
 */
export function contextLines(row, { written = 0, received = 0, knownPeople = null, knownDomains = [], own = false } = {}) {
  if (own) return ["Sender: one of the user's own addresses"];
  const from = String(row.from_email || '').toLowerCase();
  const lines = [];
  if (written) lines.push(`Sender: you have written to this address ${capped(written)} time(s)`);
  else if (received) lines.push(`Sender: ${capped(received)} earlier message(s) from this address; you have never written to it`);
  else lines.push('Sender: first message from this address; you have never written to it');
  const key = personKey(row.from_name);
  const theirs = key && knownPeople?.get(key);
  if (theirs?.length && !theirs.includes(from)) {
    lines.push(`Known name: "${String(row.from_name).trim()}" is someone you write to at ${[...theirs].sort().slice(0, 2).join(', ')}; this address is not one of them`);
  }
  const inner = String(row.from_name || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (inner && inner[0].toLowerCase() !== from) lines.push(`Display name: contains a different address, ${inner[0].toLowerCase()}`);
  // Only look-alikes of the user's correspondents (brand look-alikes are spam.js rule evidence).
  const like = lookalikeOf(domainOf(from), knownDomains);
  if (like && knownDomains.some((k) => registrable(k) === like)) lines.push(`Look-alike: the domain ${domainOf(from)} looks like ${like}, a domain you write to`);
  const rt = addressesOf(row.reply_to).map((a) => a.email).find((a) => registrable(domainOf(a)) !== registrable(domainOf(from)));
  if (rt) lines.push(`Reply-To: replies go to ${rt}`);
  return lines;
}

/** The state text, in the training format. Exported for tests. */
export function guardState(row, parts, ctx = {}, { inSpamFolder = false } = {}) {
  const body = String(parts?.newText || row.body_text || row.snippet || '').slice(0, BODY_CHARS);
  const to = addressesOf(row.to_addresses).length;
  const lines = [
    `From: ${String(row.from_name || '').trim()} <${row.from_email || ''}>`.trim(),
    ...contextLines(row, ctx),
    `To: ${to} recipient(s)${row.in_reply_to ? '; a reply in an existing thread' : ''}`,
  ];
  if (inSpamFolder) lines.push("Delivered to the server's spam folder");
  const doms = hrefDomains(row.body_html);
  if (doms.length) lines.push(`Links: ${doms.slice(0, 5).join(', ')}${doms.length > 5 ? ` (+${doms.length - 5} more)` : ''}`);
  const mismatch = linkTextMismatch(row.body_html);
  if (mismatch) lines.push(mismatch);
  let att = row.attachments;
  if (typeof att === 'string') { try { att = JSON.parse(att); } catch { att = []; } }
  const files = (Array.isArray(att) ? att : []).map((a) => String(a?.filename || a?.name || '')).filter((f) => f && !INLINE_IMAGE_RE.test(f));
  if (files.length) lines.push(`Attachments: ${files.slice(0, 4).join(', ')}`);
  lines.push(`Subject: ${row.subject || ''}`, '', body);
  return lines.join('\n');
}

/** Rule evidence the guard needs before it asks the model (one sign of phishing from spam.js). */
export function hasRuleEvidence(d) {
  return Number(d?.phishingScore) >= 0.25;
}

/**
 * Gate one model answer: { spam, confidence, reason, threat } to apply, or null to leave the message.
 * The rules suspect and the model confirms: with `sort.guard.requireRuleEvidence` (default) a verdict needs
 * one sign of phishing from spam.js, because the model trained on one mailbox also scores some genuine
 * notices high (an Adobe cancellation reached 0.97). A threat needs `sort.guard.flagAbove` of the
 * probability on the malicious options; it is 'phishing' (credential, impersonation or malware with rule
 * evidence, or at `sort.guard.phishingAbove` when evidence is not required) or 'suspected' (a scam).
 */
export function guardVerdict(answers, d, cfg) {
  const p = answers?.threat?.probabilities;
  if (!p) return null;
  const ruleEvidence = hasRuleEvidence(d);
  if (!ruleEvidence && cfg['sort.guard.requireRuleEvidence'] !== false) return null;
  const bad = Object.keys(LABEL).map((k) => [k, Number(p[k]) || 0]).sort((a, b) => b[1] - a[1]);
  const total = bad.reduce((s, [, v]) => s + v, 0);
  if (!(total >= (cfg['sort.guard.flagAbove'] ?? 0.9))) return null;
  const [threat] = bad[0];
  const strong = threat !== 'scam' && (ruleEvidence || total >= (cfg['sort.guard.phishingAbove'] ?? 0.97));
  const pct = Math.round(total * 100);
  const evidence = (d?.signals || []).filter((x) => RULE_SIGNALS.has(x.name)).sort((a, b) => b.weight - a.weight).slice(0, 2);
  const why = ruleEvidence && evidence.length ? `; ${evidence.map((x) => x.label).join('; ')}` : '';
  return {
    threat,
    spam: strong ? 'phishing' : 'suspected',
    confidence: Math.round(total * 1000) / 1000,
    reason: `Looks like ${LABEL[threat]} (threat model, ${pct}% sure)${why}`,
  };
}

/** Sender history for a batch: messages the user wrote to each address and messages received before each one. */
export async function senderHistory(userId, rows) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return new Map();
  const { rows: found } = await query(
    `SELECT m.id,
            COALESCE((SELECT e.sent_count FROM hedwig_entity_addresses a JOIN hedwig_entities e ON e.id = a.entity_id
                       WHERE e.user_id = $1 AND lower(a.email) = lower(m.from_email) LIMIT 1), 0) AS written,
            (SELECT COUNT(*) FROM messages o JOIN email_accounts oa ON oa.id = o.account_id
              WHERE oa.user_id = $1 AND lower(o.from_email) = lower(m.from_email) AND o.date < m.date AND NOT o.is_deleted) AS received
       FROM messages m WHERE m.id = ANY($2::uuid[])`,
    [userId, ids],
  );
  return new Map(found.map((r) => [r.id, { written: Number(r.written) || 0, received: Number(r.received) || 0 }]));
}

/**
 * Is this row worth a guard check? New incoming mail from a sender the user has no standing with, and
 * (unless `sort.guard.requireRuleEvidence` is off) at least one sign of phishing for the model to confirm.
 */
export function guardCandidate(row, d, cfg = {}) {
  if (!d || d.own || row.is_outgoing || d.trustedSender || d.inSpamFolder) return false;
  if (cfg['sort.guard.requireRuleEvidence'] !== false && !hasRuleEvidence(d)) return false;
  if (d.layer === 'rule' && (d.ruleId || d.senderDecision?.source === 'user')) return false;
  if (d.spam === 'phishing' && Number(d.spamConfidence) >= 0.9) return false; // the rules are already sure
  return Boolean(row.body_text || row.body_html || row.snippet);
}

/**
 * Ask the guard model about each entry. Returns Map(rowId → verdict) for the flagged ones only.
 * Never throws: a failure leaves every message as sorted.
 * @param {Array<{ row, d, parts?, history }>} entries
 */
export async function guardBatch(userId, entries, cfg, ctx = {}, { fetchFn } = {}) {
  const out = new Map();
  const model = cfg['sort.guard.model'];
  if (!model) return out;
  const prompt = { id: 'sort.guard', version: GUARD_VERSION, tier: 'decision' };
  for (const { row, d, parts, history } of entries) {
    try {
      const state = guardState(row, parts, { ...history, knownPeople: ctx.knownPeople, knownDomains: ctx.knownDomains },
        { inSpamFolder: SPAM_FOLDER_RE.test(`${row.folder || ''} ${row.special_use || ''}`) });
      const { answers, aiCallId } = await systemOne(
        { model, state, questions: QUESTIONS },
        { userId, feature: 'sort', workflow: 'sort.guard', prompt, timeoutMs: cfg['sort.guard.timeoutMs'], ...(fetchFn ? { fetchFn } : {}) },
      );
      const v = guardVerdict(answers, d, cfg);
      if (v) out.set(row.id, { ...v, provenance: { promptId: prompt.id, promptVersion: prompt.version, model, aiCallId } });
    } catch (err) {
      if (err?.code === 'budget_exceeded' || err?.code === 'llm_disabled') break;
      console.warn(`[hedwig] sort.guard: ${err?.message || err} — leaving the rest of this batch as sorted`);
      break;
    }
  }
  return out;
}
