// AC-M1-13 (Tribe fixture, 2 pages) and AC-M1-56 (A2 config.filter over vlt_filter.json).
// Contract assumed: each adapter module exports `adapter: Adapter`; AdapterResult adds `filtered?: number`.
import { describe, expect, it } from 'vitest';
import { adapter } from './tribe';
import { DESC_SENTINEL, fakePolite, fixture, SOURCE_EVENT_KEYS, source } from '../testing/fakes';

const NOW = new Date('2026-10-15T19:00:00Z'); // 2026-10-15 12:00 in Los Angeles
const BASE = 'https://events.example.test';
const cfg = (extra: Record<string, unknown> = {}) => ({ base: BASE, tz: 'America/Los_Angeles', ...extra });
const ctx = (net: ReturnType<typeof fakePolite>, config: Record<string, unknown>, over = {}) =>
  ({ source: source({ slug: 'tribe-sample', family: 'tribe', config, allowed_methods: ['api'], page_cap: 10, ...over }), fetch: net.fetch as never, now: NOW });

const twoPages = () => fakePolite((u) => ({ body: fixture(u.searchParams.get('page') === '2' ? 'tribe/events_p2.json' : 'tribe/events_p1.json') }));

describe('tribe: two-page fixture (AC-M1-13)', () => {
  it('requests api pages with start_date today (local), end_date +120d, per_page 50, following next_rest_url', async () => {
    const net = twoPages();
    const r = await adapter.fetch(ctx(net, cfg()));
    expect(r.status).toBe('ok');
    expect(net.calls).toHaveLength(2);
    expect(net.calls.every((c) => c.kind === 'api')).toBe(true);
    const first = new URL(net.calls[0].url);
    expect(first.origin + first.pathname).toBe(`${BASE}/wp-json/tribe/events/v1/events`);
    expect(first.searchParams.get('start_date')).toBe('2026-10-15');
    expect(first.searchParams.get('end_date')).toBe('2027-02-12');
    expect(first.searchParams.get('per_page')).toBe('50');
    expect(first.searchParams.get('page')).toBe('1');
    expect(new URL(net.calls[1].url).searchParams.get('page')).toBe('2');
    expect(r.items).toHaveLength(4);
  });
  it('maps ids, UTC times, venue, price and categories', async () => {
    const r = await adapter.fetch(ctx(twoPages(), cfg()));
    const byKey = Object.fromEntries(r.items.map((i) => [i.externalKey, i]));
    expect(Object.keys(byKey).sort()).toEqual(['101', '102', '103', '201']);
    const a = byKey['101'];
    expect(a.title).toBe('Sample Concert Night – Main Stage');
    expect(a.startsAt).toBe('2026-10-18T02:00:00Z');
    expect(a.endsAt).toBe('2026-10-18T04:00:00Z');
    expect(a.allDay).toBe(false);
    expect(a.timeKnown).toBe(true);
    expect(a.tz).toBe('America/Los_Angeles');
    expect([a.venueName, a.address, a.town, a.lat, a.lng]).toEqual(['Example Hall', '100 Sample Way', 'Truckee', 39.33, -120.18]);
    expect(a.url).toBe('https://events.example.test/event/sample-concert-night/');
    expect(a.priceText).toBe('$15');
    expect(a.categoriesHint).toContain('music');
  });
  it('all-day rows: startDate local date, endDate = local end date + 1 day (exclusive), timeKnown false', async () => {
    const r = await adapter.fetch(ctx(twoPages(), cfg()));
    const d = r.items.find((i) => i.externalKey === '102')!;
    expect(d.allDay).toBe(true);
    expect(d.timeKnown).toBe(false);
    expect(d.startDate).toBe('2026-10-31');
    expect(d.endDate).toBe('2026-11-01');
    expect(d.startsAt).toBe('2026-10-31T07:00:00Z');
  });
  it('an event with venue: [] has no venue fields and empty cost has no priceText', async () => {
    const r = await adapter.fetch(ctx(twoPages(), cfg()));
    const t = r.items.find((i) => i.externalKey === '103')!;
    expect(t.venueName ?? null).toBeNull();
    expect(t.lat ?? null).toBeNull();
    expect(t.priceText).toBe('Free');
    const d = r.items.find((i) => i.externalKey === '102')!;
    expect(d.priceText ?? null).toBeNull();
  });
  it('classifies the organizer cost "Free" as free with price:text_free (AC-R4b-13)', async () => {
    const r = await adapter.fetch(ctx(twoPages(), cfg()));
    const t = r.items.find((i) => i.externalKey === '103')!;
    expect(t.priceKind).toBe('free');
    expect(t.tagReasons).toContain('price:text_free');
  });
  it('maps the Tribe category slug through the family map and records cat:source_map', async () => {
    const r = await adapter.fetch(ctx(twoPages(), cfg()));
    const a = r.items.find((i) => i.externalKey === '101')!;
    expect(a.categoriesHint).toContain('music');
    expect(a.tagReasons).toContain('cat:source_map');
  });
  it('item keys are a subset of the SourceEvent key set and no description text leaves the adapter', async () => {
    const r = await adapter.fetch(ctx(twoPages(), cfg()));
    for (const i of r.items) for (const k of Object.keys(i)) expect(SOURCE_EVENT_KEYS.has(k), k).toBe(true);
    expect(JSON.stringify(r)).not.toContain(DESC_SENTINEL);
  });
  it('stops at page_cap even when next_rest_url is present', async () => {
    const net = twoPages();
    const r = await adapter.fetch(ctx(net, cfg(), { page_cap: 1 }));
    expect(net.calls).toHaveLength(1);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(3);
  });
  it('a non-2xx page -> http_error with the status and no items', async () => {
    const net = fakePolite(() => ({ status: 503, body: 'down' }));
    const r = await adapter.fetch(ctx(net, cfg()));
    expect(r.status).toBe('http_error');
    expect(r.httpStatus).toBe(503);
    expect(r.items).toEqual([]);
  });
  it('invalid JSON throws (the runner records parse_error)', async () => {
    const net = fakePolite(() => ({ body: '<html>not json</html>' }));
    await expect(adapter.fetch(ctx(net, cfg()))).rejects.toBeInstanceOf(Error);
  });
  it('config.base is required', async () => {
    await expect(adapter.fetch(ctx(twoPages(), { tz: 'America/Los_Angeles' }))).rejects.toBeInstanceOf(Error);
  });
});

