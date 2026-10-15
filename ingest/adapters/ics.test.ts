// AC-M1-12: the 13 required ICS fixtures (+ A2 eventsmanager shape tested in icsEventsmanager.test.ts).
// Contract assumed: parseIcs(text, { now: Date, tz?: string, eventUrl?: string }) -> { items, dropped: Record<reason, n>, truncated: number }.
import { describe, expect, it } from 'vitest';
import { parseIcs } from './ics';
import { DESC_SENTINEL, fixture, SOURCE_EVENT_KEYS } from '../testing/fakes';

const NOW = new Date('2026-10-15T12:00:00Z');
const run = (name: string, now = NOW, extra: Record<string, unknown> = {}) => parseIcs(fixture(`ics/${name}.ics`), { now, ...extra });

describe('recurrence', () => {
  it('rrule_weekly: one item per week inside now-1d .. now+120d, keys UID#YYYYMMDDTHHMMSSZ', () => {
    const { items } = run('rrule_weekly');
    expect(items).toHaveLength(17);
    expect(items[0].externalKey).toBe('rrule-weekly@example.test#20261016T180000Z');
    expect(items[16].externalKey).toBe('rrule-weekly@example.test#20270205T180000Z');
    expect(items[0].startsAt).toBe('2026-10-16T18:00:00Z');
    expect(items[0].endsAt).toBe('2026-10-16T20:00:00Z');
    expect(items.every((i) => i.seriesUid === 'rrule-weekly@example.test')).toBe(true);
    expect(items[0].venueName).toBe('Example Hall');
    expect(items[0].address).toContain('100 Sample Way');
    expect(items[0].timeKnown).toBe(true);
    expect(items[0].allDay).toBe(false);
  });
  it('exdate: the excluded instance is absent', () => {
    const keys = run('exdate').items.map((i) => i.externalKey);
    expect(keys).toEqual(['exdate@example.test#20261016T180000Z', 'exdate@example.test#20261030T180000Z', 'exdate@example.test#20261106T180000Z']);
  });
  it('rdate: the extra date is present', () => {
    const keys = run('rdate').items.map((i) => i.externalKey);
    expect(keys).toContain('rdate@example.test#20261105T180000Z');
    expect(keys).toHaveLength(3);
  });
  it('override_moved: same key as the original slot, the new start time', () => {
    const { items } = run('override_moved');
    expect(items).toHaveLength(3);
    const moved = items.find((i) => i.externalKey === 'moved@example.test#20261023T180000Z')!;
    expect(moved.startsAt).toBe('2026-10-23T20:00:00Z');
    expect(items.filter((i) => i.startsAt === '2026-10-23T18:00:00Z')).toHaveLength(0);
  });
  it('override_cancelled: same key, cancelled: true; the other instances are not cancelled', () => {
    const { items } = run('override_cancelled');
    expect(items).toHaveLength(3);
    const gone = items.find((i) => i.externalKey === 'cancel@example.test#20261023T180000Z')!;
    expect(gone.cancelled).toBe(true);
    expect(items.filter((i) => i.cancelled).length).toBe(1);
  });
  it('truncation_70: exactly 60 items, and the truncation is reported as a count, not an error', () => {
    const r = run('truncation_70');
    expect(r.items).toHaveLength(60);
    expect(r.truncated).toBeGreaterThan(0);
    expect(r.dropped).toEqual({});
  });
  it('a single non-recurring VEVENT has key UID# and no seriesUid', () => {
    const { items } = run('utc_z');
    expect(items[0].externalKey).toBe('utcz@example.test#');
    expect(items[0].seriesUid).toBeUndefined();
  });
  it('cancelled_single: cancelled true', () => {
    const { items } = run('cancelled_single');
    expect(items).toHaveLength(1);
    expect(items[0].cancelled).toBe(true);
    expect(items[0].externalKey).toBe('cancelled-single@example.test#');
  });
});

describe('time zones, all-day, DST', () => {
  it('allday_exclusive_end: allDay, startDate 2026-10-31, endDate 2026-11-01, startsAt local midnight in UTC', () => {
    const [i] = run('allday_exclusive_end').items;
    expect(i.allDay).toBe(true);
    expect(i.timeKnown).toBe(false);
    expect(i.startDate).toBe('2026-10-31');
    expect(i.endDate).toBe('2026-11-01');
    expect(i.startsAt).toBe('2026-10-31T07:00:00Z');
  });
  it('floating times use the default zone (America/Los_Angeles): PDT and PST', () => {
    const { items } = run('floating');
    expect(items.map((i) => i.startsAt).sort()).toEqual(['2026-10-18T02:00:00Z', '2026-12-06T03:00:00Z']);
    expect(items.every((i) => i.tz === 'America/Los_Angeles')).toBe(true);
  });
  it('config.tz overrides the floating zone', () => {
    const { items } = run('floating', NOW, { tz: 'America/Denver' });
    expect(items.map((i) => i.startsAt).sort()).toEqual(['2026-10-18T01:00:00Z', '2026-12-06T02:00:00Z']);
  });
  it('utc_z: DTSTART with Z stays UTC', () => {
    expect(run('utc_z').items[0].startsAt).toBe('2026-10-17T18:00:00Z');
    expect(run('utc_z').items[0].url).toBe('https://events.example.test/e/utcz');
  });
  it('tzid_la (with VTIMEZONE) equals floating', () => {
    expect(run('tzid_la').items.map((i) => i.startsAt).sort()).toEqual(['2026-10-18T02:00:00Z', '2026-12-06T03:00:00Z']);
  });
  it('a TZID with no VTIMEZONE resolves by IANA name', () => {
    expect(run('tzid_iana_only').items[0].startsAt).toBe('2026-10-18T02:00:00Z');
  });
  it('an unknown TZID is dropped as bad_tz; a VEVENT with no DTSTART is skipped silently', () => {
    const r = run('tzid_unknown');
    expect(r.items).toEqual([]);
    expect(r.dropped).toEqual({ bad_tz: 1 });
  });
  it('dst_gap (2027-03-14 02:30 local) is dropped as dst_gap', () => {
    const r = run('dst_gap', new Date('2027-03-01T12:00:00Z'));
    expect(r.items).toEqual([]);
    expect(r.dropped).toEqual({ dst_gap: 1 });
  });
  it('dst_fold (2026-11-01 01:30 local) resolves to the daylight occurrence', () => {
    expect(run('dst_fold').items[0].startsAt).toBe('2026-11-01T08:30:00Z');
  });
});

describe('url and privacy', () => {
  it('uses the variant-supplied event page URL when the VEVENT has no URL', () => {
    const { items } = run('rrule_weekly', NOW, { eventUrl: 'https://events.example.test/page' });
    expect(items[0].url).toBe('https://events.example.test/page');
  });
  it('never outputs DESCRIPTION text and only emits SourceEvent keys', () => {
    for (const n of ['rrule_weekly', 'rdate', 'exdate', 'override_moved', 'override_cancelled', 'allday_exclusive_end', 'floating', 'utc_z', 'tzid_la', 'cancelled_single']) {
      const { items } = run(n);
      expect(items.length).toBeGreaterThan(0);
      expect(JSON.stringify(items)).not.toContain(DESC_SENTINEL);
      for (const i of items) for (const k of Object.keys(i)) expect(SOURCE_EVENT_KEYS.has(k), `${n}: ${k}`).toBe(true);
    }
  });
  it('an empty calendar parses to no items and no drops', () => {
    expect(parseIcs(fixture('ics/empty.ics'), { now: NOW })).toMatchObject({ items: [], dropped: {} });
  });
});
