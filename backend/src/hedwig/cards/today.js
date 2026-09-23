// "Today, from your Records": the Brief's figures from cards — a parcel arriving today, a bill due
// this week, an event today or tomorrow, a code that just arrived, a trip leaving today or tomorrow.
import { query } from '../../services/db.js';
import { getConfig } from '../config.js';
import { validTimezone } from '../insights/time.js';
import { toCard } from './store.js';

const DAY = 86400_000;
const dayKey = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const weekday = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date(t));
const weekdayLong = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(new Date(t));
const clock = (t, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
// A bare date is a calendar day, not an instant: read it at noon UTC so every zone keeps the day.
const asInstant = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? `${v}T12:00:00Z` : v);

/** '1,240 NOK', '£89.99', '€1,600'. Pure. */
export function formatMoney(amount, currency) {
  if (amount == null) return null;
  const n = Number(amount);
  const whole = Number.isInteger(n);
  if (['GBP', 'EUR', 'USD'].includes(currency)) {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(n);
  }
  const num = new Intl.NumberFormat('en-GB', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(n);
  return currency ? `${num} ${currency}` : num;
}

/**
 * The figures, most urgent first. Pure.
 * @param {object[]} cards API-shaped cards (toCard)
 * @returns {{ kind, figure, title, caption, messageId, cardId, at }[]}
 */
export function todayFigures(cards, { now = Date.now(), tz = 'UTC', codeFreshMin = 15, billDueDays = 7 } = {}) {
  const zone = validTimezone(tz);
  const today = dayKey(now, zone);
  const tomorrow = dayKey(now + DAY, zone);
  const relDay = (t) => {
    const k = dayKey(t, zone);
    if (k === today) return 'Today';
    if (k === tomorrow) return 'Tomorrow';
    return weekday(t, zone);
  };
  const out = { code: [], delivery: [], event: [], travel: [], invoice: [] };
  for (const c of cards) {
    const f = c.fields || {};
    const base = { kind: c.kind, messageId: c.messageId, cardId: c.id };
    if (c.kind === 'code') {
      const at = c.message?.date ? new Date(c.message.date).getTime() : null;
      if (!at || now - at > codeFreshMin * 60_000 || now < at - 60_000) continue;
      const exp = f.expiresAt ? new Date(f.expiresAt).getTime() : null;
      if (exp && exp < now) continue;
      const mins = exp ? Math.max(1, Math.round((exp - now) / 60_000)) : null;
      out.code.push({ ...base, figure: f.code, title: f.service || 'Code', caption: mins ? `code, expires in ${mins} min` : 'code, just arrived', at: new Date(at).toISOString() });
    } else if (c.kind === 'delivery') {
      if (f.status === 'delivered') continue;
      const lastUpdate = Array.isArray(f.history) && f.history.length ? f.history[f.history.length - 1].at : c.updatedAt;
      const arrivingToday = f.expectedDate === today || (f.status === 'out_for_delivery' && lastUpdate && dayKey(lastUpdate, zone) === today);
      if (!arrivingToday) continue;
      const how = f.status === 'out_for_delivery' ? 'out for delivery' : f.expectedBy ? `by ${f.expectedBy}` : 'arriving today';
      out.delivery.push({ ...base, figure: 'Today', title: f.item || f.merchant || 'A parcel', caption: `${f.carrier ? `${f.carrier}, ` : ''}${how}`, at: f.expectedDate || lastUpdate || null });
    } else if (c.kind === 'event') {
      if (!f.start || f.status === 'cancelled') continue;
      const start = asInstant(f.start);
      const rel = relDay(start);
      if (rel !== 'Today' && rel !== 'Tomorrow') continue;
      if (!f.allDay && new Date(start).getTime() < now) continue;
      out.event.push({ ...base, figure: f.allDay ? 'All day' : clock(start, zone), title: f.title || 'Event', caption: `${rel}${f.location ? ` · ${f.location}` : ''}`, at: new Date(start).toISOString() });
    } else if (c.kind === 'travel') {
      const when = f.departAt || f.checkIn;
      if (!when) continue;
      const rel = relDay(asInstant(when));
      if (rel !== 'Today' && rel !== 'Tomorrow') continue;
      const route = f.from && f.to ? `${f.from} → ${f.to}` : (f.location || f.provider || '');
      const label = f.type === 'hotel' ? `${f.provider || 'Hotel'} check-in` : [f.flightNumber || f.provider, route].filter(Boolean).join(' ');
      out.travel.push({ ...base, figure: f.departAt ? clock(f.departAt, zone) : rel, title: label || 'Trip', caption: `${rel}${f.reference ? ` · ${f.reference}` : ''}`, at: new Date(asInstant(when)).toISOString() });
    } else if (c.kind === 'invoice') {
      if (!f.dueDate || f.status === 'paid') continue;
      const due = new Date(asInstant(f.dueDate)).getTime();
      const days = Math.round((new Date(`${f.dueDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / DAY);
      if (days < 0 || days > billDueDays) continue;
      const when = days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due ${weekdayLong(due, zone)}`;
      out.invoice.push({ ...base, figure: formatMoney(f.amount, f.currency) || 'Bill', title: f.issuer || 'Bill', caption: `${f.issuer ? `${f.issuer}, ` : ''}${when}`, at: f.dueDate });
    }
  }
  const byAt = (a, b) => String(a.at || '').localeCompare(String(b.at || ''));
  return [...out.code.sort(byAt).reverse(), ...out.delivery, ...out.event.sort(byAt), ...out.travel.sort(byAt), ...out.invoice.sort(byAt)];
}

const COLS = `c.id, c.kind, c.fields, c.sources, c.confidence, c.layer, c.message_id, c.message_ids, c.event_at, c.created_at, c.updated_at,
  c.dismissed_at, c.user_edited, c.prompt_id, c.prompt_version, c.model, c.ai_call_id,
  m.subject AS m_subject, m.from_name AS m_from_name, m.from_email AS m_from_email, m.date AS m_date, m.thread_key AS m_thread_key`;

/** GET /cards/today and the Brief. */
export async function cardsToday(userId, { now = Date.now(), tz = null } = {}) {
  const cfg = await getConfig(userId);
  const zone = validTimezone(tz || cfg['insights.timezone']);
  const { rows } = await query(
    `SELECT ${COLS} FROM hedwig_cards c LEFT JOIN messages m ON m.id = c.message_id
      WHERE c.user_id = $1 AND c.dismissed_at IS NULL AND (m.id IS NULL OR NOT m.is_deleted)
        AND ((c.kind = 'code' AND m.date > $2::timestamptz - make_interval(mins => $3::int))
          OR (c.kind = 'delivery' AND (c.updated_at > $2::timestamptz - INTERVAL '3 days' OR c.event_at BETWEEN $2::timestamptz - INTERVAL '1 day' AND $2::timestamptz + INTERVAL '2 days'))
          OR (c.kind IN ('event', 'travel') AND c.event_at BETWEEN $2::timestamptz - INTERVAL '1 day' AND $2::timestamptz + INTERVAL '3 days')
          OR (c.kind = 'invoice' AND c.event_at BETWEEN $2::timestamptz - INTERVAL '1 day' AND $2::timestamptz + make_interval(days => $4::int + 1)))
      ORDER BY c.event_at NULLS LAST LIMIT 200`,
    [userId, new Date(now), cfg['cards.codeFreshMin'], cfg['cards.billDueDays']],
  );
  return todayFigures(rows.map(toCard), { now, tz: zone, codeFreshMin: cfg['cards.codeFreshMin'], billDueDays: cfg['cards.billDueDays'] });
}
