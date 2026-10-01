// Decision layer (between the classifier and Reflex). A System One decision model — Laya fine-tuned on
// this mailbox's judged labels, served by Avifors behind llm-proxy (Ollama/Nimble-compatible
// POST /v1/systemone) — answers stream / spam / needs-you for each message the cheap layers left
// unsure. When it is confident on all three and the mail looks clean, that answer is final (layer
// 'decision'); anything unsure, spam-like or failing goes to Reflex exactly as before.
//
// The state and question wording must match what the model was trained on
// (llm/decision-models/dm/tasks.py, task hedwig_mail): change them together or not at all.
import { systemOne } from '../llm.js';

export const DECISION_VERSION = '2026-10-01.1';
const BODY_CHARS = 1200;

export const QUESTIONS = Object.freeze({
  stream: {
    type: 'choice',
    instructions: 'Which stream does this email belong in?',
    criteria: {
      people: 'A real person writing to the user, or something the user has to handle personally',
      reading: 'Newsletters, digests, articles, product updates: read when there is time',
      records: 'Receipts, orders, deliveries, bills, statements, bookings, tickets, calendar mail, account and security notifications',
    },
  },
  spam: { type: 'noul', instructions: 'Is this email unwanted bulk, a scam, phishing, or mail the user never asked for?' },
  needs_you: { type: 'noul', instructions: 'Does the user have to reply, decide, pay, sign, book or act on this email?' },
});

function recipients(row) {
  const to = row.to_addresses;
  if (Array.isArray(to)) return to.length;
  if (typeof to === 'string') {
    try { const parsed = JSON.parse(to); return Array.isArray(parsed) ? parsed.length : 0; } catch { return 0; }
  }
  return 0;
}

/** The state text, in the training format. Exported for tests. */
export function decisionState(row, parts, { inSpamFolder = false } = {}) {
  const body = String(parts?.newText || row.body_text || row.snippet || '').slice(0, BODY_CHARS);
  const lines = [
    `From: ${row.from_name || ''} <${row.from_email || ''}>`.trim(),
    `To: ${recipients(row)} recipient(s)${row.in_reply_to ? '; a reply in an existing thread' : ''}`,
  ];
  if (inSpamFolder) lines.push("Delivered to the server's spam folder");
  lines.push(`Subject: ${row.subject || ''}`, '', body);
  return lines.join('\n');
}

/**
 * Gate one model answer into a Reflex-shaped result, or null to escalate to Reflex. Exported for tests.
 * Spam-like mail always escalates: Reflex tells suspected from phishing and writes the reason.
 */
export function gate(answers, cfg) {
  const stream = answers?.stream;
  const spam = Number(answers?.spam?.noul);
  const needs = Number(answers?.needs_you?.noul);
  if (!stream?.probabilities || !Number.isFinite(spam) || !Number.isFinite(needs)) return null;
  const streamP = Number(stream.probabilities[stream.choice]);
  if (!(streamP >= cfg['sort.decision.streamMin'])) return null;
  if (!(spam <= 1 - cfg['sort.decision.cleanMin'])) return null;
  const needsMin = cfg['sort.decision.needsYouMin'];
  if (!(needs >= needsMin || needs <= 1 - needsMin)) return null;
  const needsYou = needs >= needsMin;
  return {
    layer: 'decision',
    stream: stream.choice,
    confidence: Math.round(Math.min(streamP, 1 - spam, needsYou ? needs : 1 - needs) * 1000) / 1000,
    needsYou,
    needsYouReason: null,
    spam: 'clean',
    bundle: null,
    matches: [],
    reason: `Decision model: ${stream.choice}, ${Math.round(streamP * 100)}% sure; clean ${Math.round((1 - spam) * 100)}%`,
  };
}

/**
 * Ask the decision model about each pending message. Returns Map(rowId → result) for the confident
 * ones only. Never throws: a failure leaves every message to Reflex. One request per message (the
 * three questions share the state).
 */
export async function decideBatch(userId, entries, cfg, { fetchFn } = {}) {
  const out = new Map();
  const model = cfg['sort.decision.model'];
  if (!model) return out;
  const prompt = { id: 'sort.decision', version: DECISION_VERSION, tier: 'decision' };
  for (const { row, parts, d } of entries) {
    try {
      const { answers, aiCallId } = await systemOne(
        { model, state: decisionState(row, parts, { inSpamFolder: d?.inSpamFolder }), questions: QUESTIONS },
        { userId, feature: 'sort', workflow: 'sort.decision', prompt, timeoutMs: cfg['sort.decision.timeoutMs'], ...(fetchFn ? { fetchFn } : {}) },
      );
      const r = gate(answers, cfg);
      if (r) out.set(row.id, { ...r, provenance: { promptId: prompt.id, promptVersion: prompt.version, tier: prompt.tier, model, aiCallId } });
    } catch (err) {
      if (err?.code === 'budget_exceeded' || err?.code === 'llm_disabled') break;
      // The decision model is an accelerator: any failure means Reflex decides, as before.
      console.warn(`[hedwig] sort.decision: ${err?.message || err} — leaving the rest of this batch to Reflex`);
      break;
    }
  }
  return out;
}
