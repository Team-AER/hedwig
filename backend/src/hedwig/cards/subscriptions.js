// Subscriptions: recurring charges from one merchant at a steady interval, found in receipt and
// invoice cards. The next renewal is the last charge plus the cadence. Pure.
import { merchantKey } from './kinds.js';

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
export function cadenceOf(intervalsDays) {
  if (!intervalsDays.length) return null;
  const med = median(intervalsDays);
  const fit = CADENCE_DAYS.find((c) => Math.abs(med - c.days) <= c.tol);
  if (!fit) return null;
  const ok = intervalsDays.filter((d) => Math.abs(d - fit.days) <= fit.tol * 1.6).length;
  return ok / intervalsDays.length >= 0.75 ? fit.cadence : null;
}

/**
 * Group charges into subscriptions.
 * @param {{ cardId?: string, messageId: string, merchant: string, amount: number, currency: string, date: string }[]} charges
 * @param {{ minCharges?: number, now?: Date }} [opts]
 * @returns {{ merchant, currency, amount, cadence, lastCharged, nextRenewal, charges, messageIds: string[], lastMessageId, cardIds: string[] }[]}
 */
export function findSubscriptions(charges, { minCharges = 2, now = new Date() } = {}) {
  const groups = new Map();
  for (const c of charges || []) {
    if (!c?.merchant || !Number.isFinite(Number(c.amount)) || !c.date) continue;
    const key = `${merchantKey(c.merchant)}|${c.currency || ''}`;
    if (!merchantKey(c.merchant)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, amount: Number(c.amount), t: new Date(`${String(c.date).slice(0, 10)}T12:00:00Z`).getTime() });
  }
  const out = [];
  for (const list of groups.values()) {
    // One charge per day (an order confirmation and its receipt are the same charge).
    const byDay = new Map();
    for (const c of list.sort((a, b) => a.t - b.t)) if (!byDay.has(c.t)) byDay.set(c.t, c);
    const series = [...byDay.values()];
    if (series.length < minCharges) continue;
    const amounts = series.map((c) => c.amount);
    const typical = median(amounts);
    if (typical <= 0) continue;
    // Recurring charges cost about the same each time (price changes happen; one-off orders vary).
    const steady = amounts.filter((a) => Math.abs(a - typical) <= typical * 0.25).length / amounts.length;
    if (steady < 0.75) continue;
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
