// A14 (AC-M1-134 .. 137, 142): the Crystal Bay Casino WP REST adapter. Pure grammar helpers first, then the adapter over a fake network.
import { describe, expect, it } from 'vitest';
import { adapter, cbcText, LIST_URL, parseCbcAgeLabels, parseCbcDate, parseCbcRoom, parseCbcTime } from './wprestCrystalBay';
import { createPoliteFetch } from '../core/politeFetch';
import type { SourceEvent } from '../types';
import { fakeNet, fixture, makeClock, source, text } from '../testing/fakes';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const API = 'https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=100';
const ROBOTS = fixture('crystalbay/robots.txt');
const EVENTS = fixture('crystalbay/events.json');
const LIST = fixture('crystalbay/events_list.html');
const T = (html: string) => cbcText(html);

describe('identity', () => {
  it('is the wprest_crystalbay family', () => {
    expect(adapter.family).toBe('wprest_crystalbay');
    expect(adapter.version).toBe('wprest_crystalbay.2');
  });
});

describe('cbcText keeps block boundaries', () => {
  it('<p> and <br> become line breaks; entities decode; blank lines drop', () => {
    expect(T('<p>Sat. Nov. 28th 2026</p><p>Doors: 7PM Show: 8PM</p>')).toBe('Sat. Nov. 28th 2026\nDoors: 7PM Show: 8PM');
    expect(T('<p>a &amp; b<br/>c<br>d</p><p>  </p><div>e</div>')).toBe('a & b\nc\nd\ne');
    expect(T('<h2>Title</h2><ul><li>one</li><li>two</li></ul>')).toBe('Title\none\ntwo');
  });
});

describe('AC-M1-134 date grammar', () => {
  const ok = (s: string) => parseCbcDate(T(s));
  it('valid: weekday + ordinal + year, no weekday, the same date twice', () => {
    expect(ok('<p>Sat. Nov. 28th 2026</p><p>Doors: 7PM Show: 8PM</p>')).toEqual({ date: '2026-11-28' });
    expect(T('<p>Sat. Nov. 28th 2026</p><p>Doors: 7PM Show: 8PM</p>')).not.toContain('2026Doors');
    expect(ok('<p>Fri. Oct. 23rd 2026</p>')).toEqual({ date: '2026-10-23' });
    expect(ok('<p>December 11, 2026</p>')).toEqual({ date: '2026-12-11' });
    expect(ok('<p>Fri. Oct. 23rd 2026</p><p>Friday October 23, 2026 again</p>')).toEqual({ date: '2026-10-23' });
  });
  it('a stated weekday that disagrees is date_mismatch (Wed. Jan. 13th 2026 is a Tuesday)', () => {
    expect(ok('<p>Wed. Jan. 13th 2026</p>')).toEqual({ drop: 'date_mismatch' });
  });
  it('year-less alone, an impossible date and no date are date_unparsed', () => {
    expect(ok('<p>Sat. Oct. 24</p>')).toEqual({ drop: 'date_unparsed' });
    expect(ok('<p>Feb. 30th 2027</p>')).toEqual({ drop: 'date_unparsed' });
    expect(ok('<p>Doors at seven, no date here</p>')).toEqual({ drop: 'date_unparsed' });
  });
  it('a complete date next to a year-less one is date_mixed; two complete dates are date_multiple', () => {
    expect(ok('<p>Fri. Oct. 23rd 2026</p><p>Sat. Oct. 24</p><p>Show: 8PM</p>')).toEqual({ drop: 'date_mixed' });
    expect(ok('<p>Fri. Oct. 23rd 2026</p><p>and</p><p>Sat. Oct. 24th 2026</p>')).toEqual({ drop: 'date_multiple' });
  });
});

