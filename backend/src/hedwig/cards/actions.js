// Card actions: payloads only, no side effects. "Add to calendar" returns an .ics the frontend offers
// as a download; "Set a reminder" returns a reminder the frontend hands to the work module.
import { zonedToUtc, validTimezone } from '../insights/time.js';

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const utc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (s) => String(s).slice(0, 10).replace(/-/g, '');
const nextDay = (s) => { const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** RFC 5545 line folding at 75 octets. Pure. */
export function foldIcs(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    const limit = out.length ? 74 : 75;
    if (Buffer.byteLength(cur + ch, 'utf8') > limit) { out.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

/** What a card puts in a calendar: { summary, start, end, allDay, location, description } or null. Pure. */
export function calendarEntry(card) {
  const f = card.fields || {};
  const from = card.message?.subject ? `From your mail: ${card.message.subject}` : '';
  switch (card.kind) {
    case 'event':
      if (!f.start) return null;
      return { summary: f.title || 'Event', start: f.start, end: f.end || null, allDay: Boolean(f.allDay) || isDate(f.start), location: f.location, description: [f.organizer && `Organiser: ${f.organizer}`, from].filter(Boolean).join('\n') };
    case 'travel': {
      const start = f.departAt || f.checkIn;
      if (!start) return null;
      const summary = f.type === 'hotel' ? `${f.provider || 'Hotel'} (${f.reference || 'stay'})`
        : [f.flightNumber || f.provider || 'Trip', f.from && f.to ? `${f.from} → ${f.to}` : null].filter(Boolean).join(' ');
      return { summary, start, end: f.arriveAt || f.checkOut || null, allDay: isDate(start), location: f.location || f.from, description: [f.reference && `Reference: ${f.reference}`, from].filter(Boolean).join('\n') };
    }
    case 'delivery':
      if (!f.expectedDate) return null;
      return { summary: `Delivery: ${f.item || f.merchant || 'parcel'}${f.carrier ? ` (${f.carrier})` : ''}`, start: f.expectedDate, allDay: true, description: [f.trackingNumber && `Tracking: ${f.trackingNumber}`, f.trackingUrl, from].filter(Boolean).join('\n') };
    case 'invoice':
      if (!f.dueDate) return null;
      return { summary: `Pay ${f.issuer || 'bill'}${f.amount != null ? ` ${f.amount} ${f.currency || ''}`.trimEnd() : ''}`, start: f.dueDate, allDay: true, description: [f.invoiceNumber && `Invoice ${f.invoiceNumber}`, from].filter(Boolean).join('\n') };
    case 'subscription':
      if (!f.nextRenewal) return null;
      return { summary: `${f.merchant || 'Subscription'} renews${f.amount != null ? ` (${f.amount} ${f.currency || ''})`.trimEnd() : ''}`, start: f.nextRenewal, allDay: true, description: from };
    case 'deadline':
      if (!f.dueAt) return null;
      return { summary: f.what || 'Deadline', start: f.dueAt, allDay: false, description: [f.counterparty && `With ${f.counterparty}`, from].filter(Boolean).join('\n') };
    default:
      return null;
  }
}

/** An .ics file for a card, or null. Pure (given now). */
export function cardIcs(card, { now = new Date() } = {}) {
  const e = calendarEntry(card);
  if (!e) return null;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Team-AER//Hedwig cards//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${card.id}@hedwig`, `DTSTAMP:${utc(now)}`];
  if (e.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.start)}`, `DTEND;VALUE=DATE:${dateOnly(e.end && isDate(e.end) ? nextDay(e.end) : nextDay(e.start))}`);
  } else {
    const start = new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(start.getTime() + 3600_000);
    lines.push(`DTSTART:${utc(start)}`, `DTEND:${utc(end > start ? end : new Date(start.getTime() + 3600_000))}`);
  }
  lines.push(`SUMMARY:${esc(e.summary)}`);
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  const safe = String(e.summary).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'hedwig';
  return { filename: `${safe}.ics`, mime: 'text/calendar', ics: `${lines.map(foldIcs).join('\r\n')}\r\n` };
}

/** When a reminder should fire for a card, or null. Pure. */
export function reminderFor(card, { tz = 'UTC', now = new Date() } = {}) {
  const f = card.fields || {};
  const zone = validTimezone(tz);
  const at9 = (ymd, daysBefore = 0) => {
    const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - daysBefore);
    return zonedToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 9, minute: 0 }, zone);
  };
  const before = (iso, ms) => new Date(new Date(iso).getTime() - ms);
  let remindAt = null;
  let title = null;
  switch (card.kind) {
    case 'event': if (f.start) { remindAt = isDate(f.start) ? at9(f.start, 1) : before(f.start, 3600_000); title = f.title || 'Event'; } break;
    case 'travel': { const s = f.departAt || f.checkIn; if (s) { remindAt = isDate(s) ? at9(s, 1) : before(s, 3 * 3600_000); title = calendarEntry(card)?.summary || 'Trip'; } break; }
    case 'invoice': if (f.dueDate) { remindAt = at9(f.dueDate, 2); title = `Pay ${f.issuer || 'bill'}`; } break;
    case 'subscription': if (f.nextRenewal) { remindAt = at9(f.nextRenewal, 3); title = `${f.merchant || 'Subscription'} renews soon`; } break;
    case 'delivery': if (f.expectedDate) { remindAt = at9(f.expectedDate, 0); title = `Parcel${f.item ? `: ${f.item}` : ''} arrives today`; } break;
    case 'deadline': if (f.dueAt) { remindAt = before(f.dueAt, 86400_000); title = f.what || 'Deadline'; } break;
    default: break;
  }
  if (!remindAt) return null;
  // A time already past means "soon": an hour from now.
  if (remindAt.getTime() < new Date(now).getTime()) remindAt = new Date(new Date(now).getTime() + 3600_000);
  return {
    title,
    remindAt: remindAt.toISOString(),
    note: card.message?.subject ? `From "${card.message.subject}"` : null,
    messageId: card.messageId || null,
    threadId: card.message?.thread_key || null,
    source: { kind: 'card', cardId: card.id, cardKind: card.kind },
  };
}

/** The actions a card offers, each with the payload the frontend needs. */
export function cardActions(card, { tz = 'UTC', now = new Date() } = {}) {
  const out = [];
  const ics = cardIcs(card, { now });
  if (ics) out.push({ id: 'calendar', label: 'Add to calendar', ...ics });
  const reminder = reminderFor(card, { tz, now });
  if (reminder) out.push({ id: 'reminder', label: 'Set a reminder', reminder });
  if (card.kind === 'delivery' && card.fields?.trackingUrl) out.push({ id: 'track', label: 'Track parcel', url: card.fields.trackingUrl });
  if (card.kind === 'code' && card.fields?.code) out.push({ id: 'copy', label: 'Copy code', text: card.fields.code });
  return out;
}
