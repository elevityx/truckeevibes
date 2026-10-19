// Test helpers for the widget's *.test.ts files (not part of the bundle: index.ts never imports it).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_DIR = join(__dirname, '..', '..', 'public', 'widget-demo');
export const FIXTURE_CLOCK = { halloween: Date.parse('2026-10-15T15:00:00Z'), christmas: Date.parse('2026-12-10T17:00:00Z') } as const;
export const LOCAL_BOX = { minLat: 39.1, maxLat: 39.5, minLng: -120.47, maxLng: -119.88 };
export const TZ = 'America/Los_Angeles';

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `fixture-${name}.json`), 'utf8')) as Record<string, unknown>;
}

export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** A valid raw API row (schema shape). */
export function rawRow(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(n), origin: 'lights', formerIds: [], pageUrl: null, title: `Event ${n}`, description: 'A synthetic event.', summary: null,
    startsAt: '2026-10-30T23:00:00Z', endsAt: '2026-10-31T01:00:00Z', allDay: false, startDate: null, endDate: null, timeKnown: true,
    venue: 'Hall', address: '1 Main St, Truckee, CA 96161', town: null, lat: 39.33, lng: -120.18, categories: [], age: 'unknown',
    adultsOnly: false, url: null, ticketUrl: null, ...over,
  };
}

/** A valid raw API envelope. */
export function rawEnvelope(events: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, scope: 'lights', season: 'halloween', year: 2026, dataAt: '2026-10-15T14:50:00.000000Z', stale: false, pageComplete: true,
    mirror: { state: 'confirmed', confirmedAt: '2026-10-15T14:48:00.000000Z', heldSince: null, heldCount: 0 },
    region: { tz: TZ, localBox: LOCAL_BOX }, count: events.length, nextCursor: null,
    attribution: { name: 'TruckeeVibes', url: 'https://truckeevibes.com/' }, events, ...over,
  };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch fake that serves `pages` keyed by cursor ('' = first page) and records each URL. */
export function pagedFetch(pages: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(u.toString());
    const p = pages[u.searchParams.get('cursor') ?? ''];
    if (!p) throw new TypeError('network');
    return p();
  }) as typeof fetch;
  return { fn, calls };
}
