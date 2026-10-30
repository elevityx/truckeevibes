// AC-R4b-10: classify-report refuses non-permitted sources without fetching, and submits nothing for a valid one.
import { describe, expect, it } from 'vitest';
import { runReport, type ReportRow } from './classify-report';
import { makeEvent } from '../adapters/common';
import type { Adapter, SourceEvent } from '../types';
import { fakeNet, fixture, makeClock, text } from '../testing/fakes';

const FUTURE = '2027-10-14T00:00:00Z';
const PAST = '2025-01-01T00:00:00Z';
const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  slug: 'tribe-sample', family: 'tribe', config: { base: 'https://events.example.test', tz: 'America/Los_Angeles' }, allowed_hosts: ['events.example.test'],
  allowed_methods: ['api'], page_cap: 10, ingest_disposition: 'permitted', terms_recheck_at: FUTURE, enabled: true, ...over,
});
const harness = () => {
  const clock = makeClock();
  const net = fakeNet((u) => {
    if (u.pathname === '/robots.txt') return text('nf', 404);
    if (u.pathname.startsWith('/wp-json/tribe/events/v1/events')) return new Response(fixture(u.searchParams.get('page') === '2' ? 'tribe/events_p2.json' : 'tribe/events_p1.json'), { status: 200, headers: { 'content-type': 'application/json' } });
    return text('', 404);
  }, clock.now);
  const out: string[] = [];
  const err: string[] = [];
  const run = (rows: ReportRow[]) => runReport(rows, { fetch: net.fetch, now: () => new Date(clock.now()), sleep: clock.sleep, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { run, net, out, err };
};

describe('classify-report', () => {
  it('refuses permission_required and expired-terms rows: exit 1 naming the slugs, zero fetches', async () => {
    const h = harness();
    const code = await h.run([row({ slug: 'needs-permission', ingest_disposition: 'permission_required' }), row({ slug: 'stale-terms', terms_recheck_at: PAST }), row({ slug: 'off', enabled: false })]);
    expect(code).toBe(1);
    const e = h.err.join('\n');
    for (const s of ['needs-permission', 'stale-terms', 'off']) expect(e).toContain(s);
    expect(h.net.calls).toHaveLength(0);
    expect(h.out).toHaveLength(0);
  });
  it('a row with a null terms_recheck_at is refused', async () => {
    const h = harness();
    expect(await h.run([row({ terms_recheck_at: null })])).toBe(1);
    expect(h.net.calls).toHaveLength(0);
  });
  it('one refused row refuses the whole run (nothing is fetched for the good rows)', async () => {
    const h = harness();
    expect(await h.run([row(), row({ slug: 'bad', ingest_disposition: 'blocked' })])).toBe(1);
    expect(h.net.calls).toHaveLength(0);
  });
  it('a valid row prints the per-source block, fetches only the allowed host, and never touches the ingest endpoint', async () => {
    const h = harness();
    expect(await h.run([row({ slug: 'tribe-sample' })])).toBe(0);
    const o = h.out.join('\n');
    expect(o).toContain('source=tribe-sample');
    expect(o).toMatch(/tags: /);
    expect(o).toMatch(/free: [1-9]/);
    expect(o).toMatch(/age_ambiguous: \d+/);
    expect(o).toMatch(/conflicts: \d+/);
    expect(o).toMatch(/notices: \d+\/\d+/);
    expect(o).toMatch(/unmapped: /);
    expect(o).toMatch(/event 103 /); // external_key + reason codes
    expect(o).toContain('price:text_free');
    for (const c of h.net.calls) expect(new URL(c.url).hostname).toBe('events.example.test');
    expect(h.net.calls.some((c) => c.method !== 'GET')).toBe(false);
  });
  it('an empty rows list is an error', async () => {
    const h = harness();
    expect(await h.run([])).toBe(1);
  });
});

describe('per-event rows and kids_family_wordlist_only (AC-R4b-24)', () => {
  const fakeAdapter = (items: SourceEvent[]): Adapter => ({ family: 'fake', version: 'fake.1', fetch: async () => ({ items, status: 'ok' }) });
  const base = { allDay: false, timeKnown: true, tz: 'America/Los_Angeles', rawSummaryLength: 0, startsAt: '2026-10-20T19:00:00Z' };
  const facts = (externalKey: string, title: string, over: Record<string, unknown> = {}) => ({ externalKey, title, startsAt: '2026-10-20T19:00:00Z', allDay: false, tz: 'America/Los_Angeles', family: 'tribe', ...over });
  const go = async (items: SourceEvent[]) => {
    const out: string[] = [];
    const clock = makeClock();
    const code = await runReport([row({ slug: 'fake-src', family: 'fake' })], { fetch: fakeNet(() => text('', 404), clock.now).fetch, now: () => new Date(clock.now()), sleep: clock.sleep, out: (l) => out.push(l), err: () => undefined, adapters: { fake: fakeAdapter(items) } });
    expect(code).toBe(0);
    return out;
  };
  it('prints cats, age, price and codes, with no title', async () => {
    const out = await go([{ ...base, externalKey: 'k1', title: 'Secret Title One', categoriesHint: ['music'], age: '21_plus', priceKind: 'unknown', tagReasons: ['cat:source_map', 'age:21_admission', 'conflict:adult'] }]);
    expect(out).toContain('  event k1 cats=music age=21_plus price=unknown cat:source_map,age:21_admission,conflict:adult');
    expect(out.filter((l) => l.startsWith('  event ')).join('\n')).not.toContain('Secret Title One');
  });
  it('an event with no categories or codes prints dashes, and a cancelled one says so', async () => {
    const out = await go([{ ...base, externalKey: 'k2', title: 'Plain', categoriesHint: [], cancelled: true }]);
    expect(out).toContain('  event k2 cats=- age=unknown price=unknown - cancelled');
  });
  it('counts a kids hint removed only by the word list; a 21+ item with a kids hint is not counted', async () => {
    const wl = makeEvent(facts('w1', 'Kids Craft Afternoon', { venueName: 'Truckee Ski Club', hints: ['kids'] }));
    const adult = makeEvent(facts('a1', '21+ only Night', { hints: ['kids'] }));
    const clean = makeEvent(facts('c1', 'Kids Craft Afternoon', { hints: ['kids'] }));
    expect(wl.tagReasons).toEqual(expect.arrayContaining(['conflict:adult_signal', 'age:ambiguous']));
    expect(wl.tagReasons).not.toContain('conflict:adult');
    const out = await go([wl, adult, clean]);
    expect(out).toContain('  kids_family_wordlist_only: 1');
  });
  it('prints sorted price_reasons counts after free (AC-M1-171)', async () => {
    const free = makeEvent(facts('f1', 'Sample Pumpkin Hunt', { hints: ['free-events'] }));
    const t = makeEvent(facts('f2', 'Free Yoga Afternoon'));
    const out = await go([free, t]);
    expect(out).toContain('  free: 2');
    expect(out).toContain('  price_reasons: price:source_free:1,price:title_free:1');
    expect(out.indexOf('  free: 2')).toBeLessThan(out.findIndex((l) => l.startsWith('  price_reasons:')));
  });
  it('one free-events item prints free: 1 and price_reasons: price:source_free:1', async () => {
    const out = await go([makeEvent(facts('f1', 'Sample Pumpkin Hunt', { hints: ['free-events'] }))]);
    expect(out).toContain('  free: 1');
    expect(out).toContain('  price_reasons: price:source_free:1');
  });
});
