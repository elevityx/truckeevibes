// A13 (AC-M1-127, 128, 128b, 133-adapter): the Tahoe Donner adapter over a fake network and the saved/derived fixtures.
import { describe, expect, it } from 'vitest';
import { adapter } from './htmlTahoeDonner';
import { createPoliteFetch, FetchError } from '../core/politeFetch';
import { DESC_SENTINEL, fakeNet, fixture, makeClock, redirect, source, text } from '../testing/fakes';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const BASE = 'https://www.tahoedonner.com';
const ROBOTS = fixture('tahoedonner/robots.txt');
const html = (b: string, status = 200) => new Response(b, { status, headers: { 'content-type': 'text/html' } });
const fx = (n: string) => fixture(`tahoedonner/${n}`);

interface Over { list?: string; lists?: Record<string, string | Response>; details?: Record<string, string | Response>; config?: Record<string, unknown>; pageCap?: number }
function setup(o: Over = {}) {
  const clock = makeClock(NOW);
  const lists: Record<string, string | Response> = { '94': fx('list_family.html'), '180': fx('list_kids.html'), '95': fx('list_music.html'), ...o.lists };
  const net = fakeNet((u) => {
    if (u.pathname === '/robots.txt') return text(ROBOTS);
    if (u.pathname === '/events/') {
      const c = u.searchParams.get('categories[]');
      if (c) { const r = lists[c]; return r === undefined ? text('nf', 404) : typeof r === 'string' ? html(r) : r.clone(); }
      return html(o.list ?? fx('list.html'));
    }
    const m = /^\/events\/([a-z0-9-]+)\/$/.exec(u.pathname);
    if (m) {
      const d = o.details?.[m[1]];
      if (d !== undefined) return typeof d === 'string' ? html(d) : d.clone();
      try { return html(fx(`detail_${m[1]}.html`)); } catch { return text('nf', 404); }
    }
    return text('nf', 404);
  }, clock.now);
  const src = source({
    slug: 'tahoe-donner', family: 'html_tahoedonner', allowed_hosts: ['www.tahoedonner.com'], allowed_methods: ['html'], page_cap: o.pageCap ?? 45,
    config: { listUrl: `${BASE}/events/`, tz: 'America/Los_Angeles', ...o.config },
  });
  const pf = createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
  const run = () => adapter.fetch({ source: src, fetch: pf, now: new Date(NOW) });
  return { run, net, clock, src };
}
const by = (items: { title: string }[]) => Object.fromEntries(items.map((i) => [i.title, i]));

describe('identity', () => {
  it('is the html_tahoedonner family', () => {
    expect(adapter.family).toBe('html_tahoedonner');
    expect(adapter.version).toBe('html_tahoedonner.1');
  });
});

