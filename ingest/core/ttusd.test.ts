// A12 (AC-M1-104 .. 110): the TTUSD include grammar, shaping and in-feed dedupe. Pure: no network, no clock.
import { describe, expect, it, vi } from 'vitest';
import cases from './ttusd.cases.json';

vi.mock('../adapters/common', async (orig) => {
  const actual = await orig<typeof import('../adapters/common')>();
  return { ...actual, makeEvent: vi.fn(actual.makeEvent) };
});
import { makeEvent } from '../adapters/common';
import { decideSchoolTitle, filterSchoolItems, SCHOOLS, type DropReason, type RawOccurrence, type SchoolKey } from './ttusd';

type Row = { source: SchoolKey; title: string; allDay: boolean; expect: string; school?: string; categories?: string[] };
const rows = cases as Row[];
const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-10-18T12:00:00Z');

const occ = (title: string, over: Partial<RawOccurrence> = {}): RawOccurrence => ({
  externalKey: '1#2026-10-20T16:00:00Z', title, allDay: false, startsAt: '2026-10-20T16:00:00Z', endsAt: '2026-10-20T18:00:00Z', ...over,
});
const allDayOcc = (title: string, date = '2026-10-18', over: Partial<RawOccurrence> = {}): RawOccurrence => ({
  externalKey: `1#${date}`, title, allDay: true, startsAt: `${date}T07:00:00Z`, startDate: date, endDate: '2026-10-19', ...over,
});

describe('AC-M1-104 ttusd.cases.json', () => {
  it('has at least 45 rows covering every non-dup reason and every rule', () => {
    expect(rows.length).toBeGreaterThanOrEqual(45);
    const e = new Set(rows.map((r) => r.expect));
    for (const x of ['notice', 'drop:oversize', 'drop:restricted', 'drop:internal', 'drop:notice_dup', 'drop:notice_timed', 'drop:no_match',
      'event:ceremony', 'event:open_house', 'event:performance', 'event:festival', 'event:home_game']) expect(e.has(x), x).toBe(true);
    expect(e.has('drop:dup')).toBe(false);
  });
  it.each(rows.map((r, i) => [i, `${r.source}${r.allDay ? ' all-day' : ''}: ${r.title.slice(0, 60)}`, r] as const))('row %i %s', (_i, _n, r) => {
    const d = decideSchoolTitle(r.title, r.allDay, r.source);
    const got = d.kind === 'notice' ? 'notice' : d.kind === 'event' ? `event:${d.rule}` : `drop:${d.reason}`;
    expect(got).toBe(r.expect);
    if (r.school && d.kind === 'event') expect(d.school).toBe(r.school);
    if (r.categories) {
      const raw = r.allDay ? allDayOcc(r.title) : occ(r.title);
      const out = filterSchoolItems([raw], r.source, TZ, NOW);
      expect(out.items).toHaveLength(1);
      expect([...out.items[0].categoriesHint].sort()).toEqual(r.categories);
    }
  });
});

describe('directory', () => {
  it('has the eleven schools with one-line addresses and venue names', () => {
    expect(Object.keys(SCHOOLS).sort()).toEqual(['acms', 'district', 'dte', 'ges', 'kbe', 'nths', 'nts', 'shs', 'te', 'ths', 'tle']);
    expect(SCHOOLS.te.address).toBe('11911 Donner Pass Rd, Truckee, CA 96161');
    expect(SCHOOLS.nths.address).toBe('2945 Polaris Rd, Tahoe City, CA 96145');
    expect(SCHOOLS.district.name).toBe('Tahoe Truckee Unified School District');
    expect(SCHOOLS.ths.homeConvention).toBe('vs');
    expect(SCHOOLS.acms.homeConvention).toBe('marker');
    expect(SCHOOLS.te.homeConvention).toBeUndefined();
  });
});

describe('AC-M1-105 shaping of the pumpkin patch', () => {
  it('district timed "Truckee Elementary Pumpkin Patch & Kermes" -> TE venue, stripped title, source-map reason', () => {
    const { items, filtered } = filterSchoolItems([occ('Truckee Elementary Pumpkin Patch & Kermes')], 'district', TZ, NOW);
    expect(filtered).toBe(0);
    expect(items).toHaveLength(1);
    const i = items[0];
    expect(i.title).toBe('Pumpkin Patch & Kermes');
    expect(i.venueName).toBe('Truckee Elementary School');
    expect(i.address).toBe('11911 Donner Pass Rd, Truckee, CA 96161');
    expect([...i.categoriesHint].sort()).toEqual(['community', 'family', 'halloween-fall', 'kids', 'schools']);
    expect(i.tagReasons).toContain('cat:source_map');
    expect(i.allDay).toBe(false);
  });
  it('TE "Pumpkin Patch" gives the same categories and venue', () => {
    const { items } = filterSchoolItems([occ('Pumpkin Patch')], 'te', TZ, NOW);
    expect(items[0].title).toBe('Pumpkin Patch');
    expect([...items[0].categoriesHint].sort()).toEqual(['community', 'family', 'halloween-fall', 'kids', 'schools']);
    expect(items[0].venueName).toBe('Truckee Elementary School');
  });
});

describe('AC-M1-107 notices are shaped as district-office all-day items', () => {
  it('district all-day "Thanksgiving Break" -> categories exactly [schools], district venue', () => {
    const { items } = filterSchoolItems([allDayOcc('Thanksgiving Break', '2026-11-25', { endDate: '2026-11-28' })], 'district', TZ, NOW);
    expect(items[0].categoriesHint).toEqual(['schools']);
    expect(items[0].venueName).toBe('Tahoe Truckee Unified School District');
    expect(items[0].allDay).toBe(true);
    expect(items[0].startDate).toBe('2026-11-25');
    expect(items[0].endDate).toBe('2026-11-28');
  });
});

