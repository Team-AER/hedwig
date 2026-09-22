// Timezone arithmetic for per-user clock times (briefings, automations, day buckets) without a
// date library: Intl gives us the wall-clock parts of an instant in any IANA zone, and
// zonedToUtc inverts that, resolving DST gaps forward and DST overlaps to the first occurrence.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The zone if Intl knows it, else 'UTC'. User settings are free text, so never trust them. */
export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return 'UTC';
  try {
    formatter(tz.trim());
    return tz.trim();
  } catch {
    return 'UTC';
  }
}

/** Wall-clock parts of `date` in `tz`. weekday: 0 = Sunday. */
export function zonedParts(date, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const out = { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
  out.weekday = new Date(Date.UTC(out.year, out.month - 1, out.day)).getUTCDay();
  return out;
}

/** Offset of `tz` from UTC at `date`, in ms (positive east of Greenwich). */
export function tzOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads the given local time. A time skipped by a
 * spring-forward gap maps to the same wall time after the shift (02:30 → 03:30); a time that
 * occurs twice in an autumn overlap maps to its first occurrence.
 */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([-86400_000, 0, 86400_000].map((d) => tzOffsetMs(new Date(naive + d), tz)));
  const candidates = [...offsets].map((o) => naive - o).sort((a, b) => a - b);
  for (const c of candidates) {
    const p = zonedParts(new Date(c), tz);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return new Date(c);
  }
  return new Date(candidates[candidates.length - 1]);
}

/** Calendar date arithmetic on {year, month, day}. */
export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of `date` in `tz`. */
export function localDay(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The instant local midnight began on the day containing `date` in `tz`. */
export function startOfLocalDay(date, tz) {
  const p = zonedParts(date, tz);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, tz);
}

/** Parse 'HH:MM' (or 'H:MM'); null when malformed. */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Human date line for prompts: 'Wednesday 23 September 2026, 14:05 (Europe/London)'. */
export function describeNow(date, tz) {
  const long = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  return `${long} (${tz})`;
}

export function weekdayName(n) {
  return WEEKDAYS[n] || '';
}