describe('AC-M1-127 (r6) happy path', () => {
  it('requests robots, /events/, the three hint lists, then the 14 details, >= 5000 ms apart; no category 126, no feed', async () => {
    const s = setup();
    await s.run();
    const urls = s.net.urls();
    expect(urls.slice(0, 5)).toEqual([`${BASE}/robots.txt`, `${BASE}/events/`, `${BASE}/events/?categories%5B%5D=94`, `${BASE}/events/?categories%5B%5D=180`, `${BASE}/events/?categories%5B%5D=95`]);
    expect(urls).toHaveLength(5 + 14);
    expect(urls[5]).toBe(`${BASE}/events/family-movie-night/`);
    expect(urls.some((u) => u.includes('126') || u.includes('/feed') || u.includes('action~'))).toBe(false);
    const at = s.net.calls.map((c) => c.at);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(5000);
  });
  it('yields 8 items, filtered 6 (long_range 2, series_unsupported 4)', async () => {
    const r = await setup().run();
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.items).toHaveLength(8);
    expect(r.filtered).toBe(6);
    expect(r.filteredBy).toEqual({ long_range: 2, series_unsupported: 4 });
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.items.map((i) => i.title).sort()).toEqual([
      'December 18, 2026 Regular Board Meeting', 'Light Up the Night', 'New Year’s Eve Guided Snowshoe Tour', 'New Year’s Eve Light Parade + Fireworks Show',
      'November 20, 2026 Regular Board Meeting', 'October 30, 2026 Regular Board Meeting', 'Ski + Ride With Santa', 'Thanksgiving Three-Course Plated Dinner at The Lodge',
    ]);
  });
  it('series headers drop as series_unsupported in every fixture, never for membership; body dates are never read', async () => {
    const r = await setup().run();
    const titles = r.items.map((i) => i.title);
    for (const t of ['Edi-Bōl Dinner Series', 'Prime Rib Saturdays', 'Family Movie Night', 'Member Sundays']) expect(titles).not.toContain(t);
    const edi = fx('detail_edi-bol-dinner-series.html');
    expect(edi).toContain('Thursdays starting Oct. 22, 2026');
  });
  it('spot checks', async () => {
    const m = by((await setup().run()).items);
    const lun = m['Light Up the Night'];
    expect(lun).toMatchObject({
      startsAt: '2026-11-29T01:00:00Z', externalKey: 'td:76393#2026-11-28', url: `${BASE}/events/light-up-the-night/`, allDay: false, timeKnown: true,
      venueName: 'The Lodge Restaurant & Pub', address: '12850 Northwoods Blvd, Truckee, CA 96161', town: 'Truckee', tz: 'America/Los_Angeles',
    });
    expect(lun.endsAt).toBeUndefined();
    expect(lun.categoriesHint).toContain('family');
    expect(lun.seriesUid).toBeUndefined();
    const parade = m['New Year’s Eve Light Parade + Fireworks Show'];
    expect(parade).toMatchObject({ startsAt: '2027-01-01T02:15:00Z', address: '11603 Slalom Way, Truckee, CA 96161' });
    expect(parade.categoriesHint).toContain('outdoors');
    const snow = m['New Year’s Eve Guided Snowshoe Tour'];
    expect(snow).toMatchObject({ startsAt: '2027-01-01T01:30:00Z', endsAt: '2027-01-01T04:00:00Z' });
    expect(snow.categoriesHint).toContain('outdoors');
    expect(m['Ski + Ride With Santa'].startsAt).toBe('2026-12-25T19:30:00Z');
    const board = m['October 30, 2026 Regular Board Meeting'];
    expect(board).toMatchObject({ venueName: 'Tahoe Donner Northwoods Clubhouse', address: '11509 Northwoods Blvd, Truckee, CA 96161', startsAt: '2026-10-30T16:00:00Z' });
    expect(Object.values(m).some((i) => i.allDay)).toBe(false);
  });
  it('no item carries description text, and every item keeps the SourceEvent shape', async () => {
    const r = await setup().run();
    const s = JSON.stringify(r.items);
    expect(s).not.toContain('sample guest');
    expect(s).not.toContain(DESC_SENTINEL);
    for (const i of r.items) expect(i.rawSummaryLength).toBeGreaterThan(0);
  });
  it('the classifier input is capped at 4,000 chars (rawSummaryLength <= 4000) after the decision', async () => {
    const big = fx('detail_light-up-the-night.html').replace('</section>', `<p>${'Plain words for the sample. '.repeat(400)}</p></section>`);
    const r = await setup({ details: { 'light-up-the-night': big } }).run();
    const lun = by(r.items)['Light Up the Night'];
    expect(lun.rawSummaryLength).toBeLessThanOrEqual(4000);
    expect(lun.rawSummaryLength).toBeGreaterThan(3000);
  });
});

