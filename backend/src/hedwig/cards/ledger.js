// Ledger views: purchases, subscriptions, travel and deliveries as sortable rows, with totals by
// currency (subscriptions also as a monthly equivalent).
import { listCards } from './store.js';

export const LEDGERS = {
  purchases: {
    kinds: ['receipt', 'invoice'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId,
      date: c.fields.date || c.fields.issuedDate || (c.message?.date ? new Date(c.message.date).toISOString().slice(0, 10) : null),
      merchant: c.fields.merchant || c.fields.issuer || null,
      reference: c.fields.orderNumber || c.fields.invoiceNumber || null,
      amount: c.fields.total ?? c.fields.amount ?? null,
      currency: c.fields.currency || null,
      status: c.kind === 'invoice' ? (c.fields.status || 'due') : 'paid',
      dueDate: c.fields.dueDate || null,
      items: c.fields.items || [],
    }),
    sorts: ['date', 'merchant', 'amount', 'dueDate', 'status'],
    defaultSort: ['date', 'desc'],
  },
  subscriptions: {
    kinds: ['subscription'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId, merchant: c.fields.merchant || null, amount: c.fields.amount ?? null,
      currency: c.fields.currency || null, cadence: c.fields.cadence || null, lastCharged: c.fields.lastCharged || null,
      nextRenewal: c.fields.nextRenewal || null, charges: c.fields.charges ?? null, messageIds: c.messageIds,
    }),
    sorts: ['nextRenewal', 'merchant', 'amount', 'lastCharged', 'cadence'],
    defaultSort: ['nextRenewal', 'asc'],
  },
  travel: {
    kinds: ['travel'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId, type: c.fields.type || null, provider: c.fields.provider || null,
      reference: c.fields.reference || null, flightNumber: c.fields.flightNumber || null, from: c.fields.from || null, to: c.fields.to || null,
      departAt: c.fields.departAt || null, arriveAt: c.fields.arriveAt || null, checkIn: c.fields.checkIn || null, checkOut: c.fields.checkOut || null,
      location: c.fields.location || null, date: c.fields.departAt || c.fields.checkIn || null,
    }),
    sorts: ['date', 'provider', 'type', 'reference'],
    defaultSort: ['date', 'desc'],
  },
  deliveries: {
    kinds: ['delivery'],
    row: (c) => ({
      id: c.id, kind: c.kind, messageId: c.messageId, carrier: c.fields.carrier || null, trackingNumber: c.fields.trackingNumber || null,
      trackingUrl: c.fields.trackingUrl || null, status: c.fields.status || null, expectedDate: c.fields.expectedDate || null,
      expectedBy: c.fields.expectedBy || null, merchant: c.fields.merchant || null, item: c.fields.item || null,
      updatedAt: c.updatedAt, history: c.fields.history || [],
    }),
    sorts: ['updatedAt', 'expectedDate', 'status', 'carrier'],
    defaultSort: ['updatedAt', 'desc'],
  },
};

const MONTHLY = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };
const round2 = (n) => Math.round(n * 100) / 100;

/** Sort rows by a field; nulls last either way. Pure. */
export function sortRows(rows, field, dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[field];
    const y = b[field];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

/**
 * Totals per currency. Pure. With `monthly`, a subscription without a known cadence adds nothing
 * to the monthly figure (it was "₹0 a month") and is counted in unknownCadence instead.
 */
export function totalsByCurrency(rows, { monthly = false } = {}) {
  const by = new Map();
  for (const r of rows) {
    if (r.amount == null) continue;
    const cur = r.currency || '?';
    const t = by.get(cur) || { currency: r.currency || null, total: 0, count: 0, ...(monthly ? { monthly: 0, unknownCadence: 0 } : {}) };
    t.total += Number(r.amount);
    t.count++;
    if (monthly && MONTHLY[r.cadence]) t.monthly += Number(r.amount) * MONTHLY[r.cadence];
    else if (monthly) t.unknownCadence++;
    by.set(cur, t);
  }
  return [...by.values()].map((t) => ({ ...t, total: round2(t.total), ...(monthly ? { monthly: round2(t.monthly) } : {}) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * One ledger.
 * @param {'purchases'|'subscriptions'|'travel'|'deliveries'} name
 * @param {{ sort?: string, dir?: 'asc'|'desc', since?: string, limit?: number }} [opts]
 */
export async function ledger(userId, name, { sort = null, dir = null, since = null, limit = 500 } = {}) {
  const def = LEDGERS[name];
  if (!def) return null;
  const cards = await listCards(userId, { kinds: def.kinds, limit });
  let rows = cards.map(def.row);
  if (since) {
    const s = String(since).slice(0, 10);
    const key = name === 'deliveries' ? 'updatedAt' : name === 'subscriptions' ? 'lastCharged' : 'date';
    rows = rows.filter((r) => r[key] && String(r[key] instanceof Date ? r[key].toISOString() : r[key]).slice(0, 10) >= s);
  }
  const field = def.sorts.includes(sort) ? sort : def.defaultSort[0];
  const direction = dir === 'asc' || dir === 'desc' ? dir : (field === def.defaultSort[0] ? def.defaultSort[1] : 'desc');
  rows = sortRows(rows, field, direction);
  const totals = name === 'purchases' || name === 'subscriptions' ? totalsByCurrency(rows, { monthly: name === 'subscriptions' }) : [];
  return { kind: name, sort: { field, dir: direction, options: def.sorts }, count: rows.length, totals, rows };
}
