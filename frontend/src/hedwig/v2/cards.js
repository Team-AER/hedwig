// Records cards (GET /cards/…, stream G): how a card reads as a figure with a caption, which of its
// fields the slip lists and edits, the bundle summary Records shows, and the payloads its actions
// need (an .ics download, a reminder for the work module). Pure apart from `downloadIcs`, so node
// tests can cover it directly.
import { fullTime, money, relDay, shortDate } from './format.js';
import { tv, tvn } from './i18n.js';

// The fields a slip lists (and edits), per kind, in reading order. Hedwig's own bookkeeping
// (history, charges, sequence) is never shown for editing.
export const CARD_FIELDS = {
  receipt: ['merchant', 'total', 'currency', 'date', 'orderNumber'],
  invoice: ['issuer', 'amount', 'currency', 'dueDate', 'status', 'invoiceNumber'],
  subscription: ['merchant', 'amount', 'currency', 'cadence', 'nextRenewal'],
  delivery: ['item', 'carrier', 'status', 'expectedDate', 'trackingNumber'],
  travel: ['provider', 'reference', 'from', 'to', 'departAt', 'checkIn', 'checkOut', 'flightNumber'],
  event: ['title', 'start', 'end', 'location'],
  code: ['code', 'service', 'expiresAt'],
  deadline: ['what', 'dueAt'],
};

