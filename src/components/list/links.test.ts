// S1.11 links.ts (adapted from TL links.ts). Interface assumptions: VibeEvent has `summary` (ours, templated) and `url`;
// googleCalendarUrl(e, tz) builds details from summary + url; directionsUrl(e) uses lat/lng; safeWebsite(url) returns a
// normalized https URL or null; townOf(address) is copied unchanged. Not covered here: the .ics builder (no export is named in the spec).
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { directionsUrl, googleCalendarUrl, placeLine, safeWebsite, townOf } from './links';

const e = {
  id: '11111111-2222-4333-8444-555555555555', slug: 'park', title: 'Music in the Park & more',
  summary: 'Live music downtown.', startsAt: '2026-10-30T23:00:00.000Z', endsAt: '2026-10-31T01:00:00.000Z',
  allDay: false, startDate: null, endDate: null, timeKnown: true, venue: 'Downtown Park',
  address: '10046 Church St, Truckee, CA 96161', town: 'Truckee', area: 'truckee', lat: 39.3274, lng: -120.1838,
  categories: ['music'], priceKind: 'free', priceMin: null, priceMax: null, age: 'all_ages', featured: false,
  url: 'https://example.org/park', ticketUrl: null, sources: ['Truckee Chamber'],
} as VibeEvent;

describe('googleCalendarUrl', () => {
  it('builds an encoded TEMPLATE link in UTC', () => {
    const u = new URL(googleCalendarUrl(e, 'America/Los_Angeles'));
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('text')).toBe('Music in the Park & more');
    expect(u.searchParams.get('dates')).toBe('20261030T230000Z/20261031T010000Z');
    expect(u.searchParams.get('ctz')).toBe('America/Los_Angeles');
    expect(u.searchParams.get('location')).toBe('Downtown Park, 10046 Church St, Truckee, CA 96161');
    expect(u.searchParams.get('details')).toContain('Live music downtown.');
    expect(u.searchParams.get('details')).toContain('https://example.org/park');
    expect(u.search).not.toContain('& more'); // the ampersand is escaped, not a new param
  });
  it('gives an event with no end 3 hours', () => {
    const u = new URL(googleCalendarUrl({ ...e, endsAt: null }, 'America/Los_Angeles'));
    expect(u.searchParams.get('dates')).toBe('20261030T230000Z/20261031T020000Z');
  });
  it('with no url the details are the summary alone', () => {
    const u = new URL(googleCalendarUrl({ ...e, url: null }, 'America/Los_Angeles'));
    expect(u.searchParams.get('details')).toBe('Live music downtown.');
  });
});

describe('placeLine / directionsUrl', () => {
  it('place line is venue, address; address alone without a venue', () => {
    expect(placeLine(e)).toBe('Downtown Park, 10046 Church St, Truckee, CA 96161');
    expect(placeLine({ ...e, venue: null })).toBe('10046 Church St, Truckee, CA 96161');
  });
  it('directions use the pin coordinates', () => {
    const u = new URL(directionsUrl(e));
    expect(u.origin + u.pathname).toBe('https://www.google.com/maps/dir/');
    expect(u.searchParams.get('api')).toBe('1');
    expect(u.searchParams.get('destination')).toBe('39.3274,-120.1838');
  });
});

describe('safeWebsite (V6: only https, no userinfo, no script schemes)', () => {
  it('passes a plain https URL', () => {
    expect(safeWebsite('https://example.org/a')).toBe('https://example.org/a');
  });
  it.each([
    ['http', 'http://example.org'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>1</script>'],
    ['userinfo', 'https://u@example.org/'],
    ['not a url', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_n, url) => {
    expect(safeWebsite(url)).toBeNull();
  });
  it('rejects null', () => {
    expect(safeWebsite(null)).toBeNull();
  });
});

describe('townOf', () => {
  it('finds the town in an address', () => {
    expect(townOf('10046 Church St, Truckee, CA 96161, USA')).toBe('Truckee');
    expect(townOf('Heritage Plaza, Tahoe City, CA')).toBe('Tahoe City');
    expect(townOf('2005 NV-28, Incline Village, NV 89451')).toBe('Incline Village');
    expect(townOf('Truckee')).toBe('Truckee');
  });
});
