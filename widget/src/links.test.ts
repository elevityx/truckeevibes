// AC-W2-02: the Lights links.test.ts and eventUrl.test.ts cases for the ported functions, plus widget-only rules.
import { describe, expect, it } from 'vitest';
import type { WidgetEvent } from './types';
import { checkEventUrl, directionsUrl, googleCalendarUrl, placeLine, safePageUrl, safeWebsite, townOf, worthTheDrive, type EventUrlProblem } from './links';

const e: WidgetEvent = {
  id: '11111111-2222-4333-8444-555555555555',
  title: 'Halloween in the Park & more',
  description: 'Trick-or-treat downtown.\nCostume contest at 5:30.',
  venue: 'Downtown Park',
  address: '10046 Church St, Truckee, CA 96161',
  lat: 39.3274,
  lng: -120.1838,
  startsAt: '2026-10-30T23:00:00.000Z',
  endsAt: '2026-10-31T01:00:00.000Z',
  url: 'https://example.org/park',
  adultsOnly: false,
  origin: 'lights', formerIds: [], pageUrl: null, allDay: false, startDate: null, endDate: null, timeKnown: true,
};

describe('worthTheDrive (Amendment 3)', () => {
  // Lights' region bbox { 39.15, 39.45, -120.42, -119.98 } through eventBounds() (+0.05 each side, east +0.10): the widget gets this box.
  const truckee = { minLat: 39.15 - 0.05, maxLat: 39.45 + 0.05, minLng: -120.42 - 0.05, maxLng: -119.98 + 0.1 };
  it.each([
    ['Downtown Truckee', 39.3274, -120.1838, false],
    ['Sand Harbor', 39.1979, -119.9306, false],
    ['Crystal Bay', 39.2266, -120.0039, false],
    ['Reno (Wilbur May Arboretum)', 39.545, -119.825, true],
    ['Carson City', 39.164, -119.767, true],
  ])('%s -> %s', (_n, lat, lng, far) => {
    expect(worthTheDrive(truckee, { lat: lat as number, lng: lng as number })).toBe(far);
  });
});

describe('googleCalendarUrl', () => {
  it('builds an encoded TEMPLATE link in UTC', () => {
    const u = new URL(googleCalendarUrl(e, 'America/Los_Angeles'));
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('text')).toBe('Halloween in the Park & more');
    expect(u.searchParams.get('dates')).toBe('20261030T230000Z/20261031T010000Z');
    expect(u.searchParams.get('ctz')).toBe('America/Los_Angeles');
    expect(u.searchParams.get('location')).toBe('Downtown Park, 10046 Church St, Truckee, CA 96161');
    expect(u.searchParams.get('details')).toBe('Trick-or-treat downtown.\nCostume contest at 5:30.\n\nhttps://example.org/park');
    expect(u.search).not.toContain('& more'); // the ampersand is escaped, not a new param
    expect([...u.searchParams.keys()]).toEqual(['action', 'text', 'dates', 'ctz', 'details', 'location']);
  });
  it('gives an event with no end 3 hours', () => {
    const u = new URL(googleCalendarUrl({ ...e, endsAt: null, url: null, venue: null }, 'America/Los_Angeles'));
    expect(u.searchParams.get('dates')).toBe('20261030T230000Z/20261031T020000Z');
    expect(u.searchParams.get('details')).toBe(e.description);
    expect(u.searchParams.get('location')).toBe(e.address);
  });
});

describe('other links', () => {
  it('directions use the pin coordinates', () => {
    const u = new URL(directionsUrl(e));
    expect(u.searchParams.get('api')).toBe('1');
    expect(u.searchParams.get('destination')).toBe('39.3274,-120.1838');
  });
  it('only https websites render', () => {
    expect(safeWebsite('https://example.org/a')).toBe('https://example.org/a');
    expect(safeWebsite('http://example.org')).toBeNull();
    expect(safeWebsite('javascript:alert(1)')).toBeNull();
    expect(safeWebsite(null)).toBeNull();
    expect(safeWebsite('https://bit.ly/x')).toBeNull();
    expect(safeWebsite('https://127.0.0.1/')).toBeNull();
    expect(safeWebsite('https://example.org:8443/')).toBeNull();
    expect(safeWebsite('https://u@example.org/')).toBeNull();
  });
  it('finds the town in an address', () => {
    expect(townOf('10046 Church St, Truckee, CA 96161, USA')).toBe('Truckee');
    expect(townOf('Heritage Plaza, Tahoe City, CA')).toBe('Tahoe City');
    expect(townOf('2005 NV-28, Incline Village, NV 89451')).toBe('Incline Village');
    expect(townOf('Truckee')).toBe('Truckee');
  });
});

