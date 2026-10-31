// Spec_Kids_Live Amendment K3 (AC-K3-04 .. 07): the Rec1 catalog mapper and the on-request read plan, over synthetic fixtures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SKIP_GROUP, availability, chooseTabs, collect, collectSessions, collectTabIds, extractPage, isBlocked, mapSessions, parseGroupAnswer, parseTabAnswer, toSession, parseAges, parseTimes, firstMeeting, runRead, type Rec1Config, type Session } from './rec1';

const FIX = join(__dirname, '..', 'fixtures', 'rec1');
const fx = (n: string) => readFileSync(join(FIX, n), 'utf8');
const NOW = new Date('2026-10-30T19:00:00Z');
const CFG: Rec1Config = {
  catalogUrl: 'https://secure.rec1.com/CA/tdrpd/catalog', tz: 'America/Los_Angeles', town: 'Truckee',
  venues: [
    { match: 'community pool|swimming pool|aquatic', name: 'Truckee Community Pool', address: '10939 Truckee Way, Truckee, CA 96161', lat: 39.3384825, lng: -120.1719775 },
    { match: 'rec(reation)? center|community center|steve randall|\\bcrc\\b', name: 'Truckee Community Recreation Center', address: '10981 Truckee Way, Truckee, CA 96161', lat: 39.3393187, lng: -120.1720436 },
  ],
};
const all = () => [...collectSessions(JSON.parse(fx('items-1001.json'))), ...collectSessions(JSON.parse(fx('items-1002.json')))];

describe('extractPage (AC-K3-06)', () => {
  it('reads the checkout key and the CSRF metas', () => {
    expect(extractPage(fx('catalog.html'))).toEqual({ key: '0123456789abcdef0123456789abcdef', csrfKey: '0123456789', csrfToken: 'abcdef0123456789abcdef0123456789' });
  });
  it('anything else is layout_changed', () => {
    expect(() => extractPage('<html>nothing</html>')).toThrow('layout_changed');
    expect(() => extractPage(fx('catalog.html').replace('0123456789abcdef0123456789abcdef', 'nothex'))).toThrow('layout_changed');
  });
});

describe('isBlocked (AC-K3-05)', () => {
  it('401/403/429 and challenge pages block; the normal page (with the reCAPTCHA script) does not', () => {
    for (const s of [401, 403, 429]) expect(isBlocked(s, '')).toBe(true);
    expect(isBlocked(200, '<html><div id="cf-chl-widget"></div></html>')).toBe(true);
    expect(isBlocked(200, '<title>Attention Required! | Cloudflare</title>')).toBe(true);
    expect(isBlocked(503, '<h1>Access denied</h1>')).toBe(true);
    expect(isBlocked(200, '<h1>Attention Required</h1>')).toBe(true);
    expect(isBlocked(200, fx('catalog.html'))).toBe(false);
    expect(isBlocked(200, fx('items-1001.json'))).toBe(false);
  });
});

describe('grammars', () => {
  it('ages', () => {
    expect(parseAges('5y - 8y')).toEqual({ min: 5, max: 8 });
    expect(parseAges('6y 0m - 12y 11m')).toEqual({ min: 6, max: 12 });
    expect(parseAges('Ages 3-5')).toEqual({ min: 3, max: 5 });
    expect(parseAges('18y and up')).toEqual({ min: 18, max: 99 });
    expect(parseAges('5+')).toEqual({ min: 5, max: 99 });
    expect(parseAges('Grades K-2')).toBeNull();
    expect(parseAges('Grades 1-3')).toBeNull();
    expect(parseAges('6-12 months')).toBeNull();
    expect(parseAges('5y - 8y or 18y and up')).toBeNull();
    expect(parseAges('5y - 8y Coed')).toEqual({ min: 5, max: 8 });
  });
  it('times', () => {
    expect(parseTimes('3:30 PM - 4:15 PM')).toEqual({ start: '15:30', end: '16:15' });
    expect(parseTimes('9:00am-12:00pm')).toEqual({ start: '09:00', end: '12:00' });
    expect(parseTimes('3:30-4:30 PM')).toEqual({ start: '15:30', end: '16:30' });
    expect(parseTimes('12:00 AM - 1:00 AM')).toEqual({ start: '00:00', end: '01:00' });
    expect(parseTimes('TBA')).toBeNull();
  });
  it('first meeting honours the days and infers the year', () => {
    expect(firstMeeting('11/09/2026 - 12/14/2026', 'Mon, Wed', '2026-10-30')).toEqual({ date: '2026-11-09', multi: true });
    expect(firstMeeting('11/10/2026 - 12/01/2026', 'Wed', '2026-10-30')).toEqual({ date: '2026-11-11', multi: true });
    expect(firstMeeting('11/23 - 11/25', 'Mon-Wed', '2026-10-30')).toEqual({ date: '2026-11-23', multi: true });
    expect(firstMeeting('01/05 - 02/09', 'Tue', '2026-10-30')).toEqual({ date: '2027-01-05', multi: true });
    expect(firstMeeting('11/14/2026', '', '2026-10-30')).toEqual({ date: '2026-11-14', multi: false });
    expect(firstMeeting('soon', '', '2026-10-30')).toBeNull();
  });
});

