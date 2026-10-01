// Subscriptions: recurring charges from one payee, found in receipt and invoice cards (a merchant's
// own receipt or a card alert from the bank, which name the payee differently: payeeKey). The next
// renewal is the last charge plus the cadence. Pure.
//
// What counts (audit 2026-09-24: two BookMyShow movie tickets a month apart were listed as a
// monthly subscription; 2026-10-01: Anthropic, OpenAI and Ollama never were, because the mail kept
// only one or two charges of each): at least 3 charges whose intervals agree on a cadence; or 2
// charges one cadence apart, or 1 charge whose mail names its cadence, when the mail says it recurs
// (subscription, renewal, membership, …) or the payee is a known subscription service. Amounts within
// 15% of each other with 2 or 3 charges, 25% from 4 up; receipts that each carry their own order or
// booking number are one-off orders unless the mail says it recurs; a charge from mail that is also
// a ticket, a trip or a parcel is never one; money coming in is never one; and a payee the owner said
// is not recurring is never derived again. What falls short with some evidence is a candidate: the
// Bills view asks the owner.
import { merchantKey, payeeKey } from './kinds.js';

export const MIN_CHARGES = 3;
// Words a recurring charge's mail uses. "plan" alone is too common ("plan your evening").
export const RECURRING_SIGNAL = /\b(subscriptions?|subscribed|renewal|renews?|renewed|auto-?renew(?:al|s|ed)?|billing (?:period|cycle)|next (?:payment|billing|charge|bill)|membership|recurring|your plan|(?:monthly|annual|yearly|premium|family|individual) plan|plan (?:renewal|renews))\b/i;
// The cadence a recurring charge's mail names ("billed monthly", "annual plan", "$20/mo").
const CADENCE_WORDS = [
  { cadence: 'monthly', re: /\b(monthly|per month|a month|every month|\/\s?mo(?:nth)?)\b/i },
  { cadence: 'yearly', re: /\b(annual(?:ly)?|yearly|per year|a year|every year|\/\s?yr|\/\s?year|12 months)\b/i },
  { cadence: 'quarterly', re: /\b(quarterly|every (?:3|three) months)\b/i },
  { cadence: 'weekly', re: /\b(weekly|per week|every week)\b/i },
];
// Card kinds whose mail is a one-off thing even when it carries a charge.
export const ONE_OFF_KINDS = new Set(['event', 'travel', 'delivery']);

const CADENCE_DAYS = [
  { cadence: 'weekly', days: 7, tol: 2 },
  { cadence: 'monthly', days: 30.4, tol: 5 },
  { cadence: 'quarterly', days: 91.3, tol: 10 },
  { cadence: 'yearly', days: 365.25, tol: 20 },
];

