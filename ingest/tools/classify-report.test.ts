// AC-R4b-10: classify-report refuses non-permitted sources without fetching, and submits nothing for a valid one.
import { describe, expect, it } from 'vitest';
import { runReport, type ReportRow } from './classify-report';
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
