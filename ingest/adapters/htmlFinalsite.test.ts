// A12 (AC-M1-111 .. 113): the Finalsite month-page adapter over a fake network and synthetic HTML fixtures.
import { describe, expect, it } from 'vitest';
import { adapter } from './htmlFinalsite';
import { createPoliteFetch, FetchError } from '../core/politeFetch';
import { fakeNet, fixture, makeClock, source, text } from '../testing/fakes';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ROBOTS = 'User-agent: *\nCrawl-delay: 5\nDisallow: /fs/\nAllow: /fs/pages/\nAllow: /fs/login\n';
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });

interface Setup { host: string; path: string; school: string; pages: Record<string, string>; status?: Record<string, number>; config?: Record<string, unknown> }
function setup(o: Setup) {
  const clock = makeClock(NOW);
  const net = fakeNet((u) => {
    if (u.pathname === '/robots.txt') return text(ROBOTS);
    if (u.pathname === o.path) {
      const m = u.searchParams.get('cal_date')?.slice(0, 7) ?? '';
      const st = o.status?.[m];
      if (st) return html('busy', st);
      return html(o.pages[m] ?? fixture('finalsite/empty_month.html'));
    }
    return text('nf', 404);
  }, clock.now);
  const src = source({
    slug: `ttusd-${o.school}`, family: 'html_finalsite', allowed_hosts: [o.host], allowed_methods: ['html'], page_cap: 6,
    config: { calendarUrl: `https://${o.host}${o.path}`, school: o.school, allowlist: 'ttusd', tz: 'America/Los_Angeles', ...o.config },
  });
  const pf = createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
  const run = () => adapter.fetch({ source: src, fetch: pf, now: new Date(NOW) });
  return { run, net, clock, src };
}
const te = (over: Partial<Setup> = {}) => setup({
  host: 'te.ttusd.org', path: '/calendar', school: 'te',
  pages: { '2026-10': fixture('finalsite/te_2026-10.html'), '2026-11': fixture('finalsite/te_2026-11.html') }, ...over,
});

describe('adapter identity', () => {
  it('is the html_finalsite family', () => {
    expect(adapter.family).toBe('html_finalsite');
    expect(adapter.version).toBe('html_finalsite.1');
  });
});

describe('AC-M1-111 TE', () => {
  it('requests robots, then five month pages as kind html, never under /fs/, >= 5000 ms apart', async () => {
    const s = te();
    await s.run();
    expect(s.net.urls()).toEqual([
      'https://te.ttusd.org/robots.txt',
      'https://te.ttusd.org/calendar?cal_date=2026-10-01', 'https://te.ttusd.org/calendar?cal_date=2026-11-01', 'https://te.ttusd.org/calendar?cal_date=2026-12-01',
      'https://te.ttusd.org/calendar?cal_date=2027-01-01', 'https://te.ttusd.org/calendar?cal_date=2027-02-01',
    ]);
    expect(s.net.urls().some((u) => u.includes('/fs/'))).toBe(false);
    const at = s.net.calls.map((c) => c.at);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(5000);
  });
  it('yields the four listings (the all-day pumpkin patch is dropped for the timed one, r4) and six filtered', async () => {
    const r = await te().run();
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.items.map((i) => `${i.title}|${i.allDay ? 'allday' : i.startsAt}`)).toEqual([
      'Pumpkin Patch|2026-10-18T16:00:00Z', 'Walk- a- thon|2026-10-23T16:30:00Z', 'Halloween Parade|2026-10-30T19:00:00Z', 'Winter Band Concert|2026-11-18T02:00:00Z',
    ]);
    expect(r.filtered).toBe(6);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    for (const i of r.items) { expect(i.url).toBe('https://te.ttusd.org/calendar'); expect(i.venueName).toBe('Truckee Elementary School'); }
    expect(JSON.stringify(r.items)).not.toContain('office');
  });
  it('out-of-window "Picture Day" is neither an item nor counted; all-day dates are kept as local dates', async () => {
    const r = await te().run();
    expect(r.items.some((i) => i.title.startsWith('Picture'))).toBe(false);
    expect(r.items.some((i) => i.allDay)).toBe(false);
  });
  it('Thanksgiving (all-day 11-25 .. 11-28) is a school-source notice, so it is dropped but its dates parse', async () => {
    const r = await te().run();
    expect(r.items.some((i) => /thanksgiving/i.test(i.title))).toBe(false);
  });
  it('externalKey is <eventId>#<startZ>', async () => {
    const r = await te().run();
    expect(r.items[1].externalKey).toBe('1003#2026-10-23T16:30:00Z');
  });
});