// Field types as backend/src/hedwig/cards/kinds.js declares them (only the ones listed above).
const ENUMS = {
  status: { delivery: ['ordered', 'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'unknown'], invoice: ['due', 'paid', 'overdue'] },
  cadence: { subscription: ['weekly', 'monthly', 'quarterly', 'yearly'] },
};
const DATES = new Set(['date', 'dueDate', 'nextRenewal', 'expectedDate', 'checkIn', 'checkOut']);
const DATETIMES = new Set(['departAt', 'start', 'end', 'expiresAt', 'dueAt']);
const NUMBERS = new Set(['total', 'amount']);

/** 'enum' | 'date' | 'datetime' | 'number' | 'text', and the enum's options. */
export function fieldType(kind, key) {
  const options = ENUMS[key]?.[kind];
  if (options) return { type: 'enum', options };
  if (DATES.has(key)) return { type: 'date' };
  if (DATETIMES.has(key)) return { type: 'datetime' };
  if (NUMBERS.has(key)) return { type: 'number' };
  return { type: 'text' };
}

export function fieldLabel(key) {
  const L = {
    merchant: () => tv('hedwig.v2.card.field.merchant', 'Merchant'),
    total: () => tv('hedwig.v2.card.field.total', 'Total'),
    currency: () => tv('hedwig.v2.card.field.currency', 'Currency'),
    date: () => tv('hedwig.v2.card.field.date', 'Date'),
    orderNumber: () => tv('hedwig.v2.card.field.orderNumber', 'Order number'),
    issuer: () => tv('hedwig.v2.card.field.issuer', 'From'),
    amount: () => tv('hedwig.v2.card.field.amount', 'Amount'),
    dueDate: () => tv('hedwig.v2.card.field.dueDate', 'Due'),
    status: () => tv('hedwig.v2.card.field.status', 'Status'),
    invoiceNumber: () => tv('hedwig.v2.card.field.invoiceNumber', 'Invoice number'),
    cadence: () => tv('hedwig.v2.card.field.cadence', 'Billed'),
    nextRenewal: () => tv('hedwig.v2.card.field.nextRenewal', 'Next renewal'),
    item: () => tv('hedwig.v2.card.field.item', 'Item'),
    carrier: () => tv('hedwig.v2.card.field.carrier', 'Carrier'),
    expectedDate: () => tv('hedwig.v2.card.field.expectedDate', 'Expected'),
    trackingNumber: () => tv('hedwig.v2.card.field.trackingNumber', 'Tracking number'),
    provider: () => tv('hedwig.v2.card.field.provider', 'Provider'),
    reference: () => tv('hedwig.v2.card.field.reference', 'Reference'),
    from: () => tv('hedwig.v2.card.field.from', 'Departs from'),
    to: () => tv('hedwig.v2.card.field.to', 'Arrives at'),
    departAt: () => tv('hedwig.v2.card.field.departAt', 'Departure'),
    checkIn: () => tv('hedwig.v2.card.field.checkIn', 'Check-in'),
    checkOut: () => tv('hedwig.v2.card.field.checkOut', 'Check-out'),
    flightNumber: () => tv('hedwig.v2.card.field.flightNumber', 'Flight'),
    title: () => tv('hedwig.v2.card.field.title', 'What'),
    start: () => tv('hedwig.v2.card.field.start', 'Starts'),
    end: () => tv('hedwig.v2.card.field.end', 'Ends'),
    location: () => tv('hedwig.v2.card.field.location', 'Where'),
    code: () => tv('hedwig.v2.card.field.code', 'Code'),
    service: () => tv('hedwig.v2.card.field.service', 'For'),
    expiresAt: () => tv('hedwig.v2.card.field.expiresAt', 'Expires'),
  };
  if (key === 'what') return L.title();
  if (key === 'dueAt') return L.dueDate();
  return L[key] ? L[key]() : key;
}

export function statusLabel(status) {
  const L = {
    ordered: () => tv('hedwig.v2.card.status.ordered', 'ordered'),
    shipped: () => tv('hedwig.v2.card.status.shipped', 'shipped'),
    in_transit: () => tv('hedwig.v2.card.status.inTransit', 'on its way'),
    out_for_delivery: () => tv('hedwig.v2.card.status.outForDelivery', 'out for delivery'),
    delivered: () => tv('hedwig.v2.card.status.delivered', 'delivered'),
    exception: () => tv('hedwig.v2.card.status.exception', 'held up'),
    unknown: () => tv('hedwig.v2.card.status.unknown', 'status unknown'),
    due: () => tv('hedwig.v2.card.status.due', 'due'),
    paid: () => tv('hedwig.v2.card.status.paid', 'paid'),
    overdue: () => tv('hedwig.v2.card.status.overdue', 'overdue'),
  };
  return L[status] ? L[status]() : String(status || '');
}

// The Correct form's cadence choice that is not a cadence: it sends POST /cards/:id/not-recurring.
export const NOT_RECURRING = 'not_recurring';

export function cadenceLabel(cadence) {
  const L = {
    weekly: () => tv('hedwig.v2.card.cadence.weekly', 'weekly'),
    monthly: () => tv('hedwig.v2.card.cadence.monthly', 'monthly'),
    quarterly: () => tv('hedwig.v2.card.cadence.quarterly', 'quarterly'),
    yearly: () => tv('hedwig.v2.card.cadence.yearly', 'yearly'),
    [NOT_RECURRING]: () => tv('hedwig.v2.card.cadence.notRecurring', 'Not recurring'),
  };
  return L[cadence] ? L[cadence]() : (cadence ? String(cadence) : tv('hedwig.v2.card.cadence.unknown', 'cadence unknown'));
}

/** Whether a subscription's cadence is one Hedwig can turn into a monthly figure. */
export const knownCadence = (c) => ['weekly', 'monthly', 'quarterly', 'yearly'].includes(c);

/** "Not a receipt", "Not an event", … : the card menu's way to say Hedwig read the wrong kind. */
export function notKindLabel(kind) {
  const L = {
    receipt: () => tv('hedwig.v2.card.notKind.receipt', 'Not a receipt'),
    invoice: () => tv('hedwig.v2.card.notKind.invoice', 'Not a bill'),
    subscription: () => tv('hedwig.v2.card.notKind.subscription', 'Not a subscription'),
    delivery: () => tv('hedwig.v2.card.notKind.delivery', 'Not a delivery'),
    travel: () => tv('hedwig.v2.card.notKind.travel', 'Not a booking'),
    event: () => tv('hedwig.v2.card.notKind.event', 'Not an event'),
    code: () => tv('hedwig.v2.card.notKind.code', 'Not a code'),
    deadline: () => tv('hedwig.v2.card.notKind.deadline', 'Not a deadline'),
  };
  return L[kind] ? L[kind]() : tv('hedwig.v2.card.notKind.other', 'Not this kind');
}

/** One field's value as the slip shows it. */
export function fieldText(card, key, now = new Date()) {
  const f = card?.fields || {};
  const v = f[key];
  if (v == null || v === '') return '';
  if (key === 'status') return statusLabel(v);
  if (key === 'cadence') return cadenceLabel(v);
  if (NUMBERS.has(key)) return money(v, f.currency) || String(v);
  if (DATES.has(key)) return shortDate(v, now);
  if (DATETIMES.has(key)) return fullTime(v);
  return String(v);
}

const clock = (v) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
};
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/**
 * A card as a figure with a caption (and an optional second line): the delivery is "Today" with
 * "DHL, out for delivery", the invoice its amount with "Fjordkraft, due Fri 26", the event its
 * time, the code itself, the subscription its amount with the cadence and the next renewal.
 */
export function cardFigure(card, now = new Date()) {
  const f = card?.fields || {};
  const join = (...xs) => xs.filter(Boolean).join(', ');
  switch (card?.kind) {
    case 'delivery': {
      const delivered = f.status === 'delivered';
      const figure = delivered ? tv('hedwig.v2.card.delivered', 'Delivered')
        : f.expectedDate ? relDay(f.expectedDate, now)
          : f.status === 'out_for_delivery' ? relDay(now, now) : statusLabel(f.status || 'unknown');
      const how = delivered ? null
        : f.status === 'out_for_delivery' || f.status === 'exception' ? statusLabel(f.status)
          : f.expectedBy ? tv('hedwig.v2.card.by', 'by {{time}}', { time: f.expectedBy })
            : f.status && f.status !== 'unknown' ? statusLabel(f.status) : null;
      return { figure, caption: join(f.carrier, how) || f.merchant || tv('hedwig.v2.card.parcel', 'A parcel'), sub: f.item || (f.carrier ? f.merchant : null) || null };
    }
    case 'invoice': {
      const due = f.dueDate ? tv('hedwig.v2.card.dueOn', 'due {{day}}', { day: relDay(f.dueDate, now) }) : null;
      return { figure: money(f.amount, f.currency) || tv('hedwig.v2.card.bill', 'Bill'), caption: join(f.issuer, f.status === 'paid' ? statusLabel('paid') : due), sub: f.invoiceNumber ? tv('hedwig.v2.card.invoiceNo', 'Invoice {{n}}', { n: f.invoiceNumber }) : null };
    }
    case 'receipt':
      return { figure: money(f.total, f.currency) || tv('hedwig.v2.card.receipt', 'Receipt'), caption: join(f.merchant, f.date ? shortDate(f.date, now) : null), sub: f.orderNumber ? tv('hedwig.v2.card.orderNo', 'Order {{n}}', { n: f.orderNumber }) : null };
    case 'subscription':
      // No cadence: say so, never a per-month figure (it read "₹0 a month").
      return {
        figure: money(f.amount, f.currency) || tv('hedwig.v2.card.subscription', 'Subscription'),
        caption: join(f.merchant, cadenceLabel(knownCadence(f.cadence) ? f.cadence : null)),
        sub: f.nextRenewal ? tv('hedwig.v2.card.renews', 'Renews {{day}}', { day: relDay(f.nextRenewal, now) }) : null,
      };
    case 'event': {
      const allDay = f.allDay || isDay(f.start);
      return {
        figure: !f.start ? tv('hedwig.v2.card.event', 'Event') : allDay ? relDay(f.start, now) : clock(f.start),
        caption: f.title || tv('hedwig.v2.card.event', 'Event'),
        sub: join(f.start && !allDay ? relDay(f.start, now) : (allDay ? tv('hedwig.v2.card.allDay', 'All day') : null), f.location) || null,
      };
    }
    case 'travel': {
      const when = f.departAt || f.checkIn;
      const route = f.from && f.to ? `${f.from} → ${f.to}` : (f.location || null);
      return {
        figure: f.departAt ? clock(f.departAt) : when ? relDay(when, now) : (f.reference || tv('hedwig.v2.card.trip', 'Trip')),
        caption: join([f.flightNumber || f.provider, route].filter(Boolean).join(' ')) || tv('hedwig.v2.card.trip', 'Trip'),
        sub: join(f.departAt ? relDay(f.departAt, now) : null, f.reference) || null,
      };
    }
    case 'code':
      return { figure: f.code || '', caption: f.service || tv('hedwig.v2.card.code', 'One-time code'), sub: f.expiresAt ? tv('hedwig.v2.card.expires', 'Expires {{time}}', { time: clock(f.expiresAt) }) : null, code: true };
    case 'deadline':
      return { figure: f.dueAt ? relDay(f.dueAt, now) : '', caption: f.what || tv('hedwig.v2.thread.deadline', 'Deadline'), sub: f.counterparty || null };
    default:
      return { figure: '', caption: '' };
  }
}

/** The fields a card shows on its slip: declared for its kind, with a value or editable. */
export function cardFields(card) {
  return (CARD_FIELDS[card?.kind] || []).filter((k) => card.fields?.[k] != null && card.fields[k] !== '');
}

/** The value an edit input starts from (dates as YYYY-MM-DD, times as local datetime-local). */
export function inputValue(card, key) {
  const v = card?.fields?.[key];
  if (v == null) return '';
  const { type } = fieldType(card.kind, key);
  if (type === 'date') return String(v).slice(0, 10);
  if (type === 'datetime') {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return String(v);
}

/**
 * The PATCH /cards/:id body for an edit: only what changed; an emptied field clears it (null).
 * Local datetime-local values go out as ISO instants. Returns null when nothing changed.
 */
export function editPatch(card, draft) {
  // "Not recurring" is not an edit: the card goes, and Hedwig stops deriving that merchant.
  if (card?.kind === 'subscription' && draft?.cadence === NOT_RECURRING) return { notRecurring: true };
  const out = {};
  for (const [k, raw] of Object.entries(draft || {})) {
    const before = inputValue(card, k);
    const v = typeof raw === 'string' ? raw.trim() : raw;
    if (v === before) continue;
    if (v === '' || v == null) { out[k] = null; continue; }
    const { type } = fieldType(card.kind, k);
    if (type === 'datetime') {
      const d = new Date(v);
      out[k] = Number.isNaN(d.getTime()) ? v : d.toISOString();
    } else if (type === 'number') {
      const n = Number(String(v).replace(',', '.'));
      out[k] = Number.isFinite(n) ? n : v;
    } else {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? { fields: out } : null;
}

/** Where a field's value came from: { quote, messageId, attachment, edited, before } or null. */
export function fieldSource(card, key) {
  const s = card?.sources?.[key];
  if (!s || typeof s !== 'object') return null;
  if (s.via === 'user') return { edited: true, before: s.before ?? null, cleared: Boolean(s.cleared) };
  return { quote: s.quote ? String(s.quote) : null, messageId: s.messageId || null, attachment: s.attachment || null, edited: false };
}

// ── Records bundles: a one-line summary from the bundle's cards ─────────────

const dayKey = (v) => {
  if (isDay(v)) return String(v);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Whether a delivery card arrives today (expected today, or out for delivery). */
export function arrivesToday(card, now = new Date()) {
  const f = card?.fields || {};
  if (card?.kind !== 'delivery' || f.status === 'delivered') return false;
  return f.status === 'out_for_delivery' || dayKey(f.expectedDate) === dayKey(now);
}

function dueWithin(card, days, now) {
  const f = card?.fields || {};
  if (card?.kind !== 'invoice' || !f.dueDate || f.status === 'paid') return false;
  const d = dayKey(f.dueDate);
  const t = dayKey(now);
  if (!d || !t) return false;
  const diff = (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86400000;
  return diff >= 0 && diff <= days;
}

/**
 * "3 deliveries, 1 arriving today" — the Records summary of a bundle's cards, most useful kind
 * first. Empty when the bundle has no cards.
 */
export function bundleCardSummary(cards, now = new Date()) {
  const by = {};
  for (const c of cards || []) (by[c.kind] ||= []).push(c);
  const parts = [];
  if (by.delivery) {
    const n = by.delivery.length;
    const today = by.delivery.filter((c) => arrivesToday(c, now)).length;
    parts.push(tvn(n, ['hedwig.v2.card.sum.deliveryOne', '1 delivery'], ['hedwig.v2.card.sum.deliveryMany', '{{n}} deliveries'])
      + (today ? `, ${tv('hedwig.v2.card.sum.arrivingToday', '{{n}} arriving today', { n: today })}` : ''));
  }
  if (by.invoice) {
    const n = by.invoice.length;
    const due = by.invoice.filter((c) => dueWithin(c, 7, now)).length;
    parts.push(tvn(n, ['hedwig.v2.card.sum.billOne', '1 bill'], ['hedwig.v2.card.sum.billMany', '{{n}} bills'])
      + (due ? `, ${tv('hedwig.v2.card.sum.dueThisWeek', '{{n}} due this week', { n: due })}` : ''));
  }
  if (by.travel) parts.push(tvn(by.travel.length, ['hedwig.v2.card.sum.tripOne', '1 booking'], ['hedwig.v2.card.sum.tripMany', '{{n}} bookings']));
  if (by.event) parts.push(tvn(by.event.length, ['hedwig.v2.card.sum.eventOne', '1 event'], ['hedwig.v2.card.sum.eventMany', '{{n}} events']));
  if (by.receipt) parts.push(tvn(by.receipt.length, ['hedwig.v2.card.sum.receiptOne', '1 receipt'], ['hedwig.v2.card.sum.receiptMany', '{{n}} receipts']));
  if (by.subscription) {
    const n = by.subscription.length;
    parts.push(tvn(n, ['hedwig.v2.card.sum.subscriptionOne', '1 subscription'], ['hedwig.v2.card.sum.subscriptionMany', '{{n}} subscriptions'])
      + cadenceUnknownNote(n, by.subscription.filter((c) => !knownCadence(c.fields?.cadence)).length));
  }
  if (by.code) parts.push(tvn(by.code.length, ['hedwig.v2.card.sum.codeOne', '1 code'], ['hedwig.v2.card.sum.codeMany', '{{n}} codes']));
  return parts.join(' · ');
}

/** ", cadence unknown" (all of them) or ", 2 cadence unknown" (some); '' when every cadence is known. */
export function cadenceUnknownNote(count, unknown) {
  if (!unknown) return '';
  return unknown >= count
    ? `, ${tv('hedwig.v2.card.cadence.unknown', 'cadence unknown')}`
    : `, ${tv('hedwig.v2.card.sum.cadenceUnknownSome', '{{n}} cadence unknown', { n: unknown })}`;
}

/** Cards by the message ids they were read from (a card names every message it merged). */
export function cardsByMessage(cards) {
  const map = new Map();
  for (const c of cards || []) {
    if (c.dismissedAt) continue;
    for (const id of new Set([c.messageId, ...(c.messageIds || [])].filter(Boolean))) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(c);
    }
  }
  return map;
}

/** The distinct cards behind a list of stream items, most urgent first (arriving today, due soon). */
export function cardsForItems(items, byMessage, now = new Date()) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    for (const c of byMessage.get(it.messageId) || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  const rank = (c) => (arrivesToday(c, now) ? 0 : dueWithin(c, 7, now) ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * G's reminder action payload ({ title, remindAt, note, messageId, threadId, source }) as F's
 * POST /work/lists/reminder body. F keeps a reminder on a thread when there is one, and takes a
 * free-standing one ({ note, until }) when there is not.
 */
export function reminderBody(reminder) {
  if (!reminder?.remindAt) return null;
  const title = String(reminder.title || '').trim();
  const note = reminder.threadId ? title : [title, reminder.note].filter(Boolean).join(' · ');
  if (!note) return null;
  return { ...(reminder.threadId ? { threadId: reminder.threadId } : {}), note: note.slice(0, 500), until: reminder.remindAt };
}

/** Only web links are opened from a card. */
export function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : null;
}

/** Offer a card's .ics as a download (Blob + a temporary link). */
export function downloadIcs(action) {
  if (!action?.ics || typeof document === 'undefined') return false;
  const blob = new Blob([action.ics], { type: action.mime || 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = action.filename || 'hedwig.ics';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function actionLabel(action) {
  const L = {
    calendar: () => tv('hedwig.v2.card.action.calendar', 'Add to calendar'),
    reminder: () => tv('hedwig.v2.thread.remind', 'Remind me'),
    track: () => tv('hedwig.v2.card.action.track', 'Track parcel'),
    copy: () => tv('hedwig.v2.card.action.copy', 'Copy code'),
  };
  return L[action?.id] ? L[action.id]() : (action?.label || action?.id || '');
}
