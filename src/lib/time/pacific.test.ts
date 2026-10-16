// Copied unchanged from truckeelights src/lib/time/pacific.test.ts (spec S1.11).
import { describe, expect, it } from 'vitest';
import { addDays, dateBadge, formatRange, formatTimes, groupEvents, localDate, startOfDay, toUtc, utcToLocal } from './pacific';

const LA = 'America/Los_Angeles';

describe('toUtc', () => {
  it('converts PDT and PST wall times', () => {
    expect(toUtc('2026-10-30', '16:00', LA)).toBe('2026-10-30T23:00:00.000Z'); // PDT, UTC-7
    expect(toUtc('2026-11-02', '18:00', LA)).toBe('2026-11-03T02:00:00.000Z'); // PST, UTC-8
    expect(toUtc('2026-10-31', '23:30', LA)).toBe('2026-11-01T06:30:00.000Z');
  });

  it('takes the earlier (PDT) instant in the Nov 1 fall-back hour', () => {
    expect(toUtc('2026-11-01', '01:30', LA)).toBe('2026-11-01T08:30:00.000Z');
    expect(toUtc('2026-11-01', '00:59', LA)).toBe('2026-11-01T07:59:00.000Z');
    expect(toUtc('2026-11-01', '02:00', LA)).toBe('2026-11-01T10:00:00.000Z'); // after the fold, PST
  });

  it('reports the spring-forward gap', () => {
    expect(toUtc('2026-03-08', '02:30', LA)).toBe('dst_gap');
    expect(toUtc('2026-03-08', '01:59', LA)).toBe('2026-03-08T09:59:00.000Z');
    expect(toUtc('2026-03-08', '03:00', LA)).toBe('2026-03-08T10:00:00.000Z');
  });

  it('does not depend on the device zone', () => {
    expect(toUtc('2026-10-30', '16:00', 'America/New_York')).toBe('2026-10-30T20:00:00.000Z');
  });

  it('rejects malformed input', () => {
    expect(() => toUtc('2026-02-30', '10:00', LA)).toThrow(RangeError);
    expect(() => toUtc('10/30/2026', '10:00', LA)).toThrow(RangeError);
    expect(() => toUtc('2026-10-30', '25:00', LA)).toThrow(RangeError);
  });
});

describe('formatting', () => {
  it('formats a same-meridiem range', () => {
    expect(formatRange('2026-10-30T23:00:00Z', '2026-10-31T01:00:00Z', LA)).toBe('Fri, Oct 30 · 4–6 pm');
  });
  it('formats a cross-meridiem range and minutes', () => {
    expect(formatRange('2026-10-17T18:00:00Z', '2026-10-17T22:00:00Z', LA)).toBe('Sat, Oct 17 · 11 am–3 pm');
    expect(formatTimes('2026-10-28T01:30:00Z', null, LA)).toBe('6:30 pm');
    expect(formatTimes('2026-10-17T19:00:00Z', '2026-10-17T20:00:00Z', LA)).toBe('12–1 pm');
  });
  it('formats an event that ends the next day', () => {
    expect(formatRange('2026-10-31T03:00:00Z', '2026-10-31T08:00:00Z', LA)).toBe('Fri, Oct 30 · 8 pm – Sat, Oct 31 · 1 am');
    expect(formatTimes('2026-10-31T03:00:00Z', '2026-10-31T08:00:00Z', LA)).toBe('8 pm–Sat 1 am');
  });
  it('formats a run of many days as dates plus a nightly window', () => {
    // Fri Oct 2 6 pm PDT to Sun Nov 1 10 pm PST
    expect(formatTimes('2026-10-03T01:00:00Z', '2026-11-02T06:00:00Z', LA)).toBe('Oct 2 – Nov 1 · nightly 6–10 pm');
    expect(formatRange('2026-10-03T01:00:00Z', '2026-11-02T06:00:00Z', LA)).toBe('Oct 2 – Nov 1 · nightly 6–10 pm');
    // starts at 12 am: just the last day
    expect(formatTimes('2026-10-02T07:00:00Z', '2026-11-02T08:00:00Z', LA)).toBe('Through Nov 1');
  });
  it('uses the nightly window when the end is two calendar days later', () => {
    expect(formatTimes('2026-10-31T03:00:00Z', '2026-11-02T09:00:00Z', LA)).toBe('Oct 30 – Nov 2 · nightly 8 pm–1 am');
  });
  it('reads an end at 12 am the next day as midnight', () => {
    expect(formatRange('2026-10-31T04:00:00Z', '2026-10-31T07:00:00Z', LA)).toBe('Fri, Oct 30 · 9 pm–midnight');
    expect(formatTimes('2026-10-31T04:00:00Z', '2026-10-31T07:00:00Z', LA)).toBe('9 pm–midnight');
  });
  it('a multi-day run ending at exactly 12 am counts the previous day as the last and reads midnight', () => {
    // Fri Oct 2 6 pm PDT to Mon Nov 2 12 am PST (DST ends Nov 1): the last night is Nov 1
    expect(formatTimes('2026-10-03T01:00:00Z', '2026-11-02T08:00:00Z', LA)).toBe('Oct 2 – Nov 1 · nightly 6 pm–midnight');
    expect(formatRange('2026-10-03T01:00:00Z', '2026-11-02T08:00:00Z', LA)).toBe('Oct 2 – Nov 1 · nightly 6 pm–midnight');
    // Sat Mar 13 2027 6 pm PST to Tue Mar 16 12 am PDT (DST starts Mar 14)
    expect(formatTimes('2027-03-14T02:00:00Z', '2027-03-16T07:00:00Z', LA)).toBe('Mar 13 – Mar 15 · nightly 6 pm–midnight');
    // midnight to midnight across the fall change, and a midnight start with a later end keeps the end clock
    expect(formatTimes('2026-10-02T07:00:00Z', '2026-11-02T08:00:00Z', LA)).toBe('Through Nov 1');
    expect(formatTimes('2026-10-02T07:00:00Z', '2026-11-02T06:00:00Z', LA)).toBe('Through Nov 1 · until 10 pm');
    expect(formatTimes('2026-10-03T01:00:00Z', '2026-10-05T07:00:00Z', LA)).not.toMatch(/12 am|Oct 5/);
  });
  it('formats across the DST change in local time', () => {
    // Sat Oct 31 10 pm PDT to Sun Nov 1 1:30 am PST (the second 1:30)
    expect(formatRange('2026-11-01T05:00:00Z', '2026-11-01T09:30:00Z', LA)).toBe('Sat, Oct 31 · 10 pm – Sun, Nov 1 · 1:30 am');
  });
  it('builds the pin badge', () => {
    expect(dateBadge('2026-10-30T23:00:00Z', LA)).toBe('OCT 30');
    expect(dateBadge('2026-10-31T06:30:00Z', LA)).toBe('OCT 30'); // 11:30 pm Pacific
  });
});