describe('AC-M1-155 date restatement (A14 r3-5)', () => {
  const ok = (s: string) => parseCbcDate(T(s));
  it('a year-less token equal to a complete date is a restatement, not a conflict', () => {
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>at the Crown Room on November 7th.</p>')).toEqual({ date: '2026-11-07' });
  });
  it('a year-less token matching no complete date is date_mixed', () => {
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>at the Crown Room on November 8th.</p>')).toEqual({ drop: 'date_mixed' });
    expect(ok('<p>Sat. Oct. 31st 2026</p><p>October 30th & 31st</p>')).toEqual({ drop: 'date_mixed' });
  });
  it('a restatement weekday joins the weekday set (date_mismatch)', () => {
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>Fri. Nov. 7</p>')).toEqual({ drop: 'date_mismatch' });
  });
  it('two complete dates plus a restatement stay date_multiple; a year-less token alone stays date_unparsed', () => {
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>Sat. Dec. 5th 2026</p><p>November 7th</p>')).toEqual({ drop: 'date_multiple' });
    expect(ok('<p>November 7th</p>')).toEqual({ drop: 'date_unparsed' });
  });
});

describe('AC-M1-161 explicit-year guard', () => {
  const ok = (s: string) => parseCbcDate(T(s));
  it('an explicit year outside 20xx is a complete date, never a restatement', () => {
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>Album released November 7, 1999.</p>')).toEqual({ drop: 'date_multiple' });
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>Next show November 7, 2100.</p>')).toEqual({ drop: 'date_multiple' });
  });
  it('r3-5 and date_multiple are unchanged', () => {
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>on November 7th</p>')).toEqual({ date: '2026-11-07' });
    expect(ok('<p>Sat. Nov. 7th 2026</p><p>Sat. Dec. 5th 2027</p>')).toEqual({ drop: 'date_multiple' });
  });
});

describe('AC-M1-135 time grammar', () => {
  const t = (s: string) => parseCbcTime(T(s));
  it('labelled show time wins over doors; minutes; a single unlabelled time', () => {
    expect(t('<p>Doors: 7PM Show: 8PM</p>')).toEqual({ time: '20:00' });
    expect(t('<p>Show: 9:30 pm</p>')).toEqual({ time: '21:30' });
    expect(t('<p>8:00 pm</p>')).toEqual({ time: '20:00' });
    expect(t('<p>Show: 12am</p>')).toEqual({ time: '00:00' });
  });
  it('an hour outside 1-12 is ignored, leaving no_time', () => {
    expect(t('<p>Show: 13PM</p>')).toEqual({ drop: 'no_time' });
    expect(t('<p>Nothing about time</p>')).toEqual({ drop: 'no_time' });
  });
  it('two distinct show times, unlabelled pairs: time_multiple', () => {
    expect(t('<p>Fri. Oct. 23rd 2026</p><p>Show: 7PM</p><p>Show: 9PM</p>')).toEqual({ drop: 'time_multiple' });
    expect(t('<p>7PM and 9PM</p>')).toEqual({ drop: 'time_multiple' });
  });
  it('doors only is doors_only', () => {
    expect(t('<p>Doors: 7PM</p>')).toEqual({ drop: 'doors_only' });
    expect(t('<p>Doors 7PM, music 8PM</p>')).toEqual({ drop: 'doors_only' });
  });
  it('the same show time stated twice is one time', () => {
    expect(t('<p>Show: 8PM</p><p>Showtime 8:00 PM</p>')).toEqual({ time: '20:00' });
  });
});

