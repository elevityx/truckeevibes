// AC-M1-43: When / Area / Free predicates in Pacific time. Interface assumptions: `now` is epoch ms (as in pacific.ts);
// `interval(e)` returns [startMs, endMs); all-day events carry startDate / endDate (endDate exclusive, as the feed/ICS gives it).
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { applyFilters, interval, matchesArea, matchesFree, matchesWhen } from './predicates';

const LA = 'America/Los_Angeles';
const T = (iso: string) => Date.parse(iso);

function ev(over: Partial<VibeEvent> & { id?: string } = {}): VibeEvent {
  return {
    id: 'e1', slug: 'e1', title: 'Event', summary: 'x', startsAt: '2026-11-06T02:00:00Z', endsAt: null, allDay: false,
    startDate: null, endDate: null, timeKnown: true, venue: null, address: null, town: 'Truckee', area: 'truckee',
    lat: 39.3, lng: -120.18, categories: [], priceKind: 'unknown', priceMin: null, priceMax: null, age: 'all_ages',
    featured: false, url: null, ticketUrl: null, sources: [], ...over,
  } as VibeEvent;
}
const at = (startsAt: string, endsAt: string | null = null) => ev({ startsAt, endsAt });

// Thu 2026-11-05 10:00 PST (UTC-8) = 18:00Z
const NOW = T('2026-11-05T18:00:00Z');

describe('interval', () => {
  it('is [start, end) and defaults a missing end to start + 3 h', () => {
    expect(interval(at('2026-11-06T02:00:00Z', '2026-11-06T04:00:00Z'))).toEqual([T('2026-11-06T02:00:00Z'), T('2026-11-06T04:00:00Z')]);
    expect(interval(at('2026-11-06T02:00:00Z'))).toEqual([T('2026-11-06T02:00:00Z'), T('2026-11-06T05:00:00Z')]);
  });
  it('all-day: [startOfDay(startDate), startOfDay(endDate)) in Pacific time (DST-aware)', () => {
    const a = ev({ allDay: true, startDate: '2026-11-07', endDate: '2026-11-08' });
    expect(interval(a)).toEqual([T('2026-11-07T08:00:00Z'), T('2026-11-08T08:00:00Z')]); // PST midnight
    const b = ev({ allDay: true, startDate: '2026-11-01', endDate: '2026-11-02' });
    const [s, e] = interval(b);
    expect(e - s).toBe(25 * 3_600_000); // the fall-back day
  });
});

