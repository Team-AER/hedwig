// Pure decisions about behaviour: which implicit label a message earns, how labels become training
// targets, and whether an outgoing message is something the user is waiting on.
import { analyseText, senderKind } from './signals.js';
import { addressesOf } from '../text.js';

const DAY = 86400_000;

/**
 * Label a triaged message from what the user did with it.
 *   replied or starred            → 'needs_you' (positive)
 *   opened, then archived/deleted → 'dismissed' (negative)
 *   never opened                  → 'ignored'   (negative)
 *   opened and left alone         → null (ambiguous: no label)
 */
export function deriveImplicitLabel({ replied = false, starred = false, opened = false, archived = false, deleted = false } = {}) {
  if (replied || starred) return 'needs_you';
  if (!opened) return 'ignored';
  if (archived || deleted) return 'dismissed';
  return null;
}

/** Training target for a feedback label: 1 needs you, 0 does not, null not a needs-you decision. */
export function labelTarget(label) {
  if (label === 'needs_you') return 1;
  if (label === 'waiting_on' || !label) return null;
  return 0;
}

export const EXPLICIT_WEIGHT = 3;
export const IMPLICIT_WEIGHT = 1;

/**
 * Turn feedback rows into training samples. When a message has both, the explicit label wins.
 * @param {Array<{message_id, label, source, features, created_at}>} rows
 */
export function feedbackToSamples(rows) {
  const byMessage = new Map();
  const loose = [];
  for (const r of rows) {
    const target = labelTarget(r.label);
    if (target === null) continue;
    const features = typeof r.features === 'string' ? safeJson(r.features) : r.features;
    if (!features || !Object.keys(features).length) continue;
    const sample = {
      features,
      label: target,
      weight: r.source === 'explicit' ? EXPLICIT_WEIGHT : IMPLICIT_WEIGHT,
      t: new Date(r.created_at || 0).getTime(),
      source: r.source,
    };
    if (!r.message_id) { loose.push(sample); continue; }
    const prev = byMessage.get(r.message_id);
    const outranks = !prev
      || (sample.source === 'explicit' && prev.source !== 'explicit')
      || (sample.source === prev.source && sample.t >= prev.t);
    if (outranks) {
      byMessage.set(r.message_id, sample);
    }
  }
  return [...byMessage.values(), ...loose];
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Is this outgoing message something the user is waiting on? The caller has already established
 * that nothing arrived in the thread after it.
 * @returns {null | { days, reasons, reasonLabel, priority, recipient }}
 */
export function waitingOnDecision({ row, text, userAddresses = new Set(), now = new Date(), waitingDays = 3 }) {
  if (!row?.date) return null;
  const days = Math.floor((now.getTime() - new Date(row.date).getTime()) / DAY);
  if (days < waitingDays) return null;
  const recipients = [...addressesOf(row.to_addresses), ...addressesOf(row.cc_addresses)]
    .filter((a) => !userAddresses.has(a.email) && senderKind(a.email) === 'person');
  if (!recipients.length) return null;
  const t = analyseText(text, new Date(row.date));
  if (!t.question && !t.request) return null;
  const who = recipients[0].name || recipients[0].email;
  const reasons = [
    { label: t.question ? `You asked ${who} a question` : `You asked ${who} to do something`, weight: 1, direction: 'for' },
    { label: `No reply for ${days} days`, weight: Math.min(1, days / 14), direction: 'for' },
  ];
  if (t.deadline) reasons.push({ label: `Your deadline: “${t.deadline.phrase}”`, weight: 0.5, direction: 'for' });
  return {
    days,
    reasons,
    reasonLabel: `Waiting ${days} d`,
    priority: Math.round(Math.min(1, 0.3 + days / 20 + (t.deadline ? 0.2 : 0)) * 1000) / 1000,
    recipient: recipients[0].email,
  };
}
