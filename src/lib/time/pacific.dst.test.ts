// S1.11 list grouping by Pacific day across both DST changes (the copied Lights test covers October only).
import { describe, expect, it } from 'vitest';
import { groupEvents } from './pacific';

const LA = 'America/Los_Angeles';
const ev = (id: string, startsAt: string, endsAt: string | null = null) => ({ id, startsAt, endsAt });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('groupEvents on the fall-back day (Sun 2026-11-01, 25 hours)', () => {
  const now = Date.parse('2026-11-01T20:00:00Z'); // noon PST
  it('keeps 23:30 PST in Today and 00:30 the next day out of it', () => {
    const g = groupEvents(
      [
        ev('late', '2026-11-02T07:30:00Z'), // Sun 23:30 PST: still today (a naive +24 h end would drop it)
        ev('next', '2026-11-02T08:30:00Z'), // Mon 00:30 PST
        ev('dup-hour', '2026-11-01T09:30:00Z', '2026-11-01T22:00:00Z'), // 01:30 PST (the repeated hour), runs on
      ],
      now,
      LA,
    );
    expect(ids(g.today)).toEqual(['dup-hour', 'late']);
    expect(ids(g.week)).toEqual(['next']);
  });
  it('puts the day-7 boundary at Pacific midnight (PST after the change)', () => {
    const g = groupEvents(
      [ev('d6', '2026-11-08T07:59:00Z'), ev('d7', '2026-11-08T08:00:00Z')], // Sat 23:59 vs Sun 00:00 PST
      now,
      LA,
    );
    expect(ids(g.week)).toEqual(['d6']);
    expect(ids(g.later)).toEqual(['d7']);
  });
});

describe('groupEvents on the spring-forward day (Sun 2027-03-14, 23 hours)', () => {
  const now = Date.parse('2027-03-14T19:00:00Z'); // noon PDT
  it('ends Today at 24:00 PDT, not 24 h after 00:00 PST', () => {
    const g = groupEvents(
      [
        ev('late', '2027-03-15T06:59:00Z'), // Sun 23:59 PDT
        ev('next', '2027-03-15T07:30:00Z'), // Mon 00:30 PDT (a naive +24 h end would call this today)
      ],
      now,
      LA,
    );
    expect(ids(g.today)).toEqual(['late']);
    expect(ids(g.week)).toEqual(['next']);
  });
  it('an event just after the 02:00 gap (03:30 PDT) is placed by its instant', () => {
    const g = groupEvents([ev('after-gap', '2027-03-14T10:30:00Z')], Date.parse('2027-03-14T08:00:00Z'), LA); // 03:30 PDT; now 00:00 PST
    expect(ids(g.today)).toEqual(['after-gap']);
  });
});
