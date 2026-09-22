// Pure statistics for insights. No I/O, so the maths is unit-tested directly.
import { zonedParts, addDays } from './time.js';

const HOUR = 3600_000;

/** Linear-interpolated percentile (p in 0..1) of an unsorted list; null when empty. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = (xs.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

export const median = (values) => percentile(values, 0.5);

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * Reply latencies from message rows. A sample is taken each time the user writes into a thread in
 * which someone else wrote since the user's previous message: the latency runs from the earliest
 * of those unanswered messages to the user's message, i.e. how long the other side waited.
 *
 * @param {{ thread: string, date: Date|string, outgoing: boolean }[]} rows  any order
 * @returns {{ at: Date, hours: number }[]}  one per reply, `at` = when the user replied
 */
export function responseSamples(rows) {
  const threads = new Map();
  for (const r of rows) {
    if (!r.thread || !r.date) continue;
    const t = new Date(r.date).getTime();
    if (!Number.isFinite(t)) continue;
    if (!threads.has(r.thread)) threads.set(r.thread, []);
    threads.get(r.thread).push({ t, outgoing: Boolean(r.outgoing) });
  }
  const samples = [];
  for (const msgs of threads.values()) {
    // Outgoing sorts first on a tie so a reply is never measured against its own timestamp.
    msgs.sort((a, b) => a.t - b.t || (a.outgoing === b.outgoing ? 0 : a.outgoing ? -1 : 1));
    let waitingSince = null;
    for (const m of msgs) {
      if (!m.outgoing) {
        if (waitingSince === null) waitingSince = m.t;
      } else if (waitingSince !== null) {
        samples.push({ at: new Date(m.t), hours: (m.t - waitingSince) / HOUR });
        waitingSince = null;
      }
    }
  }
  return samples.sort((a, b) => a.at - b.at);
}

/** 'YYYY-MM-DD' of the Monday starting the local week containing `date`. */
export function weekStart(date, tz) {
  const p = zonedParts(date, tz);
  const back = (p.weekday + 6) % 7;
  const d = addDays(p, -back);
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/**
 * Summarise reply latencies: overall median and p90, plus a weekly median series (weeks start on
 * Monday in the user's timezone, only weeks with at least one reply).
 */
export function summarizeResponseTimes(samples, tz = 'UTC') {
  const hours = samples.map((s) => s.hours);
  const byWeek = new Map();
  for (const s of samples) {
    const w = weekStart(s.at, tz);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(s.hours);
  }
  return {
    median_hours: round1(median(hours)),
    p90_hours: round1(percentile(hours, 0.9)),
    samples: samples.length,
    weekly: [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([week, hs]) => ({ week, median_hours: round1(median(hs)), replies: hs.length })),
  };
}

/**
 * Compare reply latency in the last `windowDays` against the window before it. Returns null unless
 * both windows have at least `minSamples` replies.
 */
export function responseTrend(samples, { now = new Date(), windowDays = 14, minSamples = 3 } = {}) {
  const end = now.getTime();
  const split = end - windowDays * 86400_000;
  const start = split - windowDays * 86400_000;
  const recent = samples.filter((s) => s.at.getTime() > split && s.at.getTime() <= end).map((s) => s.hours);
  const before = samples.filter((s) => s.at.getTime() > start && s.at.getTime() <= split).map((s) => s.hours);
  if (recent.length < minSamples || before.length < minSamples) return null;
  const r = median(recent);
  const b = median(before);
  return { recent_hours: round1(r), previous_hours: round1(b), ratio: b > 0 ? r / b : null, recent_n: recent.length, previous_n: before.length };
}

export const _round1 = round1;