describe('availability (fails closed)', () => {
  const ses = (features: Record<string, string>, flags: Record<string, unknown> = {}): Session => ({ id: '1', name: 'x', features, flags });
  it('a positive signal is open; any closed signal vetoes; nothing or unrecognized is unknown', () => {
    expect(availability(ses({ spots: '4' }))).toBe('open');
    expect(availability(ses({ spots: '4', status: 'Closed' }))).toBe('closed');
    expect(availability(ses({ spots: '4' }, { isFull: true }))).toBe('closed');
    expect(availability(ses({}, { spotsAvailable: 0 }))).toBe('closed');
    expect(availability(ses({}, { spotsAvailable: 3 }))).toBe('open');
    expect(availability(ses({}))).toBe('unknown');
    expect(availability(ses({ spots: 'Call us' }))).toBe('unknown');
    expect(availability(ses({ spots: 'Waitlist' }))).toBe('closed');
  });
});

describe('mapSessions (AC-K3-04)', () => {
  const out = mapSessions(all(), CFG, NOW);
  const by = Object.fromEntries(out.items.map((i) => [i.externalKey, i]));

  it('keeps open, not-started youth sessions only and counts every drop by reason', () => {
    expect(Object.keys(by).sort()).toEqual(['rec1:tdrpd#50001', 'rec1:tdrpd#50002', 'rec1:tdrpd#60001']);
    expect(out.dropped).toEqual({ not_youth: 1, full_or_closed: 3, started: 1, age_unparsed: 1, time_unparsed: 1 });
    expect(out.found).toBe(10);
  });
  it('first upcoming meeting in Pacific time, the catalog link, the venue directory', () => {
    const swim = by['rec1:tdrpd#50001'];
    expect(swim.title).toBe('Youth Swim Lessons Level 1');
    expect(swim.startsAt).toBe('2026-11-09T23:30:00Z');
    expect(swim.endsAt).toBe('2026-11-10T00:15:00Z');
    expect(swim.url).toBe(CFG.catalogUrl);
    expect(swim.venueName).toBe('Truckee Community Pool');
    expect([swim.lat, swim.lng]).toEqual([39.3384825, -120.1719775]);
    expect(swim.seriesUid).toBe('rec1:tdrpd#50001');
    const camp = by['rec1:tdrpd#60001'];
    expect(camp.startsAt).toBe('2026-11-23T16:30:00Z');
    expect(camp.venueName).toBe('Old Greenwood Clubhouse');
    expect(camp.lat).toBeUndefined();
    expect(camp.town).toBe('Truckee');
  });
  it('kids only when Rec1\'s own minimum age is 12 or under', () => {
    expect(by['rec1:tdrpd#50001'].categoriesHint).toContain('kids');
    expect(by['rec1:tdrpd#60001'].categoriesHint).toContain('kids');
    expect(by['rec1:tdrpd#50002'].categoriesHint).not.toContain('kids');
    expect(by['rec1:tdrpd#50002'].seriesUid).toBeUndefined();
  });
  it('facts only: no price, description or image on any item', () => {
    for (const i of out.items) {
      const j = JSON.stringify(i);
      expect(j).not.toMatch(/\$80|Synthetic\.|x\.jpg/);
      expect(i.priceText).toBeUndefined();
      expect(i.rawSummaryLength).toBe(0);
    }
  });
  it('a session starting earlier today (or right now) counts as started', () => {
    const one = all().filter((x) => x.id === '50002'); // 11/14 09:00 Pacific = 17:00Z
    expect(mapSessions(one, CFG, new Date('2026-11-14T17:00:00Z')).dropped).toEqual({ started: 1 });
    expect(mapSessions(one, CFG, new Date('2026-11-14T16:59:00Z')).items).toHaveLength(1);
  });
  it('a session with no availability field is dropped as unknown', () => {
    const s = { ...all().find((x) => x.id === '50002')!, features: { ...all().find((x) => x.id === '50002')!.features } };
    delete s.features.spots;
    expect(mapSessions([s], CFG, NOW).dropped).toEqual({ availability_unknown: 1 });
  });
  it('no session objects at all is layout_changed', () => {
    expect(() => mapSessions(collectSessions({ sections: [] }), CFG, NOW)).toThrow('layout_changed');
  });
});