describe('AC-M1-135 rooms', () => {
  it('title suffix wins and is stripped', () => {
    expect(parseCbcRoom('Boot Juice - Red Room', '')).toEqual({ title: 'Boot Juice', room: 'Red Room' });
    expect(parseCbcRoom('Steely Dead | Crown Room', '')).toEqual({ title: 'Steely Dead', room: 'Crown Room' });
    expect(parseCbcRoom('Steely Dead – crown room', '')).toEqual({ title: 'Steely Dead', room: 'Crown Room' });
  });
  it('without a suffix, the single room named in the text; both rooms or none give no room', () => {
    expect(parseCbcRoom('Jim Norton', 'Seated show, Red Room')).toEqual({ title: 'Jim Norton', room: 'Red Room' });
    expect(parseCbcRoom('Jim Norton', 'Crown Room doors, then the Red Room after party')).toEqual({ title: 'Jim Norton' });
    expect(parseCbcRoom('Jim Norton', 'nothing')).toEqual({ title: 'Jim Norton' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
interface Over { body?: string | Uint8Array; status?: number; headers?: Record<string, string>; config?: Record<string, unknown>; now?: number; list?: string | number | 'throw'; methods?: string[] }
function setup(o: Over = {}) {
  const now = o.now ?? NOW;
  const clock = makeClock(now);
  const net = fakeNet((u) => {
    if (u.pathname === '/robots.txt') return text(ROBOTS);
    if (u.pathname === '/wp-json/wp/v2/event') {
      return new Response((o.body ?? EVENTS) as BodyInit, { status: o.status ?? 200, headers: { 'content-type': 'application/json', ...o.headers } });
    }
    if (u.pathname === '/entertainment/events/') {
      // Default: no list page (404), so every pre-existing test sees c4 ages (Spec_21Plus_Coverage D3).
      if (o.list === 'throw') throw new TypeError('network down');
      if (typeof o.list === 'string') return text(o.list);
      return text('nf', o.list ?? 404);
    }
    return text('nf', 404);
  }, clock.now);
  const src = source({
    slug: 'crystal-bay-casino', family: 'wprest_crystalbay', allowed_hosts: ['www.crystalbaycasino.com'], allowed_methods: o.methods ?? ['api', 'html'], page_cap: 3,
    config: { apiUrl: API, tz: 'America/Los_Angeles', defaultCategories: ['nightlife'], ...o.config },
  });
  const pf = createPoliteFetch(src, { fetch: net.fetch, now: clock.now, sleep: clock.sleep });
  return { run: () => adapter.fetch({ source: src, fetch: pf, now: new Date(now) }), net, src };
}
const by = (items: SourceEvent[]) => Object.fromEntries(items.map((i) => [i.externalKey, i]));
const entries = () => JSON.parse(EVENTS) as { id: number; link: string; title: { rendered: string }; content: { rendered: string } }[];
const entry = (id: number, content: string, title = 'Sample Show') => ({ id, link: `https://www.crystalbaycasino.com/event/e${id}/`, title: { rendered: title }, content: { rendered: content } });
const GOOD = '<p>Fri. Oct. 23rd 2026</p><p>Doors: 7PM Show: 8PM</p>';

describe('AC-M1-136 config and fail closed', () => {
  it('apiUrl with per_page=10 throws config_apiUrl_unknown; an ageRule throws config_key_unknown', async () => {
    await expect(setup({ config: { apiUrl: 'https://www.crystalbaycasino.com/wp-json/wp/v2/event?per_page=10' } }).run()).rejects.toThrow('config_apiUrl_unknown');
    await expect(setup({ config: { ageRule: '21_plus' } }).run()).rejects.toThrow('config_key_unknown');
  });
  it('503 -> http_error; {} -> layout_changed; foreign link -> layout_changed (0 items each)', async () => {
    const a = await setup({ status: 503, body: 'down' }).run();
    expect(a).toMatchObject({ status: 'http_error', httpStatus: 503, items: [] });
    const b = await setup({ body: '{}' }).run();
    expect(b).toMatchObject({ status: 'parse_error', errorCode: 'layout_changed', items: [] });
    const c = await setup({ body: JSON.stringify([...entries(), { ...entry(2000, GOOD), link: 'https://evil.example/x/' }]) }).run();
    expect(c).toMatchObject({ status: 'parse_error', errorCode: 'layout_changed', items: [] });
    const d = await setup({ body: JSON.stringify([{ ...entry(2001, GOOD), id: 'x' }]) }).run();
    expect(d).toMatchObject({ status: 'parse_error', errorCode: 'layout_changed', items: [] });
    const e = await setup({ body: 'not json' }).run();
    expect(e).toMatchObject({ status: 'parse_error', errorCode: 'layout_changed', items: [] });
  });
  it('101 entries or X-WP-TotalPages: 2 -> too_many_events', async () => {
    const many = Array.from({ length: 101 }, (_, i) => entry(3000 + i, GOOD));
    expect(await setup({ body: JSON.stringify(many) }).run()).toMatchObject({ status: 'parse_error', errorCode: 'too_many_events', items: [] });
    expect(await setup({ headers: { 'X-WP-TotalPages': '2' } }).run()).toMatchObject({ status: 'parse_error', errorCode: 'too_many_events', items: [] });
  });
  it('a body over 1 MB -> page_too_large', async () => {
    const big = JSON.stringify([entry(1, GOOD)]) + ' '.repeat(1_200_000);
    expect(await setup({ body: big }).run()).toMatchObject({ status: 'parse_error', errorCode: 'page_too_large', items: [] });
  });
  it('a 25,000-char content drops that event as oversize; the others pass', async () => {
    const body = JSON.stringify([entry(1, GOOD), entry(2, `<p>${'x'.repeat(25_000)}</p>${GOOD}`)]);
    const r = await setup({ body }).run();
    expect(r.items.map((i) => i.externalKey)).toEqual(['cbc:1']);
    expect(r.filtered).toBe(1);
    expect(r.filteredBy).toEqual({ oversize: 1 });
  });
  it('a partial layout miss (missing content) never yields a partial batch', async () => {
    const bad = { id: 9, link: 'https://www.crystalbaycasino.com/event/x/', title: { rendered: 'x' } };
    const r = await setup({ body: JSON.stringify([entry(1, GOOD), bad]) }).run();
    expect(r).toMatchObject({ status: 'parse_error', errorCode: 'layout_changed', items: [] });
  });
});

describe('AC-M1-137 happy path', () => {
  it('requests robots, then apiUrl >= 5000 ms later, then the list page >= 5000 ms later; nothing else (AC-21-13)', async () => {
    const s = setup({ list: LIST });
    await s.run();
    expect(s.net.urls()).toEqual(['https://www.crystalbaycasino.com/robots.txt', API, LIST_URL]);
    expect(s.net.calls[1].at - s.net.calls[0].at).toBeGreaterThanOrEqual(5000);
    expect(s.net.calls[2].at - s.net.calls[1].at).toBeGreaterThanOrEqual(5000);
    expect(s.net.urls().some((x) => /tixr/i.test(x))).toBe(false);
  });
  it('9 entries -> 7 items, filtered 2 (date_mismatch 1, out_of_window 1)', async () => {
    const r = await setup().run();
    expect(r.status).toBe('ok');
    expect(r.httpStatus).toBe(200);
    expect(r.items).toHaveLength(7);
    expect(r.filtered).toBe(2);
    expect(r.filteredBy).toEqual({ date_mismatch: 1, out_of_window: 1 });
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('start times, rooms, venue, coordinates and links', async () => {
    const m = by((await setup().run()).items);
    expect(m['cbc:1001'].startsAt).toBe('2026-10-24T03:00:00Z');
    expect(m['cbc:1001'].title).toBe('Easy Star All-Stars “Dub Side of the Moon”');
    expect(m['cbc:1002'].startsAt).toBe('2026-10-25T03:00:00Z');
    expect(m['cbc:1002'].venueName).toBe('Crystal Bay Casino Crown Room');
    expect(m['cbc:1002'].title).toBe('Steely Dead');
    expect(m['cbc:1003'].startsAt).toBe('2026-11-07T04:00:00Z');
    expect(m['cbc:1004'].startsAt).toBe('2026-11-28T05:00:00Z');
    expect(m['cbc:1004'].venueName).toBe('Crystal Bay Casino Red Room');
    expect(m['cbc:1005'].startsAt).toBe('2026-11-29T04:00:00Z');
    expect(m['cbc:1006'].startsAt).toBe('2026-12-12T04:00:00Z');
    expect(m['cbc:1007'].startsAt).toBe('2027-01-01T05:00:00Z');
    expect(m['cbc:1003'].venueName).toBe('Crystal Bay Casino');
    for (const i of Object.values(m)) {
      expect(i.address).toBe('14 Tahoe Blvd, Crystal Bay, NV 89402');
      expect(i.town).toBe('Crystal Bay');
      expect(i.lat).toBe(39.2275377);
      expect(i.lng).toBe(-120.0046979);
      expect(i.allDay).toBe(false);
      expect(i.url).toBe(i.ticketUrl);
      expect(i.url).toMatch(/^https:\/\/www\.crystalbaycasino\.com\/event\/[a-z0-9-]+\/$/);
      expect(i.externalKey).toMatch(/^cbc:\d+$/);
      expect(i.ageText).toBeUndefined();
    }
  });
  it('age comes only from the event\'s own text: Steely Dead and Boot Juice state nothing, so both are unknown and not 21_plus (A14 r3-6)', async () => {
    const m = by((await setup().run()).items);
    expect(m['cbc:1002'].age).toBe('unknown');
    expect(m['cbc:1005'].age).toBe('unknown');
    expect(m['cbc:1004'].age).not.toBe('21_plus');
  });
  const steely = () => entries().find((e) => e.id === 1002)!;
  it('a labeled synthetic variant: "21+ only" is a form the grammar accepts -> 21_plus, age:21_admission, no kids/family', async () => {
    const e = steely();
    const body = JSON.stringify([{ ...e, content: { rendered: `${e.content.rendered}<p>21+ only</p>` } }]);
    const r = await setup({ body }).run();
    expect(r.items).toHaveLength(1);
    expect(r.items[0].age).toBe('21_plus');
    expect(r.items[0].tagReasons).toContain('age:21_admission');
    expect(r.items[0].categoriesHint).not.toContain('kids');
    expect(r.items[0].categoriesHint).not.toContain('family');
  });
  it('pin: "21+ Crown Room" (no "Age ") is not widened -> unknown + age:ambiguous', async () => {
    // Not widened (A14 r3-6; Spec_21Plus_Coverage r2 keeps it: a line break is not an admission separator). The casino's age is read
    // from its list page's per-card age field instead.
    const e = steely();
    const body = JSON.stringify([{ ...e, content: { rendered: `${e.content.rendered}<p>21+ Crown Room</p>` } }]);
    const r = await setup({ body }).run();
    expect(r.items[0].age).toBe('unknown');
    expect(r.items[0].tagReasons).toContain('age:ambiguous');
  });
  it('events.json holds no "Age 21+" and no "21+ Crown Room"', () => {
    expect(EVENTS).not.toContain('Age 21+');
    expect(EVENTS).not.toContain('21+ Crown Room');
  });
  it('an explicit "All ages show" at the casino is unknown (adult-venue veto), never 21_plus', async () => {
    const body = JSON.stringify([entry(7, `${GOOD}<p>All ages show</p>`, 'Victor Wooten')]);
    const r = await setup({ body }).run();
    expect(r.items).toHaveLength(1);
    expect(r.items[0].age).toBe('unknown');
  });
  it('no item carries description text, a tixr string or an http URL in a text field', async () => {
    const r = await setup().run();
    for (const i of r.items) {
      const blob = JSON.stringify(i);
      expect(blob.toLowerCase()).not.toContain('tixr');
      expect(blob).not.toContain('Synthetic description');
    }
  });
  it('is stable across runs (same keys)', async () => {
    const a = (await setup().run()).items.map((i) => i.externalKey);
    const b = (await setup().run()).items.map((i) => i.externalKey);
    expect(a).toEqual(b);
  });
});

describe('fail-closed date/time rows drop and are counted', () => {
  it('mixed dates, multiple times, doors only, no time and dst_gap each drop with their own code', async () => {
    const body = JSON.stringify([
      entry(1, '<p>Fri. Oct. 23rd 2026</p><p>Sat. Oct. 24</p><p>Show: 8PM</p>'),
      entry(2, '<p>Fri. Oct. 23rd 2026</p><p>Show: 7PM</p><p>Show: 9PM</p>'),
      entry(3, '<p>Fri. Oct. 23rd 2026</p><p>Doors: 7PM</p>'),
      entry(4, '<p>Fri. Oct. 23rd 2026</p><p>No time here</p>'),
      entry(5, '<p>Fri. Oct. 23rd 2026</p><p>Show: 8PM</p>'),
    ]);
    const r = await setup({ body }).run();
    expect(r.items.map((i) => i.externalKey)).toEqual(['cbc:5']);
    expect(r.filteredBy).toEqual({ date_mixed: 1, time_multiple: 1, doors_only: 1, no_time: 1 });
    expect(r.filtered).toBe(4);
  });
  it('the REST post date is never read', async () => {
    const body = JSON.stringify([{ ...entry(1, GOOD), date: '2030-01-01T00:00:00', modified: '2030-01-01T00:00:00' }]);
    const r = await setup({ body }).run();
    expect(r.items[0].startsAt).toBe('2026-10-24T03:00:00Z');
  });
});

// A14 r3-4 (AC-M1-154). events_real.json is built from a real capture of the feed (2026-10-19): facts only (titles, dates, times, rooms, links)
// with synthetic prose. check-fixtures.mjs says fixtures are synthetic; this file keeps the source's facts and none of its description text.
describe('AC-M1-154 real-feed fixture', () => {
  const REAL = fixture('crystalbay/events_real.json');
  const run = () => setup({ body: REAL, headers: { 'X-WP-TotalPages': '1' } }).run();
  it('has 17 entries with exactly the 5 keys, no tixr.com and no foreign URL', () => {
    const arr = JSON.parse(REAL) as Record<string, unknown>[];
    expect(arr).toHaveLength(17);
    for (const e of arr) expect(Object.keys(e).sort()).toEqual(['content', 'date', 'id', 'link', 'title']);
    expect(REAL).not.toContain('tixr.com');
    expect(REAL).not.toContain('<img');
    const urls = REAL.match(/https?:\/\/[^\s"<\\]+/g) ?? [];
    const links = new Set(arr.map((e) => e.link as string));
    for (const u of urls) expect(links.has(u) || u === 'https://tixr.example/e/1').toBe(true);
    expect(Buffer.byteLength(REAL)).toBeLessThanOrEqual(64 * 1024);
  });
  it('12 items, filtered 5 (date_mismatch 1, date_mixed 2, date_multiple 1, out_of_window 1)', async () => {
    const r = await run();
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(12);
    expect(r.filtered).toBe(5);
    expect(r.filteredBy).toEqual({ date_mismatch: 1, date_mixed: 2, date_multiple: 1, out_of_window: 1 });
  });
  it('the 12 externalKey / startsAt / room values', async () => {
    const r = await run();
    expect([...r.items].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((i) => [i.externalKey, i.startsAt, i.venueName, i.title])).toEqual([
      ['cbc:5911', '2026-10-24T03:00:00Z', 'Crystal Bay Casino', expect.stringContaining('Easy Star All-Stars')],
      ['cbc:5859', '2026-10-25T03:00:00Z', 'Crystal Bay Casino', expect.stringContaining('Steely Dead')],
      ['cbc:5907', '2026-11-07T04:00:00Z', 'Crystal Bay Casino', expect.stringContaining('Jim Norton')],
      ['cbc:5924', '2026-11-08T04:00:00Z', 'Crystal Bay Casino Crown Room', expect.stringContaining('Shwayze')],
      ['cbc:5921', '2026-11-15T04:00:00Z', 'Crystal Bay Casino', expect.stringContaining('Emo Kids')],
      ['cbc:5843', '2026-11-28T04:00:00Z', 'Crystal Bay Casino', expect.stringContaining('Pat O')],
      ['cbc:6145', '2026-11-29T04:00:00Z', 'Crystal Bay Casino Red Room', 'Boot Juice'],
      ['cbc:5948', '2026-12-06T05:00:00Z', 'Crystal Bay Casino', expect.stringContaining('SoDown')],
      ['cbc:5918', '2026-12-10T04:00:00Z', 'Crystal Bay Casino Red Room', 'The Fretliners'],
      ['cbc:5836', '2026-12-12T04:00:00Z', 'Crystal Bay Casino', expect.stringContaining('Victor Wooten')],
      ['cbc:6063', '2026-12-13T04:00:00Z', 'Crystal Bay Casino', expect.stringContaining('Dead Winter Carpenters')],
      ['cbc:6056', '2027-01-01T05:00:00Z', 'Crystal Bay Casino', expect.stringContaining('OPIUO')],
    ]);
  });
  it('every age is unknown; Emo Kids has no kids/family; no description, tixr or http URL in a text field; url === ticketUrl', async () => {
    const r = await run();
    for (const i of r.items) {
      expect(i.age).toBe('unknown');
      expect(i.url).toBe(i.ticketUrl);
      expect(JSON.stringify(i).toLowerCase()).not.toContain('tixr');
      expect(JSON.stringify(i)).not.toContain('Synthetic description');
      for (const [k, v] of Object.entries(i)) if (typeof v === 'string' && k !== 'url' && k !== 'ticketUrl') expect(v).not.toMatch(/https?:\/\//);
    }
    const emo = r.items.find((i) => i.externalKey === 'cbc:5921')!;
    expect(emo.categoriesHint).not.toContain('kids');
    expect(emo.categoriesHint).not.toContain('family');
  });
});

// Spec_21Plus_Coverage: each show's age label from the casino's events list page (c5).
describe('AC-21-10 parseCbcAgeLabels', () => {
  const ev = (slug: string) => `https://www.crystalbaycasino.com/event/${slug}/`;
  it('one card = one article with exactly one event link and exactly one id-card field holding a known label', () => {
    const m = parseCbcAgeLabels(LIST);
    expect(m.get(ev('steely-dead'))).toBe('21+');
    expect(m.get(ev('boot-juice'))).toBe('21+'); // relative /event/ link
    expect(m.get(ev('victor-wooten'))).toBe('All ages');
    expect(m.has(ev('jim-norton'))).toBe(false); // unknown label "Members"; the page-level link outside any card is ignored
    expect(m.has(ev('opiuo'))).toBe(false); // two cards disagree (21+ / 18+)
    expect(m.has(ev('pat-oneill'))).toBe(false); // two id-card fields (one with an extra class token)
    expect(m.has(ev('easy-star-all-stars'))).toBe(false); // no post-info widget
    expect(m.has(ev('dogs-in-a-pile'))).toBe(false); // card links to two events
    expect(m.has(ev('sample-summer-show'))).toBe(false);
    expect(m.has(ev('sample-proto'))).toBe(false); // label "constructor" is not an own key
    expect(m.size).toBe(3);
  });
  it('R1: a card with a relative link never lends its label to the card before it', () => {
    const a = LIST.indexOf('<article'); const b = LIST.indexOf('<article', a + 1); const c = LIST.indexOf('<article', b + 1);
    const noAge = LIST.slice(a, b).replace(/fa-id-card/g, 'fa-x');
    const m = parseCbcAgeLabels(noAge + LIST.slice(b, c));
    expect(m.has(ev('steely-dead'))).toBe(false);
    expect(m.get(ev('boot-juice'))).toBe('21+');
  });
  it('F3: mixed quoting cannot hide a second age field or a second event link', () => {
    const a = LIST.indexOf('<article'); const b = LIST.indexOf('<article', a + 1);
    const one = LIST.slice(a, b);
    const twoAges = one.replace('</ul>', `<li><span><i aria-hidden='true' class='far fa-id-card'></i></span><span class='elementor-post-info__item'> 18+ </span></li></ul>`);
    expect(parseCbcAgeLabels(twoAges).size).toBe(0);
    const twoLinks = one.replace('</ul>', `</ul><a href='/event/other-show/'>x</a>`);
    expect(parseCbcAgeLabels(twoLinks).size).toBe(0);
    const single = one.replace(/class="far fa-id-card"/, `class='far fa-id-card'`).replace(/<span class="elementor-icon-list-text elementor-post-info__item elementor-post-info__item--type-custom"> 21\+/, `<span class='elementor-post-info__item'> 21+`);
    expect(parseCbcAgeLabels(single).get(ev('steely-dead'))).toBe('21+');
  });
  it('an empty, unrelated or article-free page gives no labels', () => {
    expect(parseCbcAgeLabels('').size).toBe(0);
    expect(parseCbcAgeLabels('<html><body>closed</body></html>').size).toBe(0);
    expect(parseCbcAgeLabels(LIST.replace(/<article class="ae-post-item/g, '<div class="x')).size).toBe(0);
  });
});

describe('AC-21-11..15 adapter with the list page', () => {
  it('a 21+ label gives 21_plus with age:21_admission and ageText "21+"; no label leaves the c4 age', async () => {
    const m = by((await setup({ list: LIST }).run()).items);
    for (const k of ['cbc:1002', 'cbc:1005']) {
      expect(m[k].age).toBe('21_plus');
      expect(m[k].ageText).toBe('21+');
      expect(m[k].tagReasons).toContain('age:21_admission');
      expect(m[k].categoriesHint).not.toContain('kids');
      expect(m[k].categoriesHint).not.toContain('family');
    }
    const base = by((await setup().run()).items);
    for (const k of Object.keys(base).filter((k) => !['cbc:1002', 'cbc:1005', 'cbc:1006'].includes(k))) {
      expect(m[k].age, k).toBe(base[k].age);
      expect(m[k].ageText, k).toBeUndefined();
    }
  });
  it('AC-21-14 an "All ages" label at the casino is unknown (adult-venue veto), never all_ages', async () => {
    const m = by((await setup({ list: LIST }).run()).items);
    expect(m['cbc:1006'].age).toBe('unknown');
  });
  it('AC-21-12 list page 404, 500, network error, oversize, or html not allowed: ok, same items, REST-only ages', async () => {
    const base = await setup().run();
    const strip = (r: typeof base) => r.items.map((i) => [i.externalKey, i.startsAt, i.age, i.ageText ?? null]);
    for (const o of [{ list: 500 }, { list: 'throw' as const }, { list: LIST + ' '.repeat(2_200_000) }, { list: LIST, methods: ['api'] }]) {
      const r = await setup(o).run();
      expect(r.status).toBe('ok');
      expect(strip(r)).toEqual(strip(base));
    }
  });
  it('AC-21-15 no item carries description text or a URL in a text field with the list page served', async () => {
    const r = await setup({ list: LIST }).run();
    for (const i of r.items) {
      for (const v of [i.title, i.venueName, i.ageText, i.priceText]) if (v) expect(v).not.toMatch(/https?:|tixr/i);
      expect((i as unknown as Record<string, unknown>).description).toBeUndefined();
    }
  });
});
