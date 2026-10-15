// AC-M1-16: across all adapter outputs no string value contains SYNTHETIC-DESCRIPTION-SENTINEL.
// Every fixture description (ICS DESCRIPTION, Tribe description, JSON-LD description) carries the sentinel.
import { describe, expect, it } from 'vitest';
import { adapters } from './index';
import { parseJsonLdEvents } from './jsonld';
import { DESC_SENTINEL, fakePolite, fixture, source } from '../testing/fakes';

const NOW = new Date('2026-10-15T19:00:00Z');
const run = (family: string, config: Record<string, unknown>, handler: Parameters<typeof fakePolite>[0], hosts = ['events.example.test']) =>
  adapters[family].fetch({ source: source({ slug: family, family, config, allowed_hosts: hosts }), fetch: fakePolite(handler).fetch as never, now: NOW });

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
};

describe('descriptions never leave the adapters', () => {
  it('every fixture really contains the sentinel (guards the test itself)', () => {
    for (const f of ['ics/rrule_weekly.ics', 'ics/eventsmanager_sitewide.ics', 'tribe/events_p1.json', 'jsonld/page.html', 'chambermaster/event_template.ics', 'civicplus/cat_one.ics'])
      expect(fixture(f)).toContain(DESC_SENTINEL);
  });
  it('tribe, ics_chambermaster, ics_civicplus, ics_eventsmanager, jsonld outputs are sentinel-free', async () => {
    const results = [
      await run('tribe', { base: 'https://events.example.test', tz: 'America/Los_Angeles' }, (u) => ({ body: fixture(u.searchParams.get('page') === '2' ? 'tribe/events_p2.json' : 'tribe/events_p1.json') })),
      await run('ics_chambermaster', { listUrl: 'https://events.example.test/events' }, (u) => ({
        body: u.pathname === '/events' ? fixture('chambermaster/events_list.html') : fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', '1') })),
      await run('ics_civicplus', { base: 'https://events.example.test', catIds: [14] }, () => ({ body: fixture('civicplus/cat_one.ics') })),
      await run('ics_eventsmanager', { icsUrl: 'https://events.example.test/events.ics' }, () => ({ body: fixture('ics/eventsmanager_sitewide.ics') })),
    ];
    let n = 0;
    for (const r of results) {
      expect(r.items.length).toBeGreaterThan(0);
      for (const s of strings(r)) { n++; expect(s).not.toContain(DESC_SENTINEL); }
    }
    expect(n).toBeGreaterThan(20);
    const ld = parseJsonLdEvents(fixture('jsonld/page.html'), 'https://events.example.test/e/sample-1', { tz: 'America/Los_Angeles' });
    for (const s of strings(ld)) expect(s).not.toContain(DESC_SENTINEL);
  });
});