describe('AC-M1-124 (r6) badge through the adapter', () => {
  it('the real fixtures carry no badge (0 real items)', async () => {
    const r = await setup().run();
    expect(r.items.filter((i) => i.categoriesHint.includes('members-only'))).toHaveLength(0);
  });
  it('a derived members-only sentence on a single-day event sets the category and cat:source_map', async () => {
    const d = fx('detail_light-up-the-night.html').replace('</section>', '<p>This event is for members only.</p></section>');
    const r = await setup({ details: { 'light-up-the-night': d } }).run();
    const lun = by(r.items)['Light Up the Night'];
    expect(lun.categoriesHint).toContain('members-only');
    expect(lun.tagReasons).toContain('cat:source_map');
    expect(r.items).toHaveLength(8);
  });
  it('a comment in the markup is not description text', async () => {
    const d = fx('detail_light-up-the-night.html');
    expect(d).toContain('Members only event.');
    expect(by((await setup().run()).items)['Light Up the Night'].categoriesHint).not.toContain('members-only');
  });
  it('the members-only variants of the weekly pages still drop as series_unsupported, never for membership', async () => {
    const r = await setup({ details: { 'member-sundays': fx('detail_member-sundays_membersonly.html'), 'family-movie-night': fx('detail_family-movie-night_membersonly.html') } }).run();
    expect(r.items).toHaveLength(8);
    expect(r.filteredBy).toEqual({ long_range: 2, series_unsupported: 4 });
  });
  it('a members-only title is labeled but still included', async () => {
    const d = fx('detail_light-up-the-night.html').replace('<h1>Light Up the Night</h1>', '<h1>Members Only Light Up the Night</h1>');
    const r = await setup({ details: { 'light-up-the-night': d } }).run();
    const it = r.items.find((i) => i.title.startsWith('Members Only'))!;
    expect(it.categoriesHint).toContain('members-only');
  });
});

describe('AC-M1-125 (r6) series and ranges through the adapter', () => {
  it('Edi-Bol (header Every Thu Oct - Nov, body "Thursdays starting Oct. 22, 2026") yields 0 items, series_unsupported', async () => {
    const r = await setup().run();
    expect(r.items.some((i) => i.externalKey.startsWith('td:78916'))).toBe(false);
    expect(r.filteredBy?.series_unsupported).toBe(4);
  });
  it('a 3-day range yields 3 items sharing a seriesUid', async () => {
    const d = fx('detail_light-up-the-night.html').replace('Nov 28, 2026', 'Nov 27, 2026 - Nov 29, 2026');
    const r = await setup({ details: { 'light-up-the-night': d } }).run();
    const items = r.items.filter((i) => i.externalKey.startsWith('td:76393#'));
    expect(items.map((i) => i.externalKey)).toEqual(['td:76393#2026-11-27', 'td:76393#2026-11-28', 'td:76393#2026-11-29']);
    expect(new Set(items.map((i) => i.seriesUid))).toEqual(new Set(['td:76393']));
  });
  it('date_unparsed, no_time and out_of_window are counted', async () => {
    const lun = fx('detail_light-up-the-night.html');
    const r = await setup({ details: {
      'light-up-the-night': lun.replace('Nov 28, 2026', 'TBD'),
      'ski-with-santa': fx('detail_ski-with-santa.html').replace('Lifts open at 11:30AM', 'All day'),
      'thanksgiving-three-course-plated-dinner': fx('detail_thanksgiving-three-course-plated-dinner.html').replace('Nov 26, 2026', 'Nov 26, 2024'),
    } }).run();
    expect(r.items).toHaveLength(5);
    expect(r.filteredBy).toEqual({ long_range: 2, series_unsupported: 4, date_unparsed: 1, no_time: 1, out_of_window: 1 });
    expect(r.filtered).toBe(9);
  });
  it('a description over 20,000 chars drops the event as oversize', async () => {
    const d = fx('detail_light-up-the-night.html').replace('</section>', `<p>${'x '.repeat(10_500)}</p></section>`);
    const r = await setup({ details: { 'light-up-the-night': d } }).run();
    expect(r.items.some((i) => i.title === 'Light Up the Night')).toBe(false);
    expect(r.filteredBy?.oversize).toBe(1);
  });
});