describe('day helpers', () => {
  it('finds the local day and its start', () => {
    expect(localDate(Date.parse('2026-10-31T06:59:00Z'), LA)).toBe('2026-10-30');
    expect(localDate(Date.parse('2026-10-31T07:00:00Z'), LA)).toBe('2026-10-31');
    expect(new Date(startOfDay('2026-11-01', LA)).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(startOfDay('2026-11-02', LA)).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});

describe('groupEvents', () => {
  const ev = (id: string, startsAt: string, endsAt: string | null = null) => ({ id, startsAt, endsAt });

  it('splits Today / This week / Later at Pacific midnight', () => {
    const now = Date.parse('2026-10-30T06:30:00Z'); // Thu Oct 29, 11:30 pm Pacific
    const g = groupEvents(
      [
        ev('later', '2026-11-05T17:00:00Z'), // Thu Nov 5: day 7, Later
        ev('tonight', '2026-10-30T06:45:00Z'), // Thu 11:45 pm
        ev('fri', '2026-10-30T23:00:00Z', '2026-10-31T01:00:00Z'), // Fri 4 pm
        ev('wed', '2026-11-04T20:00:00Z'), // Wed Nov 4: day 6, This week
      ],
      now,
      LA,
    );
    expect(g.today.map((e) => e.id)).toEqual(['tonight']);
    expect(g.week.map((e) => e.id)).toEqual(['fri', 'wed']);
    expect(g.later.map((e) => e.id)).toEqual(['later']);

    // 31 minutes later it is Friday in Truckee.
    const g2 = groupEvents([ev('fri', '2026-10-30T23:00:00Z', '2026-10-31T01:00:00Z')], now + 31 * 60_000, LA);
    expect(g2.today.map((e) => e.id)).toEqual(['fri']);
  });

  it('keeps an in-progress event in Today until an hour after it ends', () => {
    const started = ev('multi', '2026-10-28T17:00:00Z', '2026-10-31T03:00:00Z'); // Wed 10 am to Fri 8 pm
    const now = Date.parse('2026-10-30T18:00:00Z'); // Fri 11 am
    expect(groupEvents([started], now, LA).today).toHaveLength(1);
    expect(groupEvents([started], Date.parse('2026-10-31T03:59:00Z'), LA).today).toHaveLength(1);
    expect(groupEvents([started], Date.parse('2026-10-31T04:01:00Z'), LA).today).toHaveLength(0);
  });

  it('treats a missing end as 3 hours', () => {
    const e = ev('x', '2026-10-30T23:00:00Z');
    expect(groupEvents([e], Date.parse('2026-10-31T02:59:00Z'), LA).today).toHaveLength(1);
    expect(groupEvents([e], Date.parse('2026-10-31T03:01:00Z'), LA).today).toHaveLength(0);
  });

  it('sorts each group by start', () => {
    const now = Date.parse('2026-10-20T17:00:00Z');
    const g = groupEvents([ev('b', '2026-12-02T01:00:00Z'), ev('a', '2026-12-01T01:00:00Z')], now, LA);
    expect(g.later.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('utcToLocal', () => {
  it('gives Pacific date and time on both sides of the Nov 1 change', () => {
    expect(utcToLocal('2026-10-31T19:00:00.000Z', 'America/Los_Angeles')).toEqual({ date: '2026-10-31', time: '12:00' });
    expect(utcToLocal('2026-11-02T20:00:00.000Z', 'America/Los_Angeles')).toEqual({ date: '2026-11-02', time: '12:00' });
  });
  it('rolls the date back across UTC midnight', () => {
    expect(utcToLocal('2026-11-01T03:30:00.000Z', 'America/Los_Angeles')).toEqual({ date: '2026-10-31', time: '20:30' });
  });
});

describe('R1b helpers dayLabel and longDay', () => {
  it('dayLabel is formatDay without the comma; longDay spells the weekday', async () => {
    const { dayLabel, longDay } = await import('./pacific');
    expect(dayLabel('2026-10-19T01:00:00Z', LA)).toBe('Sun Oct 18');
    expect(longDay('2026-10-19T01:00:00Z', LA)).toBe('Sunday, Oct 18');
    expect(longDay('2026-10-15T15:00:00Z', LA)).toBe('Thursday, Oct 15');
  });
});