describe('AC-M1-112 district', () => {
  const district = () => setup({
    host: 'www.ttusd.org', path: '/parents-students/calendars/calendars2', school: 'district',
    pages: { '2026-10': fixture('finalsite/district_2026-10.html'), '2026-11': fixture('finalsite/district_2026-11.html') },
  });
  it('five items with school venues, four filtered', async () => {
    const r = await district().run();
    expect(r.status).toBe('ok');
    const by = Object.fromEntries(r.items.map((i) => [i.title, i]));
    expect(Object.keys(by).sort()).toEqual(['Fall Festival', 'NO SCHOOL - Veteran\'s Day', 'Open House', 'Pumpkin Patch & Kermes', 'Thanksgiving Break'].sort());
    expect(by['Pumpkin Patch & Kermes'].venueName).toBe('Truckee Elementary School');
    expect(by['Fall Festival'].venueName).toBe('Truckee Elementary School');
    expect(by['Open House'].venueName).toBe('North Tahoe High School');
    expect(by['Open House'].startsAt).toBe('2026-11-13T01:00:00Z');
    expect(by['Thanksgiving Break'].venueName).toBe('Tahoe Truckee Unified School District');
    expect(by['Thanksgiving Break'].categoriesHint).toEqual(['schools']);
    expect(r.filtered).toBe(4);
  });
});

describe('AC-M1-113 layout and config fail closed', () => {
  const failing = async (page: string) => {
    const s = te({ pages: { '2026-10': page } });
    return s.run().then((r) => (r.items.length === 0 ? `${r.status}:${r.errorCode}` : 'items'), (e: Error) => e.message);
  };
  it('malformed occur id -> layout_changed', async () => expect(await failing(fixture('finalsite/malformed_occur.html'))).toBe('parse_error:layout_changed'));
  it('a data-occur-id outside any event-link anchor -> layout_changed', async () => expect(await failing(fixture('finalsite/mismatch_count.html'))).toBe('parse_error:layout_changed'));
  it('a page without fsCalendarDaybox -> layout_changed', async () => expect(await failing('<html><body><p>moved</p></body></html>')).toBe('parse_error:layout_changed'));
  it('an anchor with an empty title -> layout_changed', async () => {
    const page = fixture('finalsite/single_quoted.html').replace("title='Fall Concert'", "title=''");
    expect(await failing(page)).toBe('parse_error:layout_changed');
  });
  it('single-quoted attributes parse normally (1 item)', async () => {
    const s = te({ pages: { '2026-10': fixture('finalsite/single_quoted.html') } });
    const r = await s.run();
    expect(r.items).toHaveLength(1);
    expect(r.items[0].title).toBe('Fall Concert');
  });
  it.each([
    ['calendarUrl missing', { calendarUrl: undefined }, 'config_calendarUrl_required'],
    ['school unknown', { school: 'xyz' }, 'config_school_unknown'],
    ['allowlist missing', { allowlist: undefined }, 'config_allowlist_unknown'],
  ])('config: %s -> %s', async (_n, config, code) => {
    const s = te({ config });
    await expect(s.run()).rejects.toThrow(code);
  });
  it('a 503 on page 3 -> http_error, 0 items', async () => {
    const s = te({ status: { '2026-12': 503 } });
    const r = await s.run();
    expect(r.status).toBe('http_error');
    expect(r.items).toEqual([]);
    expect(r.httpStatus).toBe(503);
  });
  it('a FetchError from the polite layer propagates (robots_blocked)', async () => {
    const clock = makeClock(NOW);
    const net = fakeNet((u) => (u.pathname === '/robots.txt' ? text('User-agent: *\nDisallow: /calendar\n') : html('x')), clock.now);
    const src = source({ slug: 'ttusd-te', family: 'html_finalsite', allowed_hosts: ['te.ttusd.org'], allowed_methods: ['html'], page_cap: 6,
      config: { calendarUrl: 'https://te.ttusd.org/calendar', school: 'te', allowlist: 'ttusd' } });
    const pf = createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    await expect(adapter.fetch({ source: src, fetch: pf, now: new Date(NOW) })).rejects.toBeInstanceOf(FetchError);
  });
});