describe('matchesWhen (AC-M1-43), now = Thu 2026-11-05 10:00 PST', () => {
  it('weekend: Fri 18:00 yes, Mon 00:30 no', () => {
    expect(matchesWhen(at('2026-11-07T02:00:00Z'), 'weekend', NOW, LA)).toBe(true); // Fri 18:00 PST
    expect(matchesWhen(at('2026-11-09T08:30:00Z'), 'weekend', NOW, LA)).toBe(false); // Mon 00:30 PST
  });
  it('weekend: Fri 14:00 (before 15:00) no, Fri 15:00 yes, Sun 23:30 yes, Mon 00:00 start no', () => {
    expect(matchesWhen(at('2026-11-06T22:00:00Z', '2026-11-06T22:30:00Z'), 'weekend', NOW, LA)).toBe(false); // Fri 14:00-14:30
    expect(matchesWhen(at('2026-11-06T23:00:00Z'), 'weekend', NOW, LA)).toBe(true); // Fri 15:00
    expect(matchesWhen(at('2026-11-09T07:30:00Z', '2026-11-09T07:45:00Z'), 'weekend', NOW, LA)).toBe(true); // Sun 23:30
    expect(matchesWhen(at('2026-11-09T08:00:00Z', '2026-11-09T09:00:00Z'), 'weekend', NOW, LA)).toBe(false); // Mon 00:00
  });
  it('weekend: an all-day Saturday event matches', () => {
    expect(matchesWhen(ev({ allDay: true, startDate: '2026-11-07', endDate: '2026-11-08', startsAt: '2026-11-07T08:00:00Z' }), 'weekend', NOW, LA)).toBe(true);
  });
  it('weekend on Sat/Sun is this weekend; Mon-Fri is the coming one', () => {
    const sun = T('2026-11-08T20:00:00Z'); // Sun noon PST
    expect(matchesWhen(at('2026-11-09T04:00:00Z'), 'weekend', sun, LA)).toBe(true); // Sun 20:00 PST
    expect(matchesWhen(at('2026-11-14T02:00:00Z'), 'weekend', sun, LA)).toBe(false); // next Fri 18:00
    const wed = T('2026-11-04T18:00:00Z');
    expect(matchesWhen(at('2026-11-08T20:00:00Z'), 'weekend', wed, LA)).toBe(true); // coming Sunday
    expect(matchesWhen(at('2026-11-01T20:00:00Z'), 'weekend', wed, LA)).toBe(false); // last Sunday
  });
  it('weekend on Friday: before 15:00 means that evening; after 15:00 still the current weekend', () => {
    const fri10 = T('2026-11-06T18:00:00Z');
    expect(matchesWhen(at('2026-11-07T02:00:00Z'), 'weekend', fri10, LA)).toBe(true); // Fri 18:00
    expect(matchesWhen(at('2026-11-06T20:00:00Z', '2026-11-06T21:00:00Z'), 'weekend', fri10, LA)).toBe(false); // Fri 12:00-13:00
    const fri16 = T('2026-11-07T00:00:00Z');
    expect(matchesWhen(at('2026-11-07T00:30:00Z', '2026-11-07T01:30:00Z'), 'weekend', fri16, LA)).toBe(true); // Fri 16:30
    expect(matchesWhen(at('2026-11-06T22:00:00Z', '2026-11-06T22:30:00Z'), 'weekend', fri16, LA)).toBe(false); // Fri 14:00
  });

  it('tonight = [today 17:00, tomorrow 04:00)', () => {
    expect(matchesWhen(at('2026-11-06T07:00:00Z', '2026-11-06T08:00:00Z'), 'tonight', NOW, LA)).toBe(true); // today 23:00
    expect(matchesWhen(at('2026-11-06T11:00:00Z', '2026-11-06T12:00:00Z'), 'tonight', NOW, LA)).toBe(true); // tomorrow 03:00
    expect(matchesWhen(at('2026-11-06T00:00:00Z', '2026-11-06T00:30:00Z'), 'tonight', NOW, LA)).toBe(false); // today 16:00-16:30
    expect(matchesWhen(at('2026-11-06T12:00:00Z', '2026-11-06T13:00:00Z'), 'tonight', NOW, LA)).toBe(false); // tomorrow 04:00
  });

  it('today overlaps [00:00, 24:00); an event running through midnight matches both days', () => {
    expect(matchesWhen(at('2026-11-06T07:00:00Z', '2026-11-06T09:00:00Z'), 'today', NOW, LA)).toBe(true); // 23:00 -> 01:00
    expect(matchesWhen(at('2026-11-06T07:00:00Z', '2026-11-06T09:00:00Z'), 'tomorrow', NOW, LA)).toBe(true);
    expect(matchesWhen(at('2026-11-06T08:00:00Z', '2026-11-06T09:00:00Z'), 'today', NOW, LA)).toBe(false); // starts at 00:00 tomorrow
    expect(matchesWhen(at('2026-11-05T07:00:00Z', '2026-11-05T07:59:00Z'), 'today', NOW, LA)).toBe(false); // ended before 00:00 PST
  });

  it('tomorrow = [tomorrow 00:00, +1 day)', () => {
    expect(matchesWhen(at('2026-11-06T20:00:00Z'), 'tomorrow', NOW, LA)).toBe(true);
    expect(matchesWhen(at('2026-11-07T08:00:00Z', '2026-11-07T09:00:00Z'), 'tomorrow', NOW, LA)).toBe(false); // Sat 00:00
  });

  it('7d = [now, start of day today + 7)', () => {
    expect(matchesWhen(at('2026-11-12T07:30:00Z'), '7d', NOW, LA)).toBe(true); // Wed Nov 11 23:30 PST (day 7)
    expect(matchesWhen(at('2026-11-12T08:00:00Z', '2026-11-12T09:00:00Z'), '7d', NOW, LA)).toBe(false); // Thu Nov 12 00:00
    expect(matchesWhen(at('2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z'), '7d', NOW, LA)).toBe(false); // ended before now
  });

  it('a date filter is that Pacific day', () => {
    const when = { date: '2026-11-10' };
    expect(matchesWhen(at('2026-11-10T08:00:00Z', '2026-11-10T09:00:00Z'), when, NOW, LA)).toBe(true); // 00:00 PST Nov 10
    expect(matchesWhen(at('2026-11-11T07:30:00Z', '2026-11-11T07:45:00Z'), when, NOW, LA)).toBe(true); // 23:30 PST Nov 10
    expect(matchesWhen(at('2026-11-11T08:00:00Z', '2026-11-11T09:00:00Z'), when, NOW, LA)).toBe(false);
  });

  it('null when matches everything', () => {
    expect(matchesWhen(at('2027-01-01T00:00:00Z'), null, NOW, LA)).toBe(true);
  });
});