describe('tribe: config.filter over vlt_filter.json (AC-M1-56)', () => {
  const FILTER = { windowDays: 45, towns: ['truckee', 'tahoe city', 'incline village'], maxDurationDays: 14, excludeCategorySlugs: ['tours'], maxItems: 10 };
  const one = () => fakePolite(() => ({ body: fixture('tribe/vlt_filter.json') }));

  it('end_date = today + windowDays', async () => {
    const net = one();
    await adapter.fetch(ctx(net, cfg({ filter: FILTER })));
    expect(new URL(net.calls[0].url).searchParams.get('end_date')).toBe('2026-11-29');
  });
  it('keeps exactly the in-town, <= maxDurationDays, non-excluded rows with a venue; reports filtered', async () => {
    const r = await adapter.fetch(ctx(one(), cfg({ filter: FILTER })));
    expect(r.status).toBe('ok');
    expect(r.items.map((i) => i.externalKey).sort()).toEqual(['301', '302', '307']);
    expect(r.filtered).toBe(4);
  });
  it('maxItems 2 with 3 survivors -> parse_error/filter_cap with items: [] (fail closed, never truncated)', async () => {
    const r = await adapter.fetch(ctx(one(), cfg({ filter: { ...FILTER, maxItems: 2 } })));
    expect(r.status).toBe('parse_error');
    expect(r.errorCode).toBe('filter_cap');
    expect(r.items).toEqual([]);
  });
  it('maxItems equal to the survivor count is fine', async () => {
    const r = await adapter.fetch(ctx(one(), cfg({ filter: { ...FILTER, maxItems: 3 } })));
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(3);
  });
  it('without config.filter (Diamond Peak shape) nothing is filtered and the window is +120d', async () => {
    const net = one();
    const r = await adapter.fetch(ctx(net, cfg()));
    expect(r.items).toHaveLength(7);
    expect(r.filtered ?? 0).toBe(0);
    expect(new URL(net.calls[0].url).searchParams.get('end_date')).toBe('2027-02-12');
  });
});

// AC-M1-56 (A5-1 adapter part, A6-3): Visit Lake Tahoe's exclusions, any-match, trimmed and lower-cased on both sides.
describe('tribe: category exclusion (AC-M1-56 A5-1 / A6-3)', () => {
  const VLT = ['attractions-events', 'wellness', 'tahoe-blue-event-center'];
  const FILTER = { windowDays: 45, towns: ['truckee'], maxDurationDays: 14, excludeCategorySlugs: VLT, maxItems: 20 };
  const tev = (id: number, cats?: string[]) => ({
    id, url: `https://events.example.test/event/sample-${id}/`, title: `Sample Listing ${id}`, all_day: false,
    start_date: '2026-10-20 19:00:00', end_date: '2026-10-20 21:00:00', utc_start_date: '2026-10-20 19:00:00', utc_end_date: '2026-10-20 21:00:00',
    cost: '', ...(cats ? { categories: cats.map((slug) => ({ slug, name: slug })) } : {}),
    venue: { venue: `Example Venue ${id}`, address: '1 Sample Way', city: 'Truckee', geo_lat: 39.3, geo_lng: -120.1 },
  });
  const net = (events: unknown[]) => fakePolite(() => ({ body: JSON.stringify({ events }) }));
  const keys = (r: { items: { externalKey: string }[] }) => r.items.map((i) => i.externalKey).sort();

  it('any match drops: [music-dance-events, attractions-events], [wellness], [headliners-events, tahoe-blue-event-center]; kept: [kids-families-events, free-events] and no categories', async () => {
    const r = await adapter.fetch(ctx(net([
      tev(1, ['music-dance-events', 'attractions-events']), tev(2, ['wellness']), tev(3, ['headliners-events', 'tahoe-blue-event-center']),
      tev(4, ['kids-families-events', 'free-events']), tev(5),
    ]), cfg({ filter: FILTER })));
    expect(r.status).toBe('ok');
    expect(keys(r)).toEqual(['4', '5']);
    expect(r.filtered).toBe(3);
  });

  it('an API slug " Wellness " (case/whitespace) is dropped and counted in filtered', async () => {
    const r = await adapter.fetch(ctx(net([tev(1, [' Wellness ']), tev(2, ['free-events'])]), cfg({ filter: FILTER })));
    expect(keys(r)).toEqual(['2']);
    expect(r.filtered).toBe(1);
  });

  it('a config value " Wellness " drops an API "wellness"; every category drop counts in filtered', async () => {
    const r = await adapter.fetch(ctx(net([tev(1, ['wellness']), tev(2, ['music-dance-events', 'wellness']), tev(3, ['free-events']), tev(4)]),
      cfg({ filter: { ...FILTER, excludeCategorySlugs: [' Wellness '] } })));
    expect(keys(r)).toEqual(['3', '4']);
    expect(r.filtered).toBe(2);
  });
});
