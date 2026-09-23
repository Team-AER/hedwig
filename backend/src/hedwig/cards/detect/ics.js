// Calendar parts (.ics / text/calendar): one event card per VEVENT. Line unfolding and escaping follow
// RFC 5545 as upstream's messageParser does; the human-readable source line is upstream's own
// rendering of the invite (renderCalendarInvite), so the card cites what the reader sees.
import { renderCalendarInvite } from '../../../services/messageParser.js';
import { zonedToUtc, validTimezone } from '../../insights/time.js';

function unfold(raw) {
  const lines = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

function parseLine(line) {
  let inQuote = false;
  const segments = [];
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (inQuote || (c !== ';' && c !== ':')) continue;
    segments.push(line.slice(from, i));
    from = i + 1;
    if (c === ':') {
      const [name, ...paramParts] = segments;
      const params = {};
      for (const p of paramParts) {
        const eq = p.indexOf('=');
        if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
      }
      return { name: name.trim().toUpperCase(), params, value: line.slice(from) };
    }
  }
  return null;
}

// Exchange writes Windows zone names; the common ones, mapped to IANA.
const WINDOWS_ZONES = {
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Helsinki', 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles', 'India Standard Time': 'Asia/Kolkata',
  'Tokyo Standard Time': 'Asia/Tokyo', 'China Standard Time': 'Asia/Shanghai', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'Singapore Standard Time': 'Asia/Singapore', 'UTC': 'UTC',
};

const unescape = (v) => String(v || '').replace(/\\([nN\\;,])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c)).trim();

/**
 * An ICS date-time → ISO. Date-only values are all-day (YYYY-MM-DD). UTC ('Z') is exact; a TZID the
 * runtime knows is honoured; floating times and unknown zones use `fallbackTz`.
 */
export function icsDate(value, params = {}, fallbackTz = 'UTC') {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value || '').trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, , z] = m;
  if (hh === undefined || params.VALUE === 'DATE') return { iso: `${y}-${mo}-${d}`, allDay: true };
  if (z) return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm)).toISOString(), allDay: false };
  const tzid = String(params.TZID || '').replace(/^\//, '').trim();
  const mapped = WINDOWS_ZONES[tzid.replace(/^\(UTC[^)]*\)\s*/, '')] || tzid;
  const tz = validTimezone(mapped) !== 'UTC' || /^(utc|gmt|etc\/utc)$/i.test(mapped) ? validTimezone(mapped) : validTimezone(fallbackTz);
  return { iso: zonedToUtc({ year: +y, month: +mo, day: +d, hour: +hh, minute: +mm }, tz).toISOString(), allDay: false };
}

/** Every VEVENT in an iCalendar text, with its METHOD. Pure. */
export function parseIcs(text, { tz = 'UTC' } = {}) {
  if (!/BEGIN:VCALENDAR/i.test(text || '')) return [];
  let method = '';
  const events = [];
  let cur = null;
  let nested = 0;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' || p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      if (comp === 'VEVENT') {
        if (p.name === 'BEGIN') { cur = {}; nested = 0; } else if (cur) { events.push(cur); cur = null; }
      } else if (cur) nested = Math.max(0, nested + (p.name === 'BEGIN' ? 1 : -1));
      continue;
    }
    if (!cur) { if (p.name === 'METHOD' && !method) method = p.value.trim().toUpperCase(); continue; }
    if (nested > 0 || p.name in cur) continue;
    cur[p.name] = p;
  }
  return events.map((e) => {
    const start = icsDate(e.DTSTART?.value, e.DTSTART?.params, tz);
    let end = icsDate(e.DTEND?.value, e.DTEND?.params, tz);
    if (start?.allDay && end?.allDay) {
      // A date-only DTEND is exclusive: the event ends the day before.
      const d = new Date(`${end.iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      end = { iso: d.toISOString().slice(0, 10), allDay: true };
    }
    const organizer = e.ORGANIZER ? (e.ORGANIZER.params.CN ? unescape(e.ORGANIZER.params.CN) : e.ORGANIZER.value.replace(/^mailto:/i, '')) : null;
    return {
      method: method || null,
      uid: e.UID ? e.UID.value.trim() : null,
      sequence: Number(e.SEQUENCE?.value) || 0,
      status: e.STATUS ? e.STATUS.value.trim().toLowerCase() : (method === 'CANCEL' ? 'cancelled' : null),
      title: unescape(e.SUMMARY?.value) || null,
      location: unescape(e.LOCATION?.value) || null,
      organizer,
      start: start?.iso || null,
      end: end?.iso || null,
      allDay: Boolean(start?.allDay),
      raw: e,
    };
  });
}

/**
 * Event cards from calendar parts.
 * @param {{ id: string }} row
 * @param {{ text: string, filename?: string }[]} parts raw calendar texts (attachments or the body)
 */
export function detectIcs(row, parts, { tz = 'UTC' } = {}) {
  const out = [];
  for (const part of parts || []) {
    const events = parseIcs(part.text, { tz });
    if (!events.length) continue;
    const rendered = renderCalendarInvite(part.text)?.text?.split('\n').filter(Boolean) || [];
    const line = (prefix) => rendered.find((l) => l.startsWith(prefix)) || null;
    for (const ev of events) {
      if (!ev.start && !ev.title) continue;
      const fields = {
        title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, location: ev.location, organizer: ev.organizer,
        uid: ev.uid, method: ev.method ? ev.method.toLowerCase() : null, status: ev.status,
      };
      const quoteFor = {
        title: ev.raw.SUMMARY ? `SUMMARY:${ev.raw.SUMMARY.value}` : null,
        start: line('When:') || (ev.raw.DTSTART ? `DTSTART:${ev.raw.DTSTART.value}` : null),
        end: line('When:') || (ev.raw.DTEND ? `DTEND:${ev.raw.DTEND.value}` : null),
        allDay: ev.raw.DTSTART ? `DTSTART:${ev.raw.DTSTART.value}` : null,
        location: line('Where:') || (ev.raw.LOCATION ? `LOCATION:${ev.raw.LOCATION.value}` : null),
        organizer: line('Organizer:') || (ev.raw.ORGANIZER ? `ORGANIZER:${ev.raw.ORGANIZER.value}` : null),
        uid: ev.uid ? `UID:${ev.uid}` : null,
        method: ev.method ? `METHOD:${ev.method}` : null,
        status: ev.raw.STATUS ? `STATUS:${ev.raw.STATUS.value}` : (ev.method === 'CANCEL' ? 'METHOD:CANCEL' : null),
      };
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      const sources = {};
      for (const k of Object.keys(clean)) sources[k] = { messageId: row.id, quote: quoteFor[k] || `${k}: ${clean[k]}`, attachment: part.filename || null, via: 'ics' };
      out.push({ kind: 'event', messageId: row.id, fields: clean, sources, confidence: 0.98, layer: 'ics', sequence: ev.sequence });
    }
  }
  return out;
}
