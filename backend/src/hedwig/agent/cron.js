// Automation schedules, in the user's timezone:
//   daily@HH:MM        every day at HH:MM
//   weekdays@HH:MM     Monday to Friday at HH:MM
//   weekly@D@HH:MM     on weekday D (0 = Sunday … 6 = Saturday) at HH:MM
//   every@Nm / every@Nh  every N minutes (5 … 1440) or hours (1 … 168)
// Clock times follow the wall clock across DST changes: a time skipped by a spring-forward gap
// runs just after the gap, and a time that happens twice runs once, the first time.
import { zonedParts, zonedToUtc, addDays, parseClock } from '../insights/time.js';

export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 1440;
export const MAX_EVERY_HOURS = 168;

/** Parse a schedule string. Returns null when it is not valid. */
export function parseSchedule(input) {
  const s = String(input ?? '').trim().toLowerCase();
  let m = /^(daily|weekdays)@(\d{1,2}:\d{2})$/.exec(s);
  if (m) {
    const clock = parseClock(m[2]);
    return clock ? { kind: m[1], ...clock } : null;
  }
  m = /^weekly@([0-6])@(\d{1,2}:\d{2})$/.exec(s);
  if (m) {
    const clock = parseClock(m[2]);
    return clock ? { kind: 'weekly', weekday: Number(m[1]), ...clock } : null;
  }
  m = /^every@(\d{1,4})([mh])$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const minutes = m[2] === 'h' ? n * 60 : n;
    if (m[2] === 'm' && (n < MIN_EVERY_MINUTES || n > MAX_EVERY_MINUTES)) return null;
    if (m[2] === 'h' && (n < 1 || n > MAX_EVERY_HOURS)) return null;
    return { kind: 'every', minutes };
  }
  return null;
}

/** Canonical spelling of a valid schedule (so '7:05' is stored as '07:05'). */
export function formatSchedule(p) {
  const clock = (x) => `${String(x.hour).padStart(2, '0')}:${String(x.minute).padStart(2, '0')}`;
  switch (p.kind) {
    case 'daily': return `daily@${clock(p)}`;
    case 'weekdays': return `weekdays@${clock(p)}`;
    case 'weekly': return `weekly@${p.weekday}@${clock(p)}`;
    default: return p.minutes % 60 === 0 && p.minutes >= 60 ? `every@${p.minutes / 60}h` : `every@${p.minutes}m`;
  }
}

function dayMatches(p, weekday) {
  if (p.kind === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (p.kind === 'weekly') return weekday === p.weekday;
  return true;
}

/**
 * The first run strictly after `from`.
 * @param {string|object} schedule  a schedule string or parseSchedule() result
 * @param {string} tz               IANA timezone
 * @param {Date} [from]
 * @returns {Date}
 */
export function nextRunAt(schedule, tz, from = new Date()) {
  const p = typeof schedule === 'string' ? parseSchedule(schedule) : schedule;
  if (!p) throw new Error(`invalid schedule: ${schedule}`);
  if (p.kind === 'every') return new Date(from.getTime() + p.minutes * 60_000);
  const today = zonedParts(from, tz);
  for (let offset = 0; offset <= 8; offset++) {
    const d = addDays(today, offset);
    const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
    if (!dayMatches(p, weekday)) continue;
    const at = zonedToUtc({ ...d, hour: p.hour, minute: p.minute }, tz);
    if (at.getTime() > from.getTime()) return at;
  }
  throw new Error(`no run found for ${formatSchedule(p)} in ${tz}`);
}
