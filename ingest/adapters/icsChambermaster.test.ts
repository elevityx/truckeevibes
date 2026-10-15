// AC-M1-14: ChamberMaster HTML discovery + per-event ICS.
import { describe, expect, it } from 'vitest';
import { adapter, parseChamberDetailAddress } from './icsChambermaster';
import { FetchError } from '../core/politeFetch';
import { DESC_SENTINEL, fakePolite, fixture, source } from '../testing/fakes';

const NOW = new Date('2026-10-15T12:00:00Z');
const LIST = 'https://chamber.example.test/events';
const ctx = (net: ReturnType<typeof fakePolite>, over = {}) =>
  ({ source: source({ slug: 'chamber-sample', family: 'ics_chambermaster', config: { listUrl: LIST }, page_cap: 10, ...over }), fetch: net.fetch as never, now: NOW });

const chamberNet = () => fakePolite((u) => {
  if (u.pathname === '/events') return { body: fixture('chambermaster/events_list.html') };
  const m = /\/events\/ical\/.*-(\d+)\.ics$/.exec(u.pathname);
  if (m) return { body: fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', m[1]) };
  return { status: 404, body: 'nope' };
});

describe('icsChambermaster', () => {
  it('3 detail links (+1 search link, +1 rendermode link, 1 duplicate) -> list as html, then exactly 3 direct ical ICS feed requests', async () => {
    const net = chamberNet();
    const r = await adapter.fetch(ctx(net));
    expect(net.calls[0]).toMatchObject({ url: LIST, kind: 'html' });
    const ics = net.calls.slice(1);
    expect(ics).toHaveLength(3);
    expect(ics.every((c) => c.kind === 'feed')).toBe(true);
    expect(ics.map((c) => c.url).sort()).toEqual([
      'https://chamber.example.test/events/ical/sample-art-walk-2002.ics',
      'https://chamber.example.test/events/ical/sample-block-party-2001.ics',
      'https://chamber.example.test/events/ical/sample-trail-day-2003.ics',
    ]);
    expect(net.urls().some((u) => /\/events\/search|rendermode/.test(u))).toBe(false);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(3);
  });
  it('keeps UTC Z times and sets url to the details page', async () => {
    const r = await adapter.fetch(ctx(chamberNet()));
    expect(r.items.every((i) => i.startsAt === '2026-10-17T18:00:00Z')).toBe(true);
    expect(r.items.map((i) => i.url).sort()).toEqual([
      'https://chamber.example.test/events/details/sample-art-walk-2002',
      'https://chamber.example.test/events/details/sample-block-party-2001',
      'https://chamber.example.test/events/details/sample-trail-day-2003',
    ]);
    expect(JSON.stringify(r)).not.toContain(DESC_SENTINEL);
  });
  it('budget floor((page_cap - 1) / 2) events (the list page uses one request)', async () => {
    const net = chamberNet();
    await adapter.fetch(ctx(net, { page_cap: 3 }));
    expect(net.calls).toHaveLength(2); // list + 1 ICS
  });
  it('a list page that is not 200 -> http_error and no ICS requests', async () => {
    const net = fakePolite(() => ({ status: 500, body: 'x' }));
    const r = await adapter.fetch(ctx(net));
    expect(r.status).toBe('http_error');
    expect(net.calls).toHaveLength(1);
  });

  // AC-M1-74 (A6-4): all-or-nothing detail fetches.
  const failing = (failId: string, mk: () => { status?: number; body?: string }) => fakePolite((u) => {
    if (u.pathname === '/events') return { body: fixture('chambermaster/events_list.html') };
    const m = /\/events\/ical\/(.*-(\d+))\.ics$/.exec(u.pathname);
    if (m && m[1] === failId) return mk();
    if (m) return { body: fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', m[2]) };
    return { status: 404, body: 'nope' };
  });
  it('(a) detail 2 of 3 returns 503 -> http_error/503/detail_http, items [], detail 3 never requested', async () => {
    const net = failing('sample-art-walk-2002', () => ({ status: 503, body: 'busy' }));
    const r = await adapter.fetch(ctx(net));
    expect(r).toMatchObject({ status: 'http_error', httpStatus: 503, errorCode: 'detail_http', items: [] });
    expect(net.calls).toHaveLength(3);
    expect(net.urls().some((u) => u.includes('sample-trail-day-2003'))).toBe(false);
  });
  it('(b) detail 1 returns 404 -> http_error/404, 2 requests', async () => {
    const net = failing('sample-block-party-2001', () => ({ status: 404, body: 'gone' }));
    const r = await adapter.fetch(ctx(net));
    expect(r).toMatchObject({ status: 'http_error', httpStatus: 404, errorCode: 'detail_http', items: [] });
    expect(net.calls).toHaveLength(2);
  });
  it('(c) detail 3 throws FetchError(timeout) -> the adapter rejects with that error', async () => {
    const net = fakePolite((u) => {
      if (u.pathname === '/events') return { body: fixture('chambermaster/events_list.html') };
      if (u.pathname.endsWith('-2003.ics')) throw new FetchError('timeout');
      return { body: fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', /-(\d+)\.ics$/.exec(u.pathname)![1]) };
    });
    await expect(adapter.fetch(ctx(net))).rejects.toMatchObject({ code: 'timeout' });
  });
  it('(d) all 3 details succeed -> ok with 3 items', async () => {
    const r = await adapter.fetch(ctx(chamberNet()));
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(3);
  });
});

// A8-1: parser version bumped so source_event_versions shows which parser stored a row.
describe('icsChambermaster parser version', () => {
  it('is ics_chambermaster.3', () => { expect(adapter.version).toBe('ics_chambermaster.3'); });
});

// AC-M1-86 (A9-1): discovery from the 60-day list, direct ICS, a 45-day window, a budget that cannot hit page_cap.
describe('AC-M1-86 windowed discovery', () => {
  const HOSTS = ['chamber.example.test', 'business.chamber.example.test'];
  const wctx = (net: ReturnType<typeof fakePolite>, over: Record<string, unknown> = {}, config: Record<string, unknown> = { listUrl: LIST, windowDays: 45 }) =>
    ({ source: source({ slug: 'chamber-sample', family: 'ics_chambermaster', config, allowed_hosts: HOSTS, page_cap: 200, ...over }), fetch: net.fetch as never, now: NOW });
  const winNet = () => fakePolite((u) => {
    if (u.pathname === '/events') return { body: fixture('chambermaster/events_list_window.html') };
    const m = /^\/events\/ical\/.*-(\d+)\.ics$/.exec(u.pathname);
    if (m) return { body: fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', m[1]) };
    return { status: 404, body: 'nope' };
  });
  const O = 'https://chamber.example.test/events/ical/';
  it('(a) page_cap 200: list, then the 5 in-window ICS in date order (undated last), all on the list host', async () => {
    const net = winNet();
    const r = await adapter.fetch(wctx(net));
    expect(net.calls[0]).toMatchObject({ url: LIST, kind: 'html' });
    expect(net.calls.slice(1).map((c) => c.url)).toEqual([
      `${O}sample-soon-3001.ics`, `${O}sample-alt-host-3006.ics`, `${O}sample-later-3002.ics`, `${O}sample-edge-3003.ics`, `${O}sample-undated-3007.ics`,
    ]);
    expect(net.calls.slice(1).every((c) => c.kind === 'feed')).toBe(true);
    expect(net.urls().some((u) => /addtocalendar|\/events\/search|rendermode|other\.example\.test|business\./.test(u))).toBe(false);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(5);
    expect(r.filtered).toBe(2);
    expect(r.items.every((i) => /^https:\/\/chamber\.example\.test\/events\/details\/sample-[a-z-]+-300\d$/.test(i.url ?? ''))).toBe(true);
  });
  it('(b) page_cap 5 -> budget 2: list + 3001 + 3006 only', async () => {
    const net = winNet();
    await adapter.fetch(wctx(net, { page_cap: 5 }));
    expect(net.urls()).toEqual([LIST, `${O}sample-soon-3001.ics`, `${O}sample-alt-host-3006.ics`]);
  });
  it('(c) page_cap 1 -> budget 0: only the list, ok, no items', async () => {
    const net = winNet();
    const r = await adapter.fetch(wctx(net, { page_cap: 1 }));
    expect(net.urls()).toEqual([LIST]);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(0);
  });
  it('(d) windowDays: absent -> 45, 7 -> only 3001/3006 (+ undated), 500 -> clamped to 120', async () => {
    const ids = async (config: Record<string, unknown>) => {
      const net = winNet();
      await adapter.fetch(wctx(net, {}, config));
      return net.urls().slice(1).map((u) => /ical\/sample-([a-z-]+-\d+)\.ics/.exec(u)![1]);
    };
    expect(await ids({ listUrl: LIST })).toEqual(['soon-3001', 'alt-host-3006', 'later-3002', 'edge-3003', 'undated-3007']);
    expect(await ids({ listUrl: LIST, windowDays: 7 })).toEqual(['soon-3001', 'alt-host-3006', 'undated-3007']);
    expect(await ids({ listUrl: LIST, windowDays: 500 })).toContain('far-3004');
  });
  it('(e) version', () => { expect(adapter.version).toBe('ics_chambermaster.3'); });
  it('(g) an item starting past the window is dropped and counted in filtered', async () => {
    const net = fakePolite((u) => {
      if (u.pathname === '/events') return { body: fixture('chambermaster/events_list_window.html') };
      return { body: fixture('chambermaster/event_template.ics').replace('20261017T180000Z', '20270101T180000Z').replace('20261017T200000Z', '20270101T200000Z').replaceAll('{{ID}}', '1') };
    });
    const r = await adapter.fetch(wctx(net, {}, { listUrl: LIST, windowDays: 7 }));
    expect(r.items).toHaveLength(0);
    expect(r.filtered).toBe(4 + 3);
  });
});

// AC-M1-87 (A9-2): the details page fills a missing address and town.
describe('AC-M1-87 details-page address', () => {
  const venueNet = (detail: () => { status?: number; body?: string }, ics = 'chambermaster/event_venue_only.ics') => fakePolite((u) => {
    if (u.pathname === '/events') return { body: fixture('chambermaster/events_list.html') };
    const m = /\/events\/ical\/.*-(\d+)\.ics$/.exec(u.pathname);
    if (m) return { body: fixture(ics).replaceAll('{{ID}}', m[1]) };
    if (u.pathname.startsWith('/events/details/')) return detail();
    return { status: 404, body: 'nope' };
  });
  it('(a) address page: calls are ical (feed) then details (html) per event; items get address and town', async () => {
    const net = venueNet(() => ({ body: fixture('chambermaster/event_detail_address.html') }));
    const r = await adapter.fetch(ctx(net));
    expect(net.calls).toHaveLength(1 + 3 * 2);
    const per = net.calls.slice(1);
    for (let k = 0; k < 3; k++) {
      expect(per[2 * k].kind).toBe('feed');
      expect(per[2 * k].url).toMatch(/\/events\/ical\/.*\.ics$/);
      expect(per[2 * k + 1].kind).toBe('html');
      expect(per[2 * k + 1].url).toMatch(/\/events\/details\/sample-[a-z-]+-200\d$/);
    }
    expect(r.items).toHaveLength(3);
    for (const i of r.items) {
      expect(i.venueName).toBe('Example Gallery');
      expect(i.address).toBe('10 Sample Lane, Truckee, CA 96161');
      expect(i.town).toBe('Truckee');
    }
  });
  it('(b) a page without an address keeps the venue name only', async () => {
    const r = await adapter.fetch(ctx(venueNet(() => ({ body: fixture('chambermaster/event_detail_noaddress.html') }))));
    expect(r.status).toBe('ok');
    for (const i of r.items) { expect(i.venueName).toBe('Example Gallery'); expect(i.address).toBeUndefined(); expect(i.town).toBeUndefined(); }
  });
  it('(c) an ICS that already has an address makes no details request', async () => {
    const net = venueNet(() => ({ body: fixture('chambermaster/event_detail_address.html') }), 'chambermaster/event_template.ics');
    await adapter.fetch(ctx(net));
    expect(net.urls().some((u) => u.includes('/events/details/'))).toBe(false);
  });
  it('(d) details 503 or timeout is soft; robots_blocked rethrows', async () => {
    const r1 = await adapter.fetch(ctx(venueNet(() => ({ status: 503, body: 'busy' }))));
    expect(r1.status).toBe('ok'); expect(r1.items).toHaveLength(3); expect(r1.items.every((i) => i.address === undefined)).toBe(true);
    const r2 = await adapter.fetch(ctx(venueNet(() => { throw new FetchError('timeout'); })));
    expect(r2.status).toBe('ok'); expect(r2.items).toHaveLength(3); expect(r2.items.every((i) => i.address === undefined)).toBe(true);
    await expect(adapter.fetch(ctx(venueNet(() => { throw new FetchError('robots_blocked'); })))).rejects.toMatchObject({ code: 'robots_blocked' });
  });
  it('(e) a sentence LOCATION has no venue, so no details request', async () => {
    const net = fakePolite((u) => {
      if (u.pathname === '/events') return { body: fixture('chambermaster/events_list.html') };
      const m = /\/events\/ical\/.*-(\d+)\.ics$/.exec(u.pathname);
      if (m) return { body: fixture('chambermaster/event_template.ics').replace(/^LOCATION:.*$/m, 'LOCATION:Find participating spots on Example Town Taste Week.').replaceAll('{{ID}}', m[1]) };
      return { status: 404, body: 'nope' };
    });
    const r = await adapter.fetch(ctx(net));
    expect(net.urls().some((u) => u.includes('/events/details/'))).toBe(false);
    expect(r.items.every((i) => i.venueName === undefined)).toBe(true);
  });
  it('(f) parseChamberDetailAddress', () => {
    const page = (street: string, loc: string, region = 'Nevada', zip = '89451') => `<div itemprop="location" itemscope><div itemprop="address"><meta itemprop="streetAddress" content="${street}"><meta itemprop="addressLocality" content="${loc}"><meta itemprop="addressRegion" content="${region}"><meta itemprop="postalCode" content="${zip}"></div></div>`;
    expect(parseChamberDetailAddress(fixture('chambermaster/event_detail_address.html'))).toEqual({ address: '10 Sample Lane, Truckee, CA 96161', town: 'Truckee' });
    expect(parseChamberDetailAddress(page('5 Sample Rd', 'INCLINE VILLAGE'))).toEqual({ address: '5 Sample Rd, Incline Village, NV 89451', town: 'Incline Village' });
    expect(parseChamberDetailAddress(page('5 Sample Rd', 'kings beach', 'california', '96143'))).toEqual({ address: '5 Sample Rd, Kings Beach, CA 96143', town: 'Kings Beach' });
    expect(parseChamberDetailAddress(page('5 Sample Rd', '<b>x</b>'))).toEqual({ address: '5 Sample Rd, NV 89451' });
    expect(parseChamberDetailAddress(page('5 Sample Rd', '12345'))).toEqual({ address: '5 Sample Rd, NV 89451' });
    expect(parseChamberDetailAddress(fixture('chambermaster/event_detail_noaddress.html'))).toEqual({});
    expect(parseChamberDetailAddress('<html><body>nothing</body></html>')).toEqual({});
    expect(parseChamberDetailAddress(page('', 'Truckee'))).toEqual({});
    expect(parseChamberDetailAddress(page('x'.repeat(170), 'Truckee'))).toEqual({});
  });
});
