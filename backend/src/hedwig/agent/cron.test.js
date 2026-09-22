import { describe, it, expect } from 'vitest';
import { parseSchedule, formatSchedule, nextRunAt } from './cron.js';
import { zonedParts, zonedToUtc, startOfLocalDay, localDay, validTimezone } from '../insights/time.js';

const iso = (d) => d.toISOString();

describe('parseSchedule', () => {
  it('accepts every documented format', () => {
    expect(parseSchedule('daily@07:30')).toEqual({ kind: 'daily', hour: 7, minute: 30 });
    expect(parseSchedule('weekdays@7:05')).toEqual({ kind: 'weekdays', hour: 7, minute: 5 });
    expect(parseSchedule('weekly@5@16:00')).toEqual({ kind: 'weekly', weekday: 5, hour: 16, minute: 0 });
    expect(parseSchedule('every@90m')).toEqual({ kind: 'every', minutes: 90 });
    expect(parseSchedule('every@2h')).toEqual({ kind: 'every', minutes: 120 });
    expect(parseSchedule(' Daily@23:59 ')).toEqual({ kind: 'daily', hour: 23, minute: 59 });
  });

  it('rejects malformed or out-of-range schedules', () => {
    for (const bad of ['', 'hourly', 'daily@24:00', 'daily@07:60', 'weekly@7@10:00', 'weekly@1', 'every@1m', 'every@4m',
      'every@1441m', 'every@0h', 'every@169h', 'daily@0730', null, undefined, 42]) {
      expect(parseSchedule(bad), String(bad)).toBeNull();
    }
  });

  it('formats a canonical spelling', () => {
    expect(formatSchedule(parseSchedule('daily@7:05'))).toBe('daily@07:05');
    expect(formatSchedule(parseSchedule('every@120m'))).toBe('every@2h');
    expect(formatSchedule(parseSchedule('every@45m'))).toBe('every@45m');
    expect(formatSchedule(parseSchedule('weekly@0@9:00'))).toBe('weekly@0@09:00');
  });
});

describe('nextRunAt', () => {
  it('runs later today when the time has not passed, else tomorrow', () => {
    expect(iso(nextRunAt('daily@07:30', 'UTC', new Date('2026-09-23T06:00:00Z')))).toBe('2026-09-23T07:30:00.000Z');
    expect(iso(nextRunAt('daily@07:30', 'UTC', new Date('2026-09-23T07:30:00Z')))).toBe('2026-09-24T07:30:00.000Z');
  });

  it('skips the weekend for weekdays@', () => {
    // 2026-09-25 is a Friday.
    expect(iso(nextRunAt('weekdays@07:30', 'UTC', new Date('2026-09-25T08:00:00Z')))).toBe('2026-09-28T07:30:00.000Z');
  });

  it('honours the timezone for weekly@', () => {
    // Friday 16:00 in India (UTC+05:30).
    expect(iso(nextRunAt('weekly@5@16:00', 'Asia/Kolkata', new Date('2026-09-23T00:00:00Z')))).toBe('2026-09-25T10:30:00.000Z');
    // Sunday 09:00 in Los Angeles from a Saturday evening there (already Sunday in UTC).
    expect(iso(nextRunAt('weekly@0@09:00', 'America/Los_Angeles', new Date('2026-09-27T03:00:00Z')))).toBe('2026-09-27T16:00:00.000Z');
  });

  it('keeps wall-clock time across a DST change', () => {
    // London moves to BST on 2026-03-29: 07:00 local is 07:00Z the day before and 06:00Z after.
    expect(iso(nextRunAt('daily@07:00', 'Europe/London', new Date('2026-03-27T12:00:00Z')))).toBe('2026-03-28T07:00:00.000Z');
    expect(iso(nextRunAt('daily@07:00', 'Europe/London', new Date('2026-03-28T12:00:00Z')))).toBe('2026-03-29T06:00:00.000Z');
    expect(iso(nextRunAt('daily@07:00', 'Europe/London', new Date('2026-10-24T12:00:00Z')))).toBe('2026-10-25T07:00:00.000Z');
  });

  it('runs a time skipped by spring-forward just after the gap', () => {
    // New York skips 02:00-03:00 on 2026-03-08; 02:30 runs at 03:30 EDT.
    expect(iso(nextRunAt('daily@02:30', 'America/New_York', new Date('2026-03-07T12:00:00Z')))).toBe('2026-03-08T07:30:00.000Z');
    // London skips 01:00-02:00 on 2026-03-29.
    expect(iso(nextRunAt('daily@01:30', 'Europe/London', new Date('2026-03-28T23:00:00Z')))).toBe('2026-03-29T01:30:00.000Z');
  });

  it('runs a time repeated by fall-back once, at its first occurrence', () => {
    // New York repeats 01:00-02:00 on 2026-11-01: 01:30 EDT is 05:30Z, 01:30 EST would be 06:30Z.
    const first = nextRunAt('daily@01:30', 'America/New_York', new Date('2026-10-31T12:00:00Z'));
    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(nextRunAt('daily@01:30', 'America/New_York', first))).toBe('2026-11-02T06:30:00.000Z');
  });

  it('adds the interval for every@', () => {
    const from = new Date('2026-09-23T10:00:00Z');
    expect(iso(nextRunAt('every@45m', 'Europe/Paris', from))).toBe('2026-09-23T10:45:00.000Z');
    expect(iso(nextRunAt('every@3h', 'UTC', from))).toBe('2026-09-23T13:00:00.000Z');
  });

  it('throws on an invalid schedule', () => {
    expect(() => nextRunAt('sometimes', 'UTC')).toThrow(/invalid schedule/);
  });
});

describe('timezone helpers', () => {
  it('reads wall-clock parts in a zone', () => {
    expect(zonedParts(new Date('2026-09-23T23:30:00Z'), 'Asia/Tokyo')).toMatchObject({ year: 2026, month: 9, day: 24, hour: 8, minute: 30, weekday: 4 });
  });

  it('finds local midnight across DST', () => {
    expect(iso(startOfLocalDay(new Date('2026-03-29T12:00:00Z'), 'Europe/London'))).toBe('2026-03-29T00:00:00.000Z');
    expect(iso(startOfLocalDay(new Date('2026-03-30T12:00:00Z'), 'Europe/London'))).toBe('2026-03-29T23:00:00.000Z');
    expect(localDay(new Date('2026-09-23T23:30:00Z'), 'America/New_York')).toBe('2026-09-23');
  });

  it('round-trips local times', () => {
    const at = zonedToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 15 }, 'Australia/Sydney');
    expect(iso(at)).toBe('2026-06-30T23:15:00.000Z');
  });

  it('falls back to UTC for unknown zones', () => {
    expect(validTimezone('Mars/Olympus_Mons')).toBe('UTC');
    expect(validTimezone('')).toBe('UTC');
    expect(validTimezone('Europe/Berlin')).toBe('Europe/Berlin');
  });
});
