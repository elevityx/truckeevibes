// AC-M1-57 (A2): Alibi's site-wide Events Manager export.
import { describe, expect, it } from 'vitest';
import { adapter } from './icsEventsmanager';
import { DESC_SENTINEL, fakePolite, fixture, source } from '../testing/fakes';

const NOW = new Date('2026-10-15T12:00:00Z');
const ICS_URL = 'https://venue-one.example.test/events.ics';
const ctx = (net: ReturnType<typeof fakePolite>, over = {}) =>
  ({ source: source({ slug: 'venue-sample', family: 'ics_eventsmanager', config: { icsUrl: ICS_URL }, allowed_hosts: ['venue-one.example.test'], allowed_methods: ['feed'], ...over }), fetch: net.fetch as never, now: NOW });
const net200 = () => fakePolite(() => ({ body: fixture('ics/eventsmanager_sitewide.ics'), headers: { etag: 'W/"em1"', 'last-modified': 'Wed, 14 Oct 2026 10:00:00 GMT' } }));

describe('icsEventsmanager', () => {
  it('makes exactly one conditional feed request to config.icsUrl (no list page, no /ical/ per event)', async () => {
    const net = net200();
    await adapter.fetch(ctx(net));
    expect(net.calls).toEqual([{ url: ICS_URL, kind: 'feed', conditional: true }]);
  });
  it('keeps both venues, converts TZID times to UTC, drops the past VEVENT by the window', async () => {
    const r = await adapter.fetch(ctx(net200()));
    expect(r.status).toBe('ok');
    expect(r.items.map((i) => [i.externalKey, i.startsAt]).sort()).toEqual([
      ['em-1001@venue-one.example.test#', '2026-10-23T02:00:00Z'],
      ['em-1002@venue-one.example.test#', '2026-10-30T01:00:00Z'],
    ]);
    const venues = r.items.map((i) => i.venueName).sort();
    expect(venues).toEqual(['Example Pub Incline', 'Example Taproom Truckee']);
  });
  it('no output string contains the ATTACH URL or description text; validators and headers flow through', async () => {
    const r = await adapter.fetch(ctx(net200()));
    const s = JSON.stringify(r);
    expect(s).not.toContain('img.example.test');
    expect(s).not.toContain('sentinel-photo');
    expect(s).not.toContain(DESC_SENTINEL);
    expect(r.etag).toBe('W/"em1"');
    expect(r.lastModified).toBe('Wed, 14 Oct 2026 10:00:00 GMT');
    expect(r.httpStatus).toBe(200);
  });
  it('304 -> not_modified with no items', async () => {
    const net = fakePolite(() => ({ status: 304, notModified: true }));
    const r = await adapter.fetch(ctx(net));
    expect(r).toMatchObject({ status: 'not_modified', items: [] });
  });
  it('a 5xx -> http_error with the status', async () => {
    const r = await adapter.fetch(ctx(fakePolite(() => ({ status: 502, body: 'x' }))));
    expect(r).toMatchObject({ status: 'http_error', httpStatus: 502, items: [] });
  });
  it('contentHash is sha256 hex of the body', async () => {
    const r = await adapter.fetch(ctx(net200()));
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// AC-M1-81 (j): fetchIcsFeed hands the grant's allowed_hosts to the parser; the parser version is bumped.
describe('icsEventsmanager non-place LOCATION (AC-M1-81 j)', () => {
  it('np-1 items carry the allowed-host LOCATION as url and have no venue; version is ics_eventsmanager.2', async () => {
    const net = fakePolite(() => ({ body: fixture('ics/location_nonplace.ics') }));
    const r = await adapter.fetch({ ...ctx(net), now: new Date('2026-11-01T12:00:00Z') } as never);
    const np1 = r.items.filter((i) => i.externalKey.startsWith('np-1@example.test#'));
    expect(np1).toHaveLength(3);
    for (const i of np1) {
      expect(i.url).toBe('https://venue-one.example.test/events/');
      expect(i.venueName).toBeUndefined();
    }
    expect(adapter.version).toBe('ics_eventsmanager.2');
  });
});