describe('DST edges', () => {
  it('fall-back day: an event at 01:30 PDT matches today; 23:30 PST that day still does; 00:30 next day does not', () => {
    const now = T('2026-11-01T20:00:00Z'); // Sun noon PST
    expect(matchesWhen(at('2026-11-01T08:30:00Z', '2026-11-01T09:00:00Z'), 'today', now, LA)).toBe(true); // 01:30 PDT
    expect(matchesWhen(at('2026-11-02T07:30:00Z', '2026-11-02T07:45:00Z'), 'today', now, LA)).toBe(true); // 23:30 PST
    expect(matchesWhen(at('2026-11-02T08:30:00Z', '2026-11-02T09:00:00Z'), 'today', now, LA)).toBe(false); // Mon 00:30 PST
  });
  it('spring-forward day is 23 hours: 00:30 PDT next day is not today', () => {
    const now = T('2027-03-14T19:00:00Z'); // Sun noon PDT
    expect(matchesWhen(at('2027-03-15T07:30:00Z', '2027-03-15T07:45:00Z'), 'today', now, LA)).toBe(false);
    expect(matchesWhen(at('2027-03-15T06:30:00Z', '2027-03-15T06:45:00Z'), 'today', now, LA)).toBe(true); // 23:30 PDT
  });
});

describe('matchesArea / matchesFree', () => {
  it('empty areas = all (including events with no area); otherwise membership', () => {
    expect(matchesArea(ev({ area: null }), [])).toBe(true);
    expect(matchesArea(ev({ area: 'truckee' }), ['truckee', 'donner_lake'])).toBe(true);
    expect(matchesArea(ev({ area: 'reno_carson' }), ['truckee'])).toBe(false);
    expect(matchesArea(ev({ area: null }), ['truckee'])).toBe(false);
  });
  it('free keeps only price_kind free (not donation, not unknown)', () => {
    expect(matchesFree(ev({ priceKind: 'free' }))).toBe(true);
    for (const k of ['paid', 'donation', 'unknown'] as const) expect(matchesFree(ev({ priceKind: k }))).toBe(false);
  });
});

describe('applyFilters', () => {
  const list = [
    ev({ id: 'free-truckee', area: 'truckee', priceKind: 'free', startsAt: '2026-11-06T02:00:00Z' }),
    ev({ id: 'paid-truckee', area: 'truckee', priceKind: 'paid', startsAt: '2026-11-06T02:00:00Z' }),
    ev({ id: 'free-reno', area: 'reno_carson', priceKind: 'free', startsAt: '2026-11-06T02:00:00Z' }),
    ev({ id: 'ended', area: 'truckee', priceKind: 'free', startsAt: '2026-11-05T10:00:00Z', endsAt: '2026-11-05T12:00:00Z' }), // ended 6 h ago
    ev({ id: 'just-ended', area: 'truckee', priceKind: 'free', startsAt: '2026-11-05T16:00:00Z', endsAt: '2026-11-05T17:30:00Z' }), // ended 30 min ago
  ];
  const ids = (xs: VibeEvent[]) => xs.map((x) => x.id).sort();
  it('with no filters it only drops ended events (1 h grace, like list_events)', () => {
    expect(ids(applyFilters(list, { when: null, areas: [], free: false }, NOW, LA))).toEqual(['free-reno', 'free-truckee', 'just-ended', 'paid-truckee']);
  });
  it('combines When, Area and Free with AND', () => {
    expect(ids(applyFilters(list, { when: 'today', areas: ['truckee'], free: true }, NOW, LA))).toEqual(['free-truckee', 'just-ended']);
    expect(ids(applyFilters(list, { when: null, areas: ['reno_carson'], free: false }, NOW, LA))).toEqual(['free-reno']);
  });
  it('does not mutate its input', () => {
    const copy = [...list];
    applyFilters(list, { when: 'today', areas: [], free: true }, NOW, LA);
    expect(list).toEqual(copy);
  });
});
