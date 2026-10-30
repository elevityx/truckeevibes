// A14 (AC-M1-139): curated_dates makes no network calls and emits only the dates its config lists.
import { describe, expect, it } from 'vitest';
import { adapter } from './curatedDates';
import { createPoliteFetch } from '../core/politeFetch';
import { fakeNet, makeClock, source, text } from '../testing/fakes';

const NOW = Date.parse('2026-10-19T12:00:00Z');
// The migration's EAA config (20261023000500_bars_aviation.sql), verbatim.
const EAA = {
  tz: 'America/Los_Angeles', provenance: 'listed on tahoe.com, checked 2026-10-19', title: 'EAA Chapter 1073 Pancake Breakfast',
  venueName: 'Truckee Tahoe Airport', address: '10356 Truckee Airport Rd, Truckee, CA 96161', town: 'Truckee', lat: 39.3180851, lng: -120.1381025,
  url: 'https://www.tahoe.com/business/eea-truckee/events', priceText: '$5–$7', categories: ['family', 'kids', 'outdoors', 'learning'],
  dates: [{ date: '2026-11-14', start: '08:00', end: '10:00' }, { date: '2026-12-12', start: '08:00' }, { date: '2027-01-09', start: '08:00' }],
};

function setup(over: Record<string, unknown> = {}, now = NOW) {
  const clock = makeClock(now);
  const net = fakeNet(() => text('nf', 404), clock.now);
  const src = source({ slug: 'eaa-1073-breakfast', family: 'curated_dates', allowed_hosts: ['tahoe.com'], allowed_methods: ['feed'], page_cap: 1, config: { ...EAA, ...over } });
  const pf = createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
  return { run: () => adapter.fetch({ source: src, fetch: pf, now: new Date(now) }), net };
}

describe('identity', () => {
  it('is the curated_dates family', () => {
    expect(adapter.family).toBe('curated_dates');
    expect(adapter.version).toBe('curated_dates.1');
  });
});

describe('AC-M1-139 happy path', () => {
  it('makes 0 network requests and emits exactly the 3 listed dates', async () => {
    const s = setup();
    const r = await s.run();
    expect(s.net.calls).toHaveLength(0);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => [i.startsAt, i.endsAt])).toEqual([
      ['2026-11-14T16:00:00Z', '2026-11-14T18:00:00Z'], ['2026-12-12T16:00:00Z', undefined], ['2027-01-09T16:00:00Z', undefined],
    ]);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('item shape: key, no series, title, venue, categories, price, url', async () => {
    const r = await setup().run();
    for (const [n, d] of ['2026-11-14', '2026-12-12', '2027-01-09'].entries()) {
      const i = r.items[n];
      expect(i.externalKey).toBe(`curated:eaa-1073-breakfast#${d}`);
      expect(i.seriesUid).toBeUndefined();
      expect(i.allDay).toBe(false);
      expect(i.title).toBe('EAA Chapter 1073 Pancake Breakfast');
      expect(i.title).not.toMatch(/young eagles/i);
      expect(i.venueName).toBe('Truckee Tahoe Airport');
      expect(i.address).toBe('10356 Truckee Airport Rd, Truckee, CA 96161');
      expect(i.town).toBe('Truckee');
      expect(i.lat).toBe(39.3180851);
      expect(i.lng).toBe(-120.1381025);
      for (const c of ['family', 'kids', 'outdoors', 'learning']) expect(i.categoriesHint).toContain(c);
      expect(i.priceMin).toBe(5);
      expect(i.priceMax).toBe(7);
      expect(i.url).toBe('https://www.tahoe.com/business/eea-truckee/events');
      expect(i.rawSummaryLength).toBe(0);
    }
  });
  it('generates nothing: no 2027-02-13 item; after the last date there are 0 items and the status is ok', async () => {
    const r = await setup().run();
    expect(r.items.some((i) => i.externalKey.endsWith('2027-02-13'))).toBe(false);
    const late = await setup({}, Date.parse('2027-01-10T12:00:00Z')).run();
    expect(late.status).toBe('ok');
    expect(late.items).toHaveLength(0);
  });
  it('a date earlier than today is skipped; one more than 120 days out is skipped', async () => {
    const mid = await setup({}, Date.parse('2026-11-20T12:00:00Z')).run();
    expect(mid.items.map((i) => i.externalKey)).toEqual(['curated:eaa-1073-breakfast#2026-12-12', 'curated:eaa-1073-breakfast#2027-01-09']);
    const far = await setup({ dates: [{ date: '2026-10-20', start: '08:00' }, { date: '2027-03-01', start: '08:00' }] }).run();
    expect(far.items.map((i) => i.externalKey)).toEqual(['curated:eaa-1073-breakfast#2026-10-20']);
  });
});

describe('AC-M1-139 config failures -> config_dates_invalid', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['dates out of order', { dates: [{ date: '2026-12-12', start: '08:00' }, { date: '2026-11-14', start: '08:00' }] }],
    ['duplicate dates', { dates: [{ date: '2026-11-14', start: '08:00' }, { date: '2026-11-14', start: '09:00' }] }],
    ['end before start', { dates: [{ date: '2026-11-14', start: '08:00', end: '07:00' }] }],
    ['foreign url', { url: 'https://evil.example/' }],
    ['http url', { url: 'http://www.tahoe.com/x' }],
    ['unknown category (aviation)', { categories: ['aviation'] }],
    ['a date past today + 200 days', { dates: [{ date: '2028-01-01', start: '08:00' }] }],
    ['missing provenance', { provenance: undefined }],
    ['short provenance', { provenance: 'short' }],
    ['no dates', { dates: [] }],
    ['13 dates', { dates: Array.from({ length: 13 }, (_, i) => ({ date: `2026-${String(11 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, start: '08:00' })) }],
    ['impossible date', { dates: [{ date: '2026-02-30', start: '08:00' }] }],
    ['bad time', { dates: [{ date: '2026-11-14', start: '25:00' }] }],
    ['unknown key', { ageRule: '21_plus' }],
  ];
  for (const [name, over] of bad) {
    it(name, async () => {
      await expect(setup(over).run()).rejects.toThrow('config_dates_invalid');
    });
  }
});