describe('no member/public filter (r4) and unknown venues', () => {
  it('an event at "Golf Course" is submitted with the meta text as its venue, town Truckee and no address', async () => {
    const d = fx('detail_light-up-the-night.html').replace('The Lodge Pavilion', 'Golf Course');
    const r = await setup({ details: { 'light-up-the-night': d } }).run();
    const it = by(r.items)['Light Up the Night'];
    expect(it).toMatchObject({ venueName: 'Golf Course', town: 'Truckee' });
    expect(it.address).toBeUndefined();
  });
});

describe('AC-M1-128 fail closed', () => {
  const code = async (o: Over) => setup(o).run().then((r) => `${r.status}:${r.errorCode ?? ''}:${r.items.length}`, (e: Error) => e.message);
  it('list without #sdbx-events -> layout_changed', async () => expect(await code({ list: fx('list_no_container.html') })).toBe('parse_error:layout_changed:0'));
  it('a list without </html> -> layout_changed', async () => expect(await code({ list: fx('list.html').replace('</html>', '') })).toBe('parse_error:layout_changed:0'));
  it('main list 503 -> http_error', async () => {
    const clock = makeClock(NOW);
    const net = fakeNet((u) => (u.pathname === '/robots.txt' ? text(ROBOTS) : html('busy', 503)), clock.now);
    const src = source({ slug: 'tahoe-donner', family: 'html_tahoedonner', allowed_hosts: ['www.tahoedonner.com'], allowed_methods: ['html'], page_cap: 45, config: { listUrl: `${BASE}/events/` } });
    const r = await adapter.fetch({ source: src, fetch: createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep }), now: new Date(NOW) });
    expect(`${r.status}:${r.httpStatus}:${r.items.length}`).toBe('http_error:503:0');
  });
  it('one detail 404 -> http_error, 0 items', async () => expect(await code({ details: { 'light-up-the-night': text('gone', 404) } })).toBe('http_error::0'));
  it('detail_no_date -> layout_changed', async () => expect(await code({ details: { 'light-up-the-night': fx('detail_no_date.html') } })).toBe('parse_error:layout_changed:0'));
  it('detail_postid_mismatch -> layout_changed', async () => expect(await code({ details: { 'light-up-the-night': fx('detail_postid_mismatch.html') } })).toBe('parse_error:layout_changed:0'));
  it('a detail without </html> -> layout_changed', async () => expect(await code({ details: { 'light-up-the-night': fx('detail_light-up-the-night.html').replace('</html>', '') } })).toBe('parse_error:layout_changed:0'));
  it('a list block whose link is https://evil.example/events/x/ -> layout_changed', async () => {
    const bad = fx('list.html').replace(`${BASE}/events/light-up-the-night/`, 'https://evil.example/events/x/');
    expect(await code({ list: bad })).toBe('parse_error:layout_changed:0');
  });
  it('a list block missing its excerpt id or title -> layout_changed', async () => {
    expect(await code({ list: fx('list.html').replace('id="event-76393-excerpt"', 'id="x"') })).toBe('parse_error:layout_changed:0');
    expect(await code({ list: fx('list.html').replace('<h2>Light Up the Night</h2>', '<h2></h2>') })).toBe('parse_error:layout_changed:0');
  });
  it('36 list blocks -> too_many_events', async () => {
    const one = /<div class="event event-odd"[\s\S]*?See More<\/button><\/a>\s*<\/div>\s*<\/div>/.exec(fx('list.html'))![0];
    const many = Array.from({ length: 36 }, (_, i) => one.replace(/light-up-the-night|family-movie-night/g, `ev-${i}`).replace(/event-\d+-excerpt/, `event-${1000 + i}-excerpt`)).join('\n');
    const page = `<html><body><div id="sdbx-events">${many}</div></body></html>`;
    expect(await code({ list: page })).toBe('parse_error:too_many_events:0');
  });
  it('a 1.2 MB detail -> page_too_large', async () => {
    const big = fx('detail_light-up-the-night.html').replace('</section>', `<!-- ${'x'.repeat(1_200_000)} --></section>`);
    expect(await code({ details: { 'light-up-the-night': big } })).toBe('parse_error:page_too_large:0');
  });
  it('config listUrl other than /events/ -> config_listUrl_unknown', async () => {
    await expect(setup({ config: { listUrl: `${BASE}/calendar/` } }).run()).rejects.toThrow('config_listUrl_unknown');
    await expect(setup({ config: { listUrl: undefined } }).run()).rejects.toThrow('config_listUrl_unknown');
  });
  it('an empty list is an empty run (the DB found_zero guard holds it)', async () => {
    const r = await setup({ list: fx('list_kids.html') }).run();
    expect(r.status).toBe('ok');
    expect(r.items).toEqual([]);
  });
  it('a FetchError from the polite layer propagates (robots_blocked)', async () => {
    const clock = makeClock(NOW);
    const net = fakeNet((u) => (u.pathname === '/robots.txt' ? text('User-agent: *\nDisallow: /events/\n') : html('x')), clock.now);
    const src = source({ slug: 'tahoe-donner', family: 'html_tahoedonner', allowed_hosts: ['www.tahoedonner.com'], allowed_methods: ['html'], page_cap: 45, config: { listUrl: `${BASE}/events/` } });
    const pf = createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
    await expect(adapter.fetch({ source: src, fetch: pf, now: new Date(NOW) })).rejects.toBeInstanceOf(FetchError);
    expect(net.urls()).toEqual([`${BASE}/robots.txt`]);
  });
});