describe('conflicts (review r10 P2s)', () => {
  const base = JSON.parse(fx('items-1002.json')).items[0];
  it('a duplicate id with different facts, or colliding feature names, is dropped as conflict', () => {
    const dup = collectSessions({ items: [base, { ...base, text: 'Other name' }] });
    expect(mapSessions(dup, CFG, NOW).dropped).toEqual({ conflict: 1 });
    const col = collectSessions({ items: [{ ...base, features: [...base.features, { name: 'Age Gender', value: '1y - 3y' }] }] });
    expect(mapSessions(col, CFG, NOW).dropped).toEqual({ conflict: 1 });
    const same = collectSessions({ items: [base, base] });
    expect(mapSessions(same, CFG, NOW).items).toHaveLength(1);
  });
  it('a string boolean availability flag is not trusted', () => {
    expect(availability({ id: '1', name: 'x', features: { spots: '4' }, flags: { isFull: 'true' } })).toBe('unknown');
  });
});

describe('collectTabIds / chooseTabs', () => {
  it('reads tab ids; one bad tab id voids the list', () => {
    expect(collectTabIds(JSON.parse(fx('tabs.json')))).toEqual(['1000', '1001', '1002', '1004', '1005', '1003']);
    expect(collectTabIds({})).toEqual([]);
    expect(collectTabIds({ tabs: [{ id: '1001' }, { id: 'x' }] })).toEqual([]);
  });
  it('an items answer needs a boolean hasMoreResults and known list containers', () => {
    expect(parseTabAnswer(JSON.parse(fx('items-1001.json'))).records.length).toBe(8);
    expect(() => parseTabAnswer({ hasMoreResults: 'false', items: [] })).toThrow('layout_changed');
    expect(() => parseTabAnswer({ items: [] })).toThrow('layout_changed');
    expect(() => parseTabAnswer({ hasMoreResults: false, rows: [] })).toThrow('layout_changed');
  });
  it('chooses only the four youth tabs by label (AC-K3.1-01)', () => {
    expect(chooseTabs(JSON.parse(fx('tabs.json')))).toEqual({ ids: ['1001', '1002', '1004', '1005'], skipped: 2 });
    const four = [{ id: '5', label: 'Art | Dance | Music' }, { id: '6', label: ' ENRICHMENT ' }, { id: '7', label: 'Athletics' }, { id: '8', label: 'Aquatics' }];
    expect(chooseTabs({ tabs: four }).ids).toEqual(['5', '6', '7', '8']);
    expect(() => chooseTabs({ tabs: [{ id: '5', label: 'Welcome' }] })).toThrow('layout_changed');
    expect(() => chooseTabs({ tabs: four.slice(1) })).toThrow('layout_changed'); // review r2-2: a missing youth tab
    expect(() => chooseTabs({ tabs: [...four, { id: '9', label: 'Aquatics' }] })).toThrow('layout_changed'); // a doubled one
  });
});