describe('AC-M1-109 truncation', () => {
  it('an 81+ character title whose "Staff Only" starts after character 80 -> oversize', () => {
    const t = `Fall Concert ${'x'.repeat(70)} Staff Only`;
    expect(t.indexOf('Staff Only')).toBeGreaterThan(80);
    expect(decideSchoolTitle(t, false, 'ths')).toEqual({ kind: 'drop', reason: 'oversize' });
  });
  it('a passing title of exactly 79 characters is submitted untruncated', () => {
    const t = `Tahoe Truckee Unified School District: Fall ${'Winter '.repeat(4)}Concert`;
    expect(t.length).toBe(79);
    const { items } = filterSchoolItems([occ(t)], 'ths', TZ, NOW);
    expect(items).toHaveLength(1);
    expect(items[0].title.length).toBe(79);
    expect(items[0].title).toBe(t);
  });
  it('makeEvent is never called for a dropped occurrence, and receives the full decoded title for a passing one', () => {
    const spy = vi.mocked(makeEvent);
    spy.mockClear();
    filterSchoolItems([occ('Regular Board Meeting'), occ(`Fall Concert ${'x'.repeat(80)} Staff Only`), occ('Boys Soccer Regionals')], 'ths', TZ, NOW);
    expect(spy).not.toHaveBeenCalled();
    filterSchoolItems([occ('Fall Concert')], 'ths', TZ, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].title).toBe('Fall Concert');
  });
});

describe('AC-M1-110 in-feed dedupe (r3)', () => {
  const run = (raw: RawOccurrence[], source: SchoolKey = 'te') => filterSchoolItems(raw, source, TZ, NOW);
  it('TE all-day + timed "Pumpkin Patch" on one day -> one listing (the timed one), dup 1 (r4, AC-M1-121)', () => {
    const r = run([allDayOcc('Pumpkin Patch', '2026-10-18', { externalKey: '1#a' }), occ('Pumpkin Patch', { externalKey: '2#b', startsAt: '2026-10-18T16:00:00Z', endsAt: '2026-10-18T18:00:00Z' })]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].allDay).toBe(false);
    expect(r.items[0].startsAt).toBe('2026-10-18T16:00:00Z');
    expect(r.reasons.dup).toBe(1);
  });
  it('AC-M1-121: the same result in every processing order', () => {
    const a = allDayOcc('Pumpkin Patch', '2026-10-18', { externalKey: '9#a' });
    const t = occ('Pumpkin Patch', { externalKey: '1#b', startsAt: '2026-10-18T16:00:00Z', endsAt: '2026-10-19T00:00:00Z' });
    for (const raw of [[a, t], [t, a]]) {
      const r = run(raw);
      expect(r.items.map((i) => i.startsAt)).toEqual(['2026-10-18T16:00:00Z']);
    }
  });
  it('AC-M1-122: musical at 14:00, 19:00 and 19:00 (duplicate) -> two listings', () => {
    const r = run([occ('Fall Musical', { externalKey: '1#a', startsAt: '2026-10-20T21:00:00Z' }), occ('Fall Musical', { externalKey: '2#b', startsAt: '2026-10-21T02:00:00Z' }),
      occ('Fall Musical', { externalKey: '3#c', startsAt: '2026-10-21T02:00:00Z' })]);
    expect(r.items).toHaveLength(2);
    expect(r.reasons.dup).toBe(1);
  });
  it('two timed "Fall Musical" at 14:00 and 19:00 -> two items', () => {
    const r = run([occ('Fall Musical', { externalKey: '1#a', startsAt: '2026-10-20T21:00:00Z' }), occ('Fall Musical', { externalKey: '2#b', startsAt: '2026-10-21T02:00:00Z' })]);
    expect(r.items).toHaveLength(2);
  });
  it('identical start instant, different occur ids -> one item, dup 1', () => {
    const r = run([occ('Fall Musical', { externalKey: '2#b' }), occ('Fall Musical', { externalKey: '1#a' })]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].externalKey).toBe('1#a');
    expect(r.reasons.dup).toBe(1);
    expect(r.filtered).toBe(1);
  });
  it('two all-day "Pumpkin Patch" on one date -> one item, dup 1', () => {
    const r = run([allDayOcc('Pumpkin Patch', '2026-10-18', { externalKey: '1#a' }), allDayOcc('Pumpkin Patch', '2026-10-18', { externalKey: '2#b' })]);
    expect(r.items).toHaveLength(1);
    expect(r.reasons.dup).toBe(1);
  });
  it('page location text never reaches an item; the TE venue is used; district "NTHS: Open House" -> school nths', () => {
    const withLoc = { ...occ('Pumpkin Patch'), location: "Example's office" } as RawOccurrence;
    const r = run([withLoc]);
    expect(r.items[0].venueName).toBe('Truckee Elementary School');
    expect(JSON.stringify(r.items)).not.toContain('Example');
    const d = run([occ('NTHS: Open House')], 'district');
    expect(d.items[0].title).toBe('Open House');
    expect(d.items[0].venueName).toBe('North Tahoe High School');
    expect(decideSchoolTitle('NTHS: Open House', false, 'district')).toMatchObject({ kind: 'event', school: 'nths' });
  });
  it('reason counts add up to filtered', () => {
    const r = run([occ('Regular Board Meeting', { externalKey: '1#a' }), occ('Boys Soccer Regionals', { externalKey: '2#b' }), occ('Fall Concert', { externalKey: '3#c' })], 'ths');
    expect(r.reasons).toEqual({ internal: 1, no_match: 1 } satisfies Partial<Record<DropReason, number>>);
    expect(r.filtered).toBe(2);
  });
});
