// AC-W3-21 (Spec_Vibes_Widget W3.3 C7): the Lights <-> API comparator over fake Lights REST and fake API responses.
import { describe, expect, it } from 'vitest';
import { compareLights } from './compare-lights.mjs';

const NOW = Date.parse('2026-10-17T18:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const MIN = 60_000;
const REGION = '7a1e0000-0000-4000-8000-000000000001';
const ENV = { LIGHTS_REST_URL: 'https://x.supabase.co', LIGHTS_PUBLISHABLE_KEY: 'pk', VIBES_API_URL: 'https://api.test' };
const id = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const lrow = (i, over = {}) => ({
  id: id(i), region_id: REGION, season: 'halloween', year: 2026, title: `SYNTHETIC-TITLE-${i}`, description: 'A synthetic description.',
  venue: null, address: '1 Main St', lat: 39.3, lng: -120.2, starts_at: `2026-10-${10 + i}T02:00:00+00:00`, ends_at: null,
  url: null, adults_only: false, ...over,
});
const arow = (l, over = {}) => ({
  id: l.id, origin: 'lights', formerIds: [], pageUrl: null, title: l.title, description: l.description, summary: null,
  startsAt: new Date(l.starts_at).toISOString().replace(/\.\d{3}Z$/, 'Z'), endsAt: l.ends_at ? new Date(l.ends_at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
  allDay: false, startDate: null, endDate: null, timeKnown: true, venue: l.venue, address: l.address, town: null, lat: l.lat, lng: l.lng,
  categories: [], age: 'unknown', adultsOnly: l.adults_only, url: l.url, ticketUrl: null, ...over,
});
const vrow = (i) => ({ ...arow(lrow(1)), id: `11111111-0000-4000-8000-${String(i).padStart(12, '0')}`, origin: 'vibes', title: `SYNTHETIC-VIBES-${i}` });
const MIRROR = { state: 'confirmed', confirmedAt: iso(10 * MIN), heldSince: null, heldCount: 0 };
// pageComplete follows nextCursor (as the API sets it) unless a case overrides it
const page = (events, over = {}) => ({
  version: 1, scope: 'lights', season: 'halloween', year: 2026, stale: false, pageComplete: (over.nextCursor ?? null) === null, dataAt: iso(2 * MIN),
  mirror: MIRROR, region: { tz: 'America/Los_Angeles', localBox: {} }, count: events.length, nextCursor: null, events, attribution: {}, ...over,
});

/**
 * reads: one entry per comparison pass ({ lights, range, pages, ctx2 }); the second pass is the 6-minute re-check.
 * pages: array of API page bodies, page i+1 is requested with the cursor of page i.
 */
function world(reads) {
  let pass = 0;
  let ctxCalls = 0;
  const logs = [];
  const sleeps = [];
  const urls = [];
  const cur = () => reads[Math.min(pass, reads.length - 1)];
  const fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.startsWith(ENV.LIGHTS_REST_URL)) {
      if (u.includes('/rpc/get_region_context')) {
        ctxCalls++;
        const second = ctxCalls % 2 === 0;
        const c = second && cur().ctx2 ? cur().ctx2 : { region: { id: REGION, slug: 'truckee' }, season: 'halloween', year: 2026, events: { open: true } };
        return new Response(JSON.stringify(c), { status: 200 });
      }
      const rows = cur().lights;
      const range = cur().range ?? (rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0');
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-range': range } });
    }
    const p = new URL(u);
    expect(p.origin + p.pathname).toBe('https://api.test/api/v1/events');
    expect(p.searchParams.get('scope')).toBe('lights');
    expect(p.searchParams.get('season')).toBe('halloween');
    expect(p.searchParams.get('year')).toBe('2026');
    const n = p.searchParams.has('cursor') ? Number(p.searchParams.get('cursor').slice(1)) : 0;
    return new Response(JSON.stringify(cur().pages[n]), { status: 200 });
  };
  const sleep = async (ms) => { sleeps.push(ms); pass++; };
  return { logs, sleeps, urls, deps: { env: ENV, fetch, sleep, now: () => NOW + pass * 6 * MIN, log: (l) => logs.push(l) } };
}
const L3 = [lrow(1), lrow(2), lrow(3)];
const same = (over = {}) => ({ lights: L3, pages: [page(L3.map((l) => arow(l)))], ...over });
const LINE = /^compare: pair=halloween-2026 lights=\d+ api_lights=\d+ missing=\S* extra=\S* field_diff=\S* vibes_added=\d+ vibes_added_ids=\S* mirror=[a-z]+ confirmed_age_min=\S+ pages=\d+ result=(pass|mismatch|held|stale_mirror|transport)$/;
const noTitles = (logs) => { for (const l of logs) expect(l).not.toMatch(/SYNTHETIC/); };
const last = (w) => w.logs.filter((l) => l.startsWith('compare: pair='));

describe('AC-W3-21 compare-lights', () => {
  it('identical -> exit 0, result=pass, one read, no wait', async () => {
    const w = world([same()]);
    expect(await compareLights(w.deps)).toBe(0);
    expect(w.sleeps).toEqual([]);
    const lines = last(w);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(LINE);
    expect(lines[0]).toContain('lights=3 api_lights=3 missing= extra= field_diff= vibes_added=0 vibes_added_ids= mirror=confirmed confirmed_age_min=10 pages=1 result=pass');
    noTitles(w.logs);
  });
  it('sends the publishable key to Lights only, and nothing secret to the API', async () => {
    const w = world([same()]);
    await compareLights(w.deps);
    expect(w.urls.filter((u) => u.startsWith('https://x.supabase.co'))).toHaveLength(3);
  });
  it('vibes rows are reported as an added heads-up, not a failure', async () => {
    const w = world([same({ pages: [page([...L3.map((l) => arow(l)), vrow(1)])] })]);
    expect(await compareLights(w.deps)).toBe(0);
    expect(last(w)[0]).toContain(`vibes_added=1 vibes_added_ids=${vrow(1).id}`);
  });
  it('one missing id still missing after the re-check -> exit 1 listing the id', async () => {
    const r = same({ pages: [page([arow(L3[0]), arow(L3[1])])] });
    const w = world([r, r]);
    expect(await compareLights(w.deps)).toBe(1);
    expect(w.sleeps).toEqual([360_000]);
    const lines = last(w);
    expect(lines.at(-1)).toMatch(LINE);
    expect(lines.at(-1)).toContain(`missing=${id(3)} extra= field_diff=`);
    expect(lines.at(-1)).toContain('result=mismatch');
    noTitles(w.logs);
  });
  it('an extra id on the API -> exit 1 extra=<id>', async () => {
    const r = same({ pages: [page([...L3.map((l) => arow(l)), arow(lrow(4))])] });
    const w = world([r, r]);
    expect(await compareLights(w.deps)).toBe(1);
    expect(last(w).at(-1)).toContain(`extra=${id(4)}`);
  });
  it('a field diff (adultsOnly) -> exit 1 field_diff=<id>:adultsOnly', async () => {
    const r = same({ pages: [page([arow(L3[0]), arow(L3[1], { adultsOnly: true }), arow(L3[2])])] });
    const w = world([r, r]);
    expect(await compareLights(w.deps)).toBe(1);
    expect(last(w).at(-1)).toContain(`field_diff=${id(2)}:adultsOnly `);
    noTitles(w.logs);
  });
  it('every compared field is checked (title, description, venue, address, lat, lng, startsAt, endsAt, url)', async () => {
    for (const [k, v] of [['title', 'X'], ['description', 'Y'], ['venue', 'V'], ['address', 'A'], ['lat', 1], ['lng', 2],
      ['startsAt', '2026-01-01T00:00:00Z'], ['endsAt', '2026-01-01T00:00:00Z'], ['url', 'https://other.example/']]) {
      const r = same({ pages: [page([arow(L3[0], { [k]: v }), arow(L3[1]), arow(L3[2])])] });
      const w = world([r, r]);
      expect(await compareLights(w.deps), k).toBe(1);
      expect(last(w).at(-1)).toContain(`field_diff=${id(1)}:${k}`);
    }
  });
  it('startsAt compares instants (Lights +00:00 vs API Z) and is not a diff', async () => {
    const l = [lrow(1, { starts_at: '2026-10-20T09:30:00-07:00' })];
    const w = world([{ lights: l, pages: [page([arow(l[0])])] }]);
    expect(await compareLights(w.deps)).toBe(0);
  });
  it('a mismatch that clears on the re-check -> exit 0', async () => {
    const w = world([same({ pages: [page([arow(L3[0])])] }), same()]);
    expect(await compareLights(w.deps)).toBe(0);
    expect(w.sleeps).toEqual([360_000]);
    expect(last(w).at(-1)).toContain('result=pass');
  });
  it('identical sets but mirror.state held -> exit 3 (a held run is never a success)', async () => {
    const held = { state: 'held', confirmedAt: iso(10 * MIN), heldSince: iso(20 * MIN), heldCount: 4 };
    const r = same({ pages: [page(L3.map((l) => arow(l)), { mirror: held })] });
    const w = world([r, r]);
    expect(await compareLights(w.deps)).toBe(3);
    expect(w.logs.some((l) => /^compare: held count=4 since=\d{4}-\d{2}-\d{2}T[\d:]+Z$/.test(l))).toBe(true);
    expect(last(w).at(-1)).toContain('mirror=held');
    expect(last(w).at(-1)).toContain('result=held');
  });
  it('mirror.state none -> exit 4', async () => {
    const r = same({ pages: [page(L3.map((l) => arow(l)), { mirror: { state: 'none', confirmedAt: null, heldSince: null, heldCount: 0 } })] });
    expect(await compareLights(world([r, r]).deps)).toBe(4);
  });
  it('identical but confirmedAt 36 min old (on the final read) -> exit 4 stale_mirror', async () => {
    const m = { ...MIRROR, confirmedAt: iso(36 * MIN) };
    const r = same({ pages: [page(L3.map((l) => arow(l)), { mirror: m })] });
    const w = world([r, { ...r, pages: [page(L3.map((l) => arow(l)), { mirror: { ...MIRROR, confirmedAt: iso(36 * MIN) } })] }]);
    expect(await compareLights(w.deps)).toBe(4);
    expect(last(w).at(-1)).toContain('result=stale_mirror');
  });
  it('identical but dataAt 11 min old -> exit 4', async () => {
    const r = same({ pages: [page(L3.map((l) => arow(l)), { dataAt: iso(11 * MIN) })] });
    const w = world([r, { ...r, pages: [page(L3.map((l) => arow(l)), { dataAt: iso(11 * MIN + 6 * MIN) })] }]);
    expect(await compareLights(w.deps)).toBe(4);
  });
  it('identical but stale: true -> exit 2', async () => {
    const r = same({ pages: [page(L3.map((l) => arow(l)), { stale: true })] });
    expect(await compareLights(world([r, r]).deps)).toBe(2);
  });
  it('a page-5 nextCursor (not drained after 4 pages) -> exit 2', async () => {
    const pages = [0, 1, 2, 3].map((i) => page([arow(L3[0])], { nextCursor: `c${i + 1}`, pageComplete: false }));
    const r = { lights: L3, pages };
    const w = world([r, r]);
    expect(await compareLights(w.deps)).toBe(2);
    expect(w.urls.filter((u) => u.startsWith('https://api.test'))).toHaveLength(8);
    expect(last(w).at(-1)).toContain('result=transport');
  });
  it('drains a multi-page API (<= 4 pages) into one set', async () => {
    const pages = [page([arow(L3[0])], { nextCursor: 'c1' }), page([arow(L3[1])], { nextCursor: 'c2' }), page([arow(L3[2])])];
    const w = world([{ lights: L3, pages }]);
    expect(await compareLights(w.deps)).toBe(0);
    expect(last(w)[0]).toContain('pages=3 result=pass');
  });
  it('mirror differing between pages -> exit 2', async () => {
    const pages = [page([arow(L3[0])], { nextCursor: 'c1' }), page([arow(L3[1]), arow(L3[2])], { mirror: { ...MIRROR, confirmedAt: iso(5 * MIN) } })];
    const r = { lights: L3, pages };
    expect(await compareLights(world([r, r]).deps)).toBe(2);
  });
  it('a page that is not version 1 -> exit 2', async () => {
    const r = same({ pages: [page(L3.map((l) => arow(l)), { version: 2 })] });
    expect(await compareLights(world([r, r]).deps)).toBe(2);
  });
  it('Lights Content-Range short -> exit 2', async () => {
    const r = same({ range: '0-2/4' });
    expect(await compareLights(world([r, r]).deps)).toBe(2);
  });
  it('the Lights pair changes between the two context reads -> exit 2', async () => {
    const r = same({ ctx2: { region: { id: REGION, slug: 'truckee' }, season: 'christmas', year: 2026, events: { open: true } } });
    expect(await compareLights(world([r, r]).deps)).toBe(2);
  });
  it('missing env -> exit 2 with no request', async () => {
    const w = world([same()]);
    expect(await compareLights({ ...w.deps, env: { VIBES_API_URL: 'https://api.test' } })).toBe(2);
    expect(w.urls).toEqual([]);
  });
  // review fix 3: fail closed on an incomplete or duplicated API response
  it('pageComplete false with nextCursor null -> exit 2 (a page that denies completeness)', async () => {
    const r = same({ pages: [page(L3.map((l) => arow(l)), { pageComplete: false })] });
    expect(await compareLights(world([r, r]).deps)).toBe(2);
  });
  it('a missing nextCursor or pageComplete key -> exit 2', async () => {
    const p1 = page(L3.map((l) => arow(l)));
    delete p1.nextCursor;
    const p2 = page(L3.map((l) => arow(l)));
    delete p2.pageComplete;
    expect(await compareLights(world([{ lights: L3, pages: [p1] }, { lights: L3, pages: [p1] }]).deps)).toBe(2);
    expect(await compareLights(world([{ lights: L3, pages: [p2] }, { lights: L3, pages: [p2] }]).deps)).toBe(2);
  });
  it('pageComplete true with a nextCursor -> exit 2', async () => {
    const pages = [page([arow(L3[0])], { nextCursor: 'c1', pageComplete: true }), page([arow(L3[1]), arow(L3[2])])];
    expect(await compareLights(world([{ lights: L3, pages }, { lights: L3, pages }]).deps)).toBe(2);
  });
  it('one Lights row twice in the API response -> exit 1 field_diff=<id>:duplicate (not 1:1)', async () => {
    const r = same({ pages: [page([...L3.map((l) => arow(l)), arow(L3[1])])] });
    const w = world([r, r]);
    expect(await compareLights(w.deps)).toBe(1);
    expect(last(w).at(-1)).toContain(`${id(2)}:duplicate`);
    expect(last(w).at(-1)).toContain('result=mismatch');
  });
  it('a duplicate across two pages -> exit 1', async () => {
    const pages = [page([arow(L3[0]), arow(L3[1])], { nextCursor: 'c1', pageComplete: false }), page([arow(L3[1]), arow(L3[2])])];
    expect(await compareLights(world([{ lights: L3, pages }, { lights: L3, pages }]).deps)).toBe(1);
  });
  it('a duplicated Lights row id -> exit 2 (the Lights read is not a set)', async () => {
    const l = [lrow(1), lrow(2), lrow(2)];
    const r = { lights: l, pages: [page([arow(l[0]), arow(l[1])])] };
    expect(await compareLights(world([r, r]).deps)).toBe(2);
  });
});