describe('AC-M1-128b (r4) hint-list contract', () => {
  const lun = (items: { title: string; categoriesHint: string[] }[]) => items.find((i) => i.title === 'Light Up the Night')!;
  it('hint list 94 identical to the main list -> no family hints, run ok', async () => {
    const r = await setup({ lists: { '94': fx('list.html') } }).run();
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(8);
    expect(lun(r.items).categoriesHint).not.toContain('family');
  });
  it('hint list redirecting to the unfiltered /events/ (finalUrl differs) -> ignored', async () => {
    const r = await setup({ lists: { '94': redirect(`${BASE}/events/`, 302) } }).run();
    expect(r.status).toBe('ok');
    expect(lun(r.items).categoriesHint).not.toContain('family');
  });
  it('hint list that is not a subset (an unknown URL) is ignored', async () => {
    const odd = fx('list_family.html').replace('light-up-the-night', 'something-else');
    const r = await setup({ lists: { '94': odd } }).run();
    expect(lun(r.items).categoriesHint).not.toContain('family');
  });
  it('hint list without </html>, a 503, or no container is ignored; the run continues', async () => {
    for (const bad of [fx('list_family.html').replace('</html>', ''), html('busy', 503), fx('list_no_container.html')]) {
      const r = await setup({ lists: { '94': bad } }).run();
      expect(r.status).toBe('ok');
      expect(r.items).toHaveLength(8);
      expect(lun(r.items).categoriesHint).not.toContain('family');
    }
  });
  it('empty kids and music lists give no hints; the family list gives the family hint', async () => {
    const r = await setup().run();
    expect(lun(r.items).categoriesHint).toContain('family');
    expect(r.items.filter((i) => i.categoriesHint.includes('kids'))).toHaveLength(0);
  });
  it('a kids list that is a valid strict subset adds the kids hint to its events', async () => {
    const r = await setup({ lists: { '180': fx('list_family.html') } }).run();
    expect(lun(r.items).categoriesHint).toContain('kids');
  });
});
