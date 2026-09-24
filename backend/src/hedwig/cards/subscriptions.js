// Subscriptions: recurring charges from one merchant at a steady interval, found in receipt and
// invoice cards. The next renewal is the last charge plus the cadence. Pure.
//
// What counts (audit 2026-09-24: two BookMyShow movie tickets a month apart were listed as a
// monthly subscription): at least 3 charges, whose intervals agree on a cadence at least twice;
// amounts within 15% of each other with 3 charges, 25% from 4 up; receipts that each carry their own
// order or booking number are one-off orders unless the mail says it recurs (subscription, renewal,
// membership, …); a charge from mail that is also a ticket, a trip or a parcel is never one; and a
// merchant the owner said is not recurring is never derived again.
import { merchantKey } from './kinds.js';

export const MIN_CHARGES = 3;
// Words a recurring charge's mail uses. "plan" alone is too common ("plan your evening").
export const RECURRING_SIGNAL = /\b(subscriptions?|subscribed|renewal|renews?|renewed|auto-?renew(?:al|s|ed)?|billing (?:period|cycle)|next (?:payment|billing|charge|bill)|membership|recurring|your plan|(?:monthly|annual|yearly|premium|family|individual) plan|plan (?:renewal|renews))\b/i;
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

function addCadence(dateStr, cadence) {
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

/** The cadence intervals fit, or null. */
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
  const texts = [charge?.subject, charge?.snippet, ...(Array.isArray(charge?.texts) ? charge.texts : [])];
  for (const src of Object.values(charge?.sources || {})) if (src && typeof src === 'object' && src.quote) texts.push(src.quote);
  return texts.some((t) => t && RECURRING_SIGNAL.test(String(t)));
}

/**
 * Why a series of charges from one merchant is not a subscription, or null when it is one. Pure.
 * @param {{ amount: number, orderNumber?: string, kind?: string, siblingKinds?: string[] }[]} series one charge per day, oldest first
 */
export function notRecurringReason(series, { minCharges = MIN_CHARGES } = {}) {
  if (series.length < Math.max(MIN_CHARGES, minCharges)) return 'too_few_charges';
  if (series.some((c) => ONE_OFF_KINDS.has(c.kind) || (c.siblingKinds || []).some((k) => ONE_OFF_KINDS.has(k)))) return 'one_off_kind';
  const amounts = series.map((c) => c.amount);
  const typical = median(amounts);
  if (!(typical > 0)) return 'no_amount';
  // Recurring charges cost about the same each time (price changes happen; one-off orders vary).
  const tol = series.length === 3 ? 0.15 : 0.25;
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

/**
 * Group charges into subscriptions.
 * @param {{ cardId?: string, messageId: string, merchant: string, amount: number, currency: string, date: string,
 *           kind?: 'receipt'|'invoice', orderNumber?: string, siblingKinds?: string[], subject?: string, snippet?: string,
 *           sources?: object }[]} charges
 * @param {{ minCharges?: number, now?: Date, oneOff?: Set<string> }} [opts] oneOff: merchant keys the owner said are not recurring
 * @returns {{ merchant, merchantKey, currency, amount, cadence, lastCharged, nextRenewal, charges, messageIds: string[], lastMessageId, cardIds: string[] }[]}
 */
export function findSubscriptions(charges, { minCharges = MIN_CHARGES, now = new Date(), oneOff = null } = {}) {
  const groups = new Map();
  for (const c of charges || []) {
    if (!c?.merchant || c.amount == null || c.amount === '' || !Number.isFinite(Number(c.amount)) || !c.date) continue;
    if (c.kind && c.kind !== 'receipt' && c.kind !== 'invoice') continue;
    const mk = merchantKey(c.merchant);
    if (!mk || oneOff?.has(mk)) continue;
    const key = `${mk}|${c.currency || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, amount: Number(c.amount), t: new Date(`${String(c.date).slice(0, 10)}T12:00:00Z`).getTime() });
  }
  const out = [];
  for (const list of groups.values()) {
    // One charge per day (an order confirmation and its receipt are the same charge).
    const byDay = new Map();
    for (const c of list.sort((a, b) => a.t - b.t)) if (!byDay.has(c.t)) byDay.set(c.t, c);
    const series = [...byDay.values()];
    if (notRecurringReason(series, { minCharges })) continue;
    const intervals = series.slice(1).map((c, i) => (c.t - series[i].t) / DAY);
    const cadence = cadenceOf(intervals);
    if (!cadence) continue;
    const last = series[series.length - 1];
    const lastCharged = new Date(last.t).toISOString().slice(0, 10);
    let nextRenewal = addCadence(lastCharged, cadence);
    // A renewal long overdue means the subscription probably ended; keep it, but say when it lapsed.
    const lapsed = new Date(`${nextRenewal}T12:00:00Z`).getTime() < new Date(now).getTime() - 45 * DAY;
    if (lapsed) nextRenewal = null;
    out.push({
      merchant: last.merchant,
      merchantKey: merchantKey(last.merchant),
      currency: last.currency || null,
      amount: last.amount,
      cadence,
      lastCharged,
      nextRenewal,
      lapsed,
      charges: series.length,
      messageIds: series.map((c) => c.messageId),
      lastMessageId: last.messageId,
      cardIds: series.map((c) => c.cardId).filter(Boolean),
    });
  }
  return out.sort((a, b) => a.merchant.localeCompare(b.merchant));
}