const DAY = 86400_000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function addCadence(dateStr, cadence) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (cadence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else {
    const months = { monthly: 1, quarterly: 3, yearly: 12 }[cadence];
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d.toISOString().slice(0, 10);
}

/** The cadence intervals fit, or null. One interval is never a cadence: at least two must agree. */
export function cadenceOf(intervalsDays) {
  if (intervalsDays.length < 2) return null;
  const med = median(intervalsDays);
  const fit = CADENCE_DAYS.find((c) => Math.abs(med - c.days) <= c.tol);
  if (!fit) return null;
  const ok = intervalsDays.filter((d) => Math.abs(d - fit.days) <= fit.tol * 1.6).length;
  return ok >= 2 && ok / intervalsDays.length >= 0.75 ? fit.cadence : null;
}

/** Does a charge's mail say it recurs (subject, snippet, the quotes its card kept)? Pure. */
export function recurringSignal(charge) {
  return chargeTexts(charge).some((t) => RECURRING_SIGNAL.test(t));
}

const chargeTexts = (charge) => {
  const texts = [charge?.subject, charge?.snippet, ...(Array.isArray(charge?.texts) ? charge.texts : [])];
  for (const src of Object.values(charge?.sources || {})) if (src && typeof src === 'object' && src.quote) texts.push(src.quote);
  return texts.filter(Boolean).map(String);
};

/** The cadence a charge's mail names, or null. Pure. */
export function cadenceInText(charge) {
  for (const t of chargeTexts(charge)) {
    const hit = CADENCE_WORDS.find((c) => c.re.test(t));
    if (hit) return hit.cadence;
  }
  return null;
}

/** Is this payee one the owner's list of subscription services names? Pure. */
export function knownPayee(key, known) {
  if (!key || !known) return false;
  for (const k of known) {
    const kk = payeeKey(k);
    if (kk && (key === kk || key.startsWith(`${kk} `))) return true;
  }
  return false;
}

/**
 * Why a series of charges from one merchant is not a subscription, or null when it is one. Pure.
 * @param {{ amount: number, orderNumber?: string, kind?: string, siblingKinds?: string[] }[]} series one charge per day, oldest first
 */
export function notRecurringReason(series, { minCharges = MIN_CHARGES, evidence = false } = {}) {
  // Without evidence that the charge recurs it takes three charges to show a cadence; with it, one
  // (the caller then needs a cadence from an interval or from the mail's own words).
  if (series.length < (evidence ? 1 : Math.max(MIN_CHARGES, minCharges))) return 'too_few_charges';
  if (series.some((c) => ONE_OFF_KINDS.has(c.kind) || (c.siblingKinds || []).some((k) => ONE_OFF_KINDS.has(k)))) return 'one_off_kind';
  const amounts = series.map((c) => c.amount);
  const typical = median(amounts);
  if (!(typical > 0)) return 'no_amount';
  // Recurring charges cost about the same each time (price changes happen; one-off orders vary).
  const tol = series.length <= 3 ? 0.15 : 0.25;
  const steady = amounts.filter((a) => Math.abs(a - typical) <= typical * tol).length / amounts.length;
  if (steady < 0.75) return 'amounts_vary';
  // Receipts with their own order numbers are separate orders, unless the mail says the charge recurs.
  const refs = new Set(series.map((c) => String(c.orderNumber || '').replace(/\s+/g, '').toUpperCase()).filter(Boolean));
  if (refs.size >= 2) {
    const said = series.filter(recurringSignal).length;
    if (!said || said * 2 < series.length) return 'separate_orders';
  }
  return null;
}

const DAY_MS = DAY;
const near = (a, b) => Math.abs(a - b) <= Math.max(0.01, Math.max(Math.abs(a), Math.abs(b)) * 0.02);

/**
 * One charge per payment: an order confirmation and its receipt on the same day, or a card alert and
 * the merchant's receipt a day apart for the same amount, are one charge. Oldest first. Pure.
 */
export function dedupeCharges(list) {
  const out = [];
  for (const c of [...list].sort((a, b) => a.t - b.t)) {
    const prev = out[out.length - 1];
    if (prev && (prev.t === c.t || (c.t - prev.t <= DAY_MS && near(prev.amount, c.amount)))) {
      prev.also = [...(prev.also || []), c];
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

/**
 * Every payee with its charges and a verdict: 'subscription', 'candidate' (some evidence, the owner
 * decides) or 'one_off'. Charges are grouped by payee and currency; money coming in is left out.
 * @param {{ cardId?: string, messageId: string, merchant: string, amount: number, currency: string, date: string,
 *           kind?: 'receipt'|'invoice', direction?: 'out'|'in', orderNumber?: string, siblingKinds?: string[],
 *           subject?: string, snippet?: string, sources?: object }[]} charges
 * @param {{ minCharges?: number, now?: Date, oneOff?: Set<string>, known?: string[] }} [opts] oneOff: payee or
 *   merchant keys the owner said are not recurring; known: subscription services (cards.recurringPayees)
 */
export function classifyPayees(charges, { minCharges = MIN_CHARGES, now = new Date(), oneOff = null, known = null } = {}) {
  const groups = new Map();
  for (const c of charges || []) {
    if (!c?.merchant || c.amount == null || c.amount === '' || !Number.isFinite(Number(c.amount)) || !c.date) continue;
    if (c.kind && c.kind !== 'receipt' && c.kind !== 'invoice') continue;
    if (c.direction === 'in' || Number(c.amount) <= 0) continue;
    const pk = payeeKey(c.merchant);
    if (!pk) continue;
    const key = `${pk}|${c.currency || ''}`;
    if (!groups.has(key)) groups.set(key, { payee: pk, list: [] });
    groups.get(key).list.push({ ...c, amount: Number(c.amount), t: new Date(`${String(c.date).slice(0, 10)}T12:00:00Z`).getTime() });
  }
  const out = [];
  for (const { payee, list } of groups.values()) {
    const series = dedupeCharges(list);
    const last = series[series.length - 1];
    const names = [...new Set(list.map((c) => c.merchant))];
    const blocked = oneOff?.has(payee) || names.some((n) => oneOff?.has(merchantKey(n)));
    const isKnown = knownPayee(payee, known);
    const said = series.filter(recurringSignal).length;
    const signal = said > 0 && said * 2 >= series.length;
    const intervals = series.slice(1).map((c, i) => (c.t - series[i].t) / DAY);
    const textCadence = series.map(cadenceInText).find(Boolean) || null;
    let cadence = cadenceOf(intervals);
    let verdict = 'one_off';
    let reason;
    if (blocked) reason = 'owner_one_off';
    else {
      reason = notRecurringReason(series, { minCharges });
      if (!reason && cadence) verdict = 'subscription';
      else {
        // Fewer charges, with evidence: one interval that fits a cadence, or the cadence the mail names.
        const evidence = signal || isKnown;
        const soft = notRecurringReason(series, { minCharges, evidence: true });
        const one = intervals.length === 1 ? CADENCE_DAYS.find((c) => Math.abs(intervals[0] - c.days) <= c.tol)?.cadence || null : null;
        const fit = cadence || (intervals.length <= 1 ? one || textCadence : null);
        if (!soft && evidence && fit) {
          verdict = 'subscription';
          cadence = fit;
          reason = null;
        } else if (!soft && (evidence || one)) {
          verdict = 'candidate';
          cadence = fit;
          reason = !evidence ? 'no_evidence' : !fit ? 'cadence_unknown' : 'too_few_charges';
        } else reason = reason || soft || 'no_cadence';
      }
    }
    const lastCharged = new Date(last.t).toISOString().slice(0, 10);
    let nextRenewal = cadence ? addCadence(lastCharged, cadence) : null;
    // A renewal long overdue means the subscription probably ended; keep it, but say when it lapsed.
    const lapsed = Boolean(nextRenewal) && new Date(`${nextRenewal}T12:00:00Z`).getTime() < new Date(now).getTime() - 45 * DAY;
    if (lapsed) nextRenewal = null;
    out.push({
      payee,
      merchant: last.merchant,
      merchantKey: merchantKey(last.merchant),
      names,
      currency: last.currency || null,
      amount: last.amount,
      cadence: cadence || null,
      lastCharged,
      nextRenewal,
      lapsed,
      charges: series.length,
      verdict,
      reason,
      evidence: { known: isKnown, signal, textCadence },
      messageIds: series.flatMap((c) => [c.messageId, ...(c.also || []).map((a) => a.messageId)]).filter(Boolean),
      lastMessageId: last.messageId,
      cardIds: series.flatMap((c) => [c.cardId, ...(c.also || []).map((a) => a.cardId)]).filter(Boolean),
    });
  }
  return out.sort((a, b) => a.merchant.localeCompare(b.merchant));
}

/**
 * Group charges into subscriptions (the payees classifyPayees calls one).
 * @returns {{ merchant, merchantKey, payee, currency, amount, cadence, lastCharged, nextRenewal, charges, messageIds: string[], lastMessageId, cardIds: string[] }[]}
 */
export function findSubscriptions(charges, opts = {}) {
  return classifyPayees(charges, opts).filter((p) => p.verdict === 'subscription');
}
