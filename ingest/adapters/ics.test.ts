// AC-M1-12: the 13 required ICS fixtures (+ A2 eventsmanager shape tested in icsEventsmanager.test.ts).
// Contract assumed: parseIcs(text, { now: Date, tz?: string, eventUrl?: string }) -> { items, dropped: Record<reason, n>, truncated: number }.
import { describe, expect, it } from 'vitest';
import { isNonPlaceLocation, locationLink, parseIcs } from './ics';
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

// AC-M1-81 (A8-1): a LOCATION that is a URL or has no letter is not a venue; an allowed-host https LOCATION is a last-resort link.
describe('AC-M1-81 non-place LOCATION', () => {
  const HOSTS = ['venue-one.example.test', 'www.venue-one.example.test'];
  const NP_NOW = new Date('2026-11-01T12:00:00Z');
  const np = (extra: Record<string, unknown> = {}) => parseIcs(fixture('ics/location_nonplace.ics'), { now: NP_NOW, ...extra });
  const byUid = (items: ReturnType<typeof np>['items'], n: number) => items.filter((i) => i.externalKey.startsWith(`np-${n}@example.test#`));
  const hasNo = (i: object, ...keys: string[]) => keys.every((k) => (i as Record<string, unknown>)[k] === undefined);

  it('(a) np-1: three weekly all-day items, no venue or address, url from the allowed-host LOCATION', () => {
    const items = byUid(np({ allowedHosts: HOSTS }).items, 1);
    expect(items).toHaveLength(3);
    for (const i of items) {
      expect(hasNo(i, 'venueName', 'address')).toBe(true);
      expect(i.url).toBe('https://venue-one.example.test/events/');
      expect(i.allDay).toBe(true);
      expect(i.seriesUid).toBe('np-1@example.test');
      const d = (Date.parse(`${i.endDate}T00:00:00Z`) - Date.parse(`${i.startDate}T00:00:00Z`)) / 86_400_000;
      expect(d).toBe(1);
    }
  });
  it('(b) np-2: the VEVENT URL wins over the location link', () => {
    const [i] = byUid(np({ allowedHosts: HOSTS }).items, 2);
    expect(hasNo(i, 'venueName', 'address')).toBe(true);
    expect(i.url).toBe('https://venue-one.example.test/e/2');
  });
  it('(c) np-3 foreign host, np-4 http, np-5 userinfo: no venue and no url', () => {
    for (const n of [3, 4, 5]) {
      const [i] = byUid(np({ allowedHosts: HOSTS }).items, n);
      expect(i, `np-${n}`).toBeTruthy();
      expect(hasNo(i, 'venueName', 'address', 'url'), `np-${n}`).toBe(true);
    }
  });
  it('(d) np-6 digits only, np-7 dash only: no venue, address or url', () => {
    for (const n of [6, 7]) {
      const [i] = byUid(np({ allowedHosts: HOSTS }).items, n);
      expect(i, `np-${n}`).toBeTruthy();
      expect(hasNo(i, 'venueName', 'address', 'url'), `np-${n}`).toBe(true);
    }
  });
  it('(e) np-8: scheme and host matched case-insensitively', () => {
    const [i] = byUid(np({ allowedHosts: HOSTS }).items, 8);
    expect(hasNo(i, 'venueName', 'address')).toBe(true);
    expect(i.url).toBe('https://venue-one.example.test/up');
  });
  it('(f) np-9 control: the comma split is unchanged', () => {
    const [i] = byUid(np({ allowedHosts: HOSTS }).items, 9);
    expect(i.venueName).toBe('Example Hall');
    expect(i.address).toBe('1 Sample St, Truckee, CA 96161');
  });
  it('(g) without allowedHosts no url is filled; eventUrl fills only when the VEVENT has no URL', () => {
    const none = np().items;
    expect(byUid(none, 1).every((i) => i.url === undefined)).toBe(true);
    expect(byUid(none, 8)[0].url).toBeUndefined();
    const withEvent = np({ eventUrl: 'https://venue-one.example.test/details/9', allowedHosts: HOSTS }).items;
    for (const i of withEvent) {
      const expected = i.externalKey.startsWith('np-2@') ? 'https://venue-one.example.test/e/2' : 'https://venue-one.example.test/details/9';
      expect(i.url, i.externalKey).toBe(expected);
    }
  });
  it('(h) a non-place location is not a dropped reason', () => {
    const r = np({ allowedHosts: HOSTS });
    expect(r.dropped).toEqual({});
    expect(r.items.length).toBe(11);
  });
  it('(i) isNonPlaceLocation and locationLink', () => {
    for (const t of ['https://a.example.test', ' HTTP://x ', '123', ' — ', '']) expect(isNonPlaceLocation(t), JSON.stringify(t)).toBe(true);
    for (const t of ['Alibi Ale Works - Truckee Public House', 'Café 1']) expect(isNonPlaceLocation(t), t).toBe(false);
    expect(locationLink('https://venue-one.example.test:8443/', HOSTS)).toBeUndefined();
    expect(locationLink('https://venue-one.example.test/a', HOSTS)).toBe('https://venue-one.example.test/a');
    expect(locationLink('https://venue-one.example.test/a', undefined)).toBeUndefined();
    expect(locationLink('https://venue-one.example.test/a', [])).toBeUndefined();
    expect(locationLink('not a url', HOSTS)).toBeUndefined();
  });
});
