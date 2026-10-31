// Spec_Kids_Live Amendment K3 (AC-K3-04 .. 07): the Rec1 catalog mapper and the on-request read plan, over synthetic fixtures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { availability, collectSessions, collectTabIds, extractPage, isBlocked, itemsEnvelopeOk, mapSessions, parseAges, parseTimes, firstMeeting, runRead, type Rec1Config, type Session } from './rec1';

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

describe('collectTabIds / itemsEnvelopeOk', () => {
  it('reads tab ids; one bad tab id voids the list', () => {
    expect(collectTabIds(JSON.parse(fx('tabs.json')))).toEqual(['1001', '1002']);
    expect(collectTabIds({})).toEqual([]);
    expect(collectTabIds({ tabs: [{ id: '1001' }, { id: 'x' }] })).toEqual([]);
  });
  it('an items answer needs a boolean hasMoreResults and an array container', () => {
    expect(itemsEnvelopeOk(JSON.parse(fx('items-1001.json')))).toBe(true);
    expect(itemsEnvelopeOk({ hasMoreResults: 'false', items: [] })).toBe(false);
    expect(itemsEnvelopeOk({ items: [] })).toBe(false);
    expect(itemsEnvelopeOk({ hasMoreResults: false, rows: [] })).toBe(false);
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
    return { status: 404, body: '' };
  };

  it('page, tabs, then one search per tab; >= 10 s apart; no user-agent override; only the allowed paths', async () => {
    const h = harness(normal);
    const r = await runRead(CFG, h.deps);
    expect(r.status).toBe('ok');
    expect(h.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /CA/tdrpd/catalog',
      'GET /CA/tdrpd/catalog/getTabs/0123456789abcdef0123456789abcdef',
      'POST /CA/tdrpd/catalog/getItems/0123456789abcdef0123456789abcdef/1001',
      'POST /CA/tdrpd/catalog/getItems/0123456789abcdef0123456789abcdef/1002',
    ]);
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i].at - h.calls[i - 1].at).toBeGreaterThanOrEqual(10_000);
    expect(h.calls.every((c) => c.ua === undefined)).toBe(true);
    expect(h.calls[2].form).toBe('page=1');
    expect(Object.keys(r.raw ?? {}).sort()).toEqual(['items-1001.json', 'items-1002.json', 'tabs.json']);
  });

  it('follows hasMoreResults, never exceeds 12 requests, and an unfinished read is incomplete (no partial snapshot)', async () => {
    const h = harness((c) => {
      if (c.url.includes('/getItems/')) return { status: 200, body: JSON.stringify({ hasMoreResults: true, items: JSON.parse(fx('items-1002.json')).items }) };
      return normal(c);
    });
    const r = await runRead(CFG, h.deps);
    expect(h.calls.length).toBe(12);
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