describe('runRead: the request plan (AC-K3-07, DR-K3-5)', () => {
  type Call = { method: string; url: string; at: number; ua?: string; form?: string };
  function harness(reply: (c: Call) => { status: number; body: string }) {
    let t = 0;
    const calls: Call[] = [];
    const deps = {
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
      http: async (req: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; form?: Record<string, string> }) => {
        const c: Call = { method: req.method, url: req.url, at: t, ua: Object.keys(req.headers).find((h) => h.toLowerCase() === 'user-agent'),
          form: req.form ? new URLSearchParams(req.form).toString() : undefined };
        calls.push(c);
        return reply(c);
      },
    };
    return { calls, deps };
  }
  const normal = (c: Call) => {
    if (c.url.endsWith('/catalog')) return { status: 200, body: fx('catalog.html') };
    if (c.url.includes('/getTabs/')) return { status: 200, body: fx('tabs.json') };
    if (c.url.endsWith('/1001')) return { status: 200, body: fx('items-1001.json') };
    if (c.url.endsWith('/1002')) return { status: 200, body: fx('items-1002.json') };
    if (c.url.endsWith('/1004') || c.url.endsWith('/1005')) return { status: 200, body: '{"hasMoreResults":false,"items":[]}' };
    return { status: 404, body: '' };
  };

  it('page, tabs, then one search per youth tab; >= 6 s apart; no user-agent override; only the allowed paths', async () => {
    const h = harness(normal);
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('ok');
    expect(h.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /CA/tdrpd/catalog',
      'GET /CA/tdrpd/catalog/getTabs/0123456789abcdef0123456789abcdef',
      'POST /CA/tdrpd/catalog/getItems/0123456789abcdef0123456789abcdef/1001',
      'POST /CA/tdrpd/catalog/getItems/0123456789abcdef0123456789abcdef/1002',
      'POST /CA/tdrpd/catalog/getItems/0123456789abcdef0123456789abcdef/1004',
      'POST /CA/tdrpd/catalog/getItems/0123456789abcdef0123456789abcdef/1005',
    ]);
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(6_000);
    expect(h.calls.every((c) => c.ua === undefined)).toBe(true);
    expect(h.calls[2].form).toBe('page=1');
    expect(Object.keys(r.raw ?? {}).sort()).toEqual(['manifest.json', 'tab-1001.json', 'tab-1002.json', 'tab-1004.json', 'tab-1005.json', 'tabs.json']);
  });

  it('follows hasMoreResults, never exceeds 80 requests, and an unfinished read is incomplete (no partial snapshot)', async () => {
    const h = harness((c) => {
      if (c.url.includes('/getItems/')) return { status: 200, body: JSON.stringify({ hasMoreResults: true, items: JSON.parse(fx('items-1002.json')).items }) };
      return normal(c);
    });
    const r = await runRead(CFG, h.deps);
    expect(h.calls.length).toBe(80);
    expect(r.status).toBe('incomplete');
    expect(r.sessions).toEqual([]);
  });

  it.each([403, 429, 401])('stops at once on %i, no retry', async (code) => {
    const h = harness((c) => (c.url.includes('/getTabs/') ? { status: code, body: '' } : normal(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('site_block');
    expect(h.calls.length).toBe(2);
  });

  it('a challenge page or a non-JSON answer to a JSON call is a block', async () => {
    const h = harness((c) => (c.url.endsWith('/1001') ? { status: 200, body: '<html>Just a moment...<div class="cf-chl"></div></html>' } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('site_block');
    expect(h.calls.length).toBe(3);
    const h2 = harness((c) => (c.url.endsWith('/1001') ? { status: 200, body: '<html>hello</html>' } : normal(c)));
    expect((await runRead(CFG, h2.deps)).status).toBe('site_block');
  });

  it('a 3xx (curl follows no redirects) or a 500 is http_error', async () => {
    const h = harness((c) => (c.url.includes('/getTabs/') ? { status: 302, body: '' } : normal(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('http_error');
    expect(r.httpStatus).toBe(302);
  });

  it('refuses a catalog URL off the pinned origin', async () => {
    const h = harness(normal);
    await expect(runRead({ ...CFG, catalogUrl: 'https://evil.example/CA/tdrpd/catalog' }, h.deps)).rejects.toThrow('config_rec1_invalid');
    expect(h.calls.length).toBe(0);
  });

  it('an unrecognized items answer on any tab is layout_changed (no partial snapshot)', async () => {
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ results: [] }) } : normal(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('layout_changed');
    expect(r.sessions).toEqual([]);
  });

  it('a non-empty tab with unrecognized records next to a valid tab is layout_changed', async () => {
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [{ sessionId: 9, title: 'x', attrs: {} }] }) } : normal(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('layout_changed');
    expect(r.sessions).toEqual([]);
  });

  it('a mixed tab (one valid session plus one unrecognized record) is layout_changed', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [valid, { id: 9, text: 'Mystery', attrs: { a: 1 } }] }) } : normal(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('layout_changed');
    expect(r.sessions).toEqual([]);
  });

  it('a mixed tab with a features record that fails the session grammar is layout_changed', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [valid, { id: 'abc', text: 'Bad id', features: [] }] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a mixed tab with a record that has no id (sessionId) is layout_changed', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [valid, { sessionId: 9, title: 'Mystery', attrs: {} }] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a session that nests another record list is layout_changed', async () => {
    const valid = { ...JSON.parse(fx('items-1002.json')).items[0], children: [{ sessionId: 9, title: 'Mystery' }] };
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [valid] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a list under a plain object property, or deep inside a session, is still checked', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const a = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [valid], extra: { more: [{ sessionId: 9 }] } }) } : normal(c)));
    expect((await runRead(CFG, a.deps)).status).toBe('layout_changed');
    const b = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [{ ...valid, meta: { kids: [{ sessionId: 9 }] } }] }) } : normal(c)));
    expect((await runRead(CFG, b.deps)).status).toBe('layout_changed');
  });

  it('a record hidden inside a feature entry is layout_changed', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const bad = { ...valid, features: [...valid.features, { name: 'Ages', value: '5-12', children: [{ sessionId: 9, title: 'Mystery' }] }] };
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [bad] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a session with any nested object property is layout_changed', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [{ ...valid, hidden: { id: 2, title: 'Mystery' } }] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a list container with a plain object property is layout_changed', async () => {
    const one = JSON.parse(fx('items-1001.json'));
    one.sections[0].hidden = { id: 2, title: 'Mystery' };
    const h = harness((c) => (c.url.endsWith('/1001') ? { status: 200, body: JSON.stringify(one) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('an unknown object or list on the envelope is layout_changed', async () => {
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ ...JSON.parse(fx('items-1002.json')), featured: { id: 2, title: 'Mystery' } }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a scalar list element is layout_changed', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [valid, 'Mystery'] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a list of only scalars beside sessions is layout_changed', async () => {
    const one = JSON.parse(fx('items-1001.json'));
    const h = harness((c) => (c.url.endsWith('/1001') ? { status: 200, body: JSON.stringify({ ...one, items: ['Mystery'] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('a feature row without a string name and a string/number value is layout_changed', async () => {
    const valid = JSON.parse(fx('items-1002.json')).items[0];
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [{ ...valid, features: [...valid.features, { label: 'Ages', value: '5-12' }] }] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
  });

  it('an empty tab is fine', async () => {
    const h = harness((c) => (c.url.endsWith('/1002') ? { status: 200, body: JSON.stringify({ hasMoreResults: false, items: [] }) } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('ok');
  });

  it('a page without a checkout key is layout_changed (nothing else requested)', async () => {
    const h = harness((c) => (c.url.endsWith('/catalog') ? { status: 200, body: '<html></html>' } : normal(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
    expect(h.calls.length).toBe(1);
  });
});

// ---- K3.1: deferred activity groups (Spec_Kids_Live Amendment K3.1) ----
describe('K3.1 grammars (AC-K3.1-03/04)', () => {
  it('the real saved Welcome-tab answer parses: one deferred activity group with itemCount 3', () => {
    const t = parseTabAnswer(JSON.parse(fx('real-welcome-tab.json')));
    expect(t).toEqual({ records: [], refs: [{ groupId: '267566', itemCount: 3, name: 'TDRPD Events' }], skipped: 0, hasMore: false });
  });
  const real = () => JSON.parse(fx('real-welcome-tab.json'));
  it('an unknown group type, non-empty errors, a nested object in a section, a bad group id are layout_changed', () => {
    const a = real(); a.sections[0].groups[0].type = 'merch';
    const b = real(); b.errors = ['x'];
    const c = real(); c.sections[0].meta = { x: 1 };
    const d = real(); d.sections[0].groups[0].id = 'g1';
    const e = real(); e.sections[0].groups[0].deferredLoading = 'true';
    const f = real(); f.sections[0].groups[0].itemCount = '3a';
    for (const x of [a, b, c, d, e, f]) expect(() => parseTabAnswer(x)).toThrow('layout_changed');
  });
  it('a deferred location or rental group is skipped and counted', () => {
    const a = real(); a.sections[0].groups.push({ ...a.sections[0].groups[0], id: '9', type: 'location' });
    expect(parseTabAnswer(a).skipped).toBe(1);
  });
  const sess = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: `Program ${id}`, type: 'registration', registrationOpen: true, registrationOver: false,
    features: [{ name: 'dates', value: '11/09/2026 - 12/14/2026' }, { name: 'days', value: 'Mon' }, { name: 'times', value: '3:30 PM - 4:15 PM' }, { name: 'ageGender', value: '5y - 8y' }, { name: 'location', value: 'Truckee Community Pool', icon: 'pin' }], ...extra });
  it('group answers: info strings and an empty children pass; anything else fails', () => {
    expect(parseGroupAnswer({ items: [sess('1')], itemCount: '1', maps: { a: [1] }, errors: [] }).itemCount).toBe(1);
    expect(toSession(sess('1', { info: ['Ages 5-8'], children: [] })).id).toBe('1');
    expect(() => toSession(sess('1', { children: [sess('2')] }))).toThrow('layout_changed');
    expect(() => toSession(sess('1', { info: [{ x: 1 }] }))).toThrow('layout_changed');
    expect(() => toSession(sess('1', { extra: { x: 1 } }))).toThrow('layout_changed');
    expect(() => parseGroupAnswer({ items: [], itemCount: 'x' })).toThrow('layout_changed');
    expect(() => parseGroupAnswer({ items: [], itemCount: 0, other: [] })).toThrow('layout_changed');
  });
  it('registrationOver drops a session as closed; registrationOpen keeps it (AC-K3.1-05)', () => {
    const open = toSession(sess('50'));
    const over = toSession(sess('51', { registrationOpen: false, registrationOver: true }));
    const m = mapSessions([open, over], CFG, NOW);
    expect(m.items.map((i) => i.externalKey)).toEqual(['rec1:tdrpd#50']);
    expect(m.dropped).toEqual({ full_or_closed: 1 });
  });

  // A tab with two deferred activity groups (12 and 2 sessions) and one location group; groups page 10 at a time.
  const group = (n: number, from: number) => Array.from({ length: n }, (_, i) => sess(String(from + i)));
  const deferredTab = { errors: [], items: [], groups: [], hasMoreResults: false, sections: [{ id: '1', name: 'Youth', order: 0, groups: [
    { id: '301', name: 'Swim', type: 'activity', deferredLoading: true, itemCount: '12', items: [] },
    { id: '302', name: 'Art', type: 'activity', deferredLoading: true, itemCount: '2', items: [] },
    { id: '303', name: 'Pool', type: 'location', deferredLoading: true, itemCount: '1', items: [] },
  ] }, { id: '2', name: 'Again', order: 1, groups: [
    { id: '301', name: 'Swim', type: 'activity', deferredLoading: true, itemCount: '12', items: [] },
    { id: '304', name: 'Adult Drop ins', type: 'activity', deferredLoading: true, itemCount: '8', items: [] },
    { id: '305', name: 'Private Swim Lessons | Garrett', type: 'activity', deferredLoading: true, itemCount: '160', items: [] },
    { id: '306', name: 'Aquatic Center Membership', type: 'activity', deferredLoading: true, itemCount: '21', items: [] },
  ] }] };
  type Call = { method: string; url: string; at: number; form?: string; ua?: string };
  function harness(reply: (c: Call) => { status: number; body: string }) {
    let t = 0;
    const calls: Call[] = [];
    return { calls, deps: { now: () => t, sleep: async (ms: number) => { t += ms; }, http: async (req: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; form?: Record<string, string> }) => {
      const c = { method: req.method, url: req.url, at: t, form: req.form ? new URLSearchParams(req.form).toString() : undefined, ua: Object.keys(req.headers).find((h) => h.toLowerCase() === 'user-agent') };
      calls.push(c); return reply(c);
    } } };
  }
  const groups = (c: Call) => {
    const p = Number(new URLSearchParams(c.form).get('page'));
    if (c.url.endsWith('/catalog')) return { status: 200, body: fx('catalog.html') };
    if (c.url.includes('/getTabs/')) return { status: 200, body: fx('tabs.json') };
    if (c.url.includes('/getItems/')) return { status: 200, body: JSON.stringify(c.url.endsWith('/1001') ? deferredTab : { hasMoreResults: false, items: [] }) };
    if (c.url.endsWith('/1001/301')) return { status: 200, body: JSON.stringify({ items: p === 1 ? group(10, 100) : group(2, 110), itemCount: 12 }) };
    if (c.url.endsWith('/1001/302')) return { status: 200, body: JSON.stringify({ items: group(2, 200), itemCount: '2' }) };
    return { status: 404, body: '' };
  };
  const K = '0123456789abcdef0123456789abcdef';
  it('requests youth tabs then each activity group page; never the location group; >= 6 s; no UA (AC-K3.1-01/02)', async () => {
    const h = harness(groups);
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('ok');
    expect(h.calls.map((c) => `${c.method} ${new URL(c.url).pathname} ${c.form ?? ''}`.trim())).toEqual([
      'GET /CA/tdrpd/catalog', `GET /CA/tdrpd/catalog/getTabs/${K}`,
      `POST /CA/tdrpd/catalog/getItems/${K}/1001 page=1`, `POST /CA/tdrpd/catalog/getItems/${K}/1002 page=1`,
      `POST /CA/tdrpd/catalog/getItems/${K}/1004 page=1`, `POST /CA/tdrpd/catalog/getItems/${K}/1005 page=1`,
      `POST /CA/tdrpd/catalog/getActivitySessions/${K}/1001/301 page=1`, `POST /CA/tdrpd/catalog/getActivitySessions/${K}/1001/301 page=2`,
      `POST /CA/tdrpd/catalog/getActivitySessions/${K}/1001/302 page=1`,
    ]);
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(6_000);
    expect(h.calls.every((c) => c.ua === undefined)).toBe(true);
    expect(r.sessions.length).toBe(14);
    expect(r.notes).toMatchObject({ tabs_skipped: 2, groups_skipped: 4, groups_repeated: 1, groups: 2, plan: 3 });
    expect(Object.keys(r.raw ?? {}).sort()).toEqual(['group-1001-301-p1.json', 'group-1001-301-p2.json', 'group-1001-302-p1.json', 'manifest.json', 'tab-1001.json', 'tab-1002.json', 'tab-1004.json', 'tab-1005.json', 'tabs.json']);
    expect(JSON.parse(r.raw!['manifest.json'])).toMatchObject({ version: 1, outcome: 'ok', groups: [{ group: '301', itemCount: 12, sessions: 12 }, { group: '302', itemCount: 2, sessions: 2 }] });
  });
  it('a page with no new id ends the group short: layout_changed, nothing submitted', async () => {
    const h = harness((c) => (c.url.endsWith('/1001/301') ? { status: 200, body: JSON.stringify({ items: group(10, 100), itemCount: 12 }) } : groups(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('layout_changed');
    expect(r.sessions).toEqual([]);
    expect(h.calls.filter((c) => c.url.endsWith('/1001/301')).length).toBe(2);
  });
  it('a plan that does not fit the budget is incomplete before any group call', async () => {
    const big = { ...deferredTab, sections: [{ ...deferredTab.sections[0], groups: Array.from({ length: 9 }, (_, i) => ({ id: String(400 + i), name: 'x', type: 'activity', deferredLoading: true, itemCount: '100', items: [] })) }] };
    const h = harness((c) => (c.url.includes('/getItems/') && c.url.endsWith('/1001') ? { status: 200, body: JSON.stringify(big) } : groups(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('incomplete');
    expect(r.notes?.plan).toBe(90);
    expect(h.calls.some((c) => c.url.includes('getActivitySessions'))).toBe(false);
  });
  it('a bad session in one group does not stop the read; the run is layout_changed with the raw complete (AC-K3.1-04)', async () => {
    const h = harness((c) => (c.url.endsWith('/1001/302') ? { status: 200, body: JSON.stringify({ items: [sess('200', { children: [sess('9')] }), sess('201')], itemCount: 2 }) } : groups(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('layout_changed');
    expect(r.sessions).toEqual([]);
    expect(Object.keys(r.raw ?? {})).toContain('group-1001-302-p1.json');
    expect(h.calls.length).toBe(9);
  });
  it('a group page whose itemCount disagrees with discovery, or more ids than itemCount, is layout_changed (review r2-1/4)', async () => {
    const h = harness((c) => (c.url.endsWith('/1001/302') ? { status: 200, body: JSON.stringify({ items: group(2, 200), itemCount: 3 }) } : groups(c)));
    expect((await runRead(CFG, h.deps)).status).toBe('layout_changed');
    const h2 = harness((c) => (c.url.endsWith('/1001/302') ? { status: 200, body: JSON.stringify({ items: group(3, 200), itemCount: 2 }) } : groups(c)));
    expect((await runRead(CFG, h2.deps)).status).toBe('layout_changed');
  });
  it('the non-event group rule (r3)', () => {
    for (const n of ['Adult Drop ins', 'Senior Programs- Goldenfish', 'Fitness Membership', 'Aquatic Punch Cards', 'Drop-in Sports Punch cards', 'Private Swim Lessons | Jenn', 'The Savvy Dog | Dog Training', 'CAC | Creekside Shuttle', 'Swim Level 2 - Teen/Adult']) expect(SKIP_GROUP.test(n)).toBe(true);
    for (const n of ['Youth Hockey Clinics', 'Swim Level 0 - Parent & Tot', 'Kids Korner and Camps', 'Art Classes', 'Ice Skating  Lessons', 'Group Fitness', 'Safety Classes - Lifeguard']) expect(SKIP_GROUP.test(n)).toBe(false);
  });
  it('session metadata lists (groups) are allowed but never read (review r2-3)', () => {
    expect(toSession(sess('1', { groups: [1, { id: 2, name: 'x' }] })).id).toBe('1');
    expect(() => toSession(sess('1', { groups: [{ items: [] }] }))).toThrow('layout_changed');
  });
  it('a 403 on a group call stops at once', async () => {
    const h = harness((c) => (c.url.endsWith('/1001/301') ? { status: 403, body: '' } : groups(c)));
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('site_block');
    expect(h.calls.length).toBe(7);
  });
  it('collect replays saved answers (AC-K3.1-06)', async () => {
    const h = harness(groups);
    const r = await runRead(CFG, h.deps);
    const raw = r.raw ?? {};
    const get = (n: string) => (n in raw ? Promise.resolve(raw[n]) : Promise.reject(new Error(`missing ${n}`)));
    const c = await collect({ left: () => 1e9, tabs: () => get('tabs.json'), tab: (t, p) => get(p === 1 ? `tab-${t}.json` : `tab-${t}-p${p}.json`), group: (t, g, p) => get(`group-${t}-${g}-p${p}.json`) });
    expect(c.status).toBe('ok');
    expect(c.sessions.map((s) => s.id)).toEqual(r.sessions.map((s) => s.id));
  });
});