// Parity table with private.valid_event_url (supabase/tests/10_events.test.sql, A6).
describe('checkEventUrl mirrors private.valid_event_url', () => {
  it.each([
    ['https://example.org', 'example.org'],
    ['https://Example.COM/a?b=1#top', 'example.com'],
    ['https://www.tcpud.org/recreation/special-events/harvest-fest?x=1', 'www.tcpud.org'],
    ['https://a-b.example.org/x', 'a-b.example.org'],
    ['https://example.org/path/with.dots/', 'example.org'],
    ['https://bit.lyx.org/x', 'bit.lyx.org'],
    ['https://notbit.ly.org/x', 'notbit.ly.org'],
  ])('accepts %s', (url, host) => {
    expect(checkEventUrl(url)).toEqual({ ok: true, host });
  });

  const bad: [string, EventUrlProblem][] = [
    ['http://example.org', 'scheme'],
    ['HTTPS://example.org', 'scheme'], // scheme is case-sensitive
    ['javascript:alert(1)', 'scheme'],
    ['https://user@example.org', 'chars'],
    ['https://user:pw@example.org', 'chars'],
    ['https://example.org/`x`', 'chars'], // backtick
    ['https://example.org/a b', 'chars'],
    ['https://example.org/a\u0007b', 'chars'],
    ['https://example.org/a\u0085b', 'chars'],
    ['https://example.org\\@evil.com', 'chars'],
    ['https://example.org/"x', 'chars'],
    ["https://example.org/'x", 'chars'],
    ['https://example.org/<x>', 'chars'],
    ['https://example.org:8443/', 'port'],
    ['https://example.org:443', 'port'],
    ['https://[::1]/', 'port'],
    ['https://example.org./event', 'host'], // trailing dot
    ['https://192.168.0.1/', 'host'],
    ['https://3232235521/', 'host'],
    ['https://0x7f000001/', 'host'],
    ['https://0177.0.0.1/', 'host'],
    ['https://localhost/', 'host'],
    ['https://foo.localhost/x', 'host'],
    ['https://intranet/', 'host'],
    ['https://example.c', 'host'],
    ['https://-bad.com', 'host'],
    ['https://bad-.com', 'host'],
    ['https://' + 'a'.repeat(64) + '.com', 'host'], // label over 63
    ['https://a..com', 'host'],
    ['https://', 'host'],
    ['https://bit.ly/abc', 'shortener'],
    ['https://www.bit.ly/abc', 'shortener'], // shortener subdomain
    ['https://T.CO/x', 'shortener'],
    ['https://tinyurl.com', 'shortener'],
    ['https://rebrand.ly/x', 'shortener'],
    ['https://example.org/' + 'a'.repeat(300), 'length'],
  ];
  it.each(bad)('rejects %s as %s', (url, problem) => {
    expect(checkEventUrl(url)).toEqual({ ok: false, problem });
  });

  it('counts code points like Postgres char_length: 141 emoji after the host is 161 characters and passes', () => {
    const url = 'https://example.org/' + '😀'.repeat(141);
    expect([...url].length).toBe(161);
    expect(url.length).toBe(302);
    expect(checkEventUrl(url)).toEqual({ ok: true, host: 'example.org' });
    expect(checkEventUrl('https://example.org/' + '😀'.repeat(281))).toEqual({ ok: false, problem: 'length' }); // 301 characters
    expect(checkEventUrl('https://example.org/' + '😀'.repeat(280))).toEqual({ ok: true, host: 'example.org' }); // 300
  });

  it('boundary: exactly 300 characters passes, 301 fails', () => {
    const base = 'https://example.org/';
    expect(checkEventUrl(base + 'a'.repeat(300 - base.length)).ok).toBe(true);
    expect(checkEventUrl(base + 'a'.repeat(301 - base.length))).toEqual({ ok: false, problem: 'length' });
  });
});

describe('widget-only link rules (AC-W2-02)', () => {
  it.each(['javascript:alert(1)', 'data:text/html,x', 'http://x.com', 'https://user@x.com', 'https://1.2.3.4/', 'https://x.com:8443/'])(
    'safeWebsite(%s) is null', (u) => expect(safeWebsite(u)).toBeNull());
  it('worthTheDrive is inclusive at the box edge', () => {
    const b = { minLat: 39, maxLat: 40, minLng: -121, maxLng: -120 };
    expect(worthTheDrive(b, { lat: 39, lng: -121 })).toBe(false);
    expect(worthTheDrive(b, { lat: 40, lng: -120 })).toBe(false);
    expect(worthTheDrive(b, { lat: 40.0001, lng: -120 })).toBe(true);
    expect(worthTheDrive(b, { lat: Number.NaN, lng: -120 })).toBe(true);
  });
  it('placeLine joins venue and address', () => {
    expect(placeLine({ venue: 'Hall', address: '1 Main St, Truckee, CA' })).toBe('Hall, 1 Main St, Truckee, CA');
    expect(placeLine({ venue: null, address: '1 Main St' })).toBe('1 Main St');
  });
  it('safePageUrl only accepts truckeevibes.com pages', () => {
    expect(safePageUrl('https://truckeevibes.com/e/x/')).toBe('https://truckeevibes.com/e/x/');
    expect(safePageUrl('https://evil.example/')).toBeNull();
    expect(safePageUrl('https://truckeevibes.com.evil.example/')).toBeNull();
    expect(safePageUrl('https://truckeevibes.com@evil.example/')).toBeNull();
    expect(safePageUrl('javascript:alert(1)')).toBeNull();
    expect(safePageUrl(null)).toBeNull();
  });
});
