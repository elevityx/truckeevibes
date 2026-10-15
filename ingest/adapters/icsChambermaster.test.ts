// AC-M1-14: ChamberMaster HTML discovery + per-event ICS.
import { describe, expect, it } from 'vitest';
import { adapter } from './icsChambermaster';
import { DESC_SENTINEL, fakePolite, fixture, source } from '../testing/fakes';

const NOW = new Date('2026-10-15T12:00:00Z');
const LIST = 'https://chamber.example.test/events';
const ctx = (net: ReturnType<typeof fakePolite>, over = {}) =>
  ({ source: source({ slug: 'chamber-sample', family: 'ics_chambermaster', config: { listUrl: LIST }, page_cap: 10, ...over }), fetch: net.fetch as never, now: NOW });

const chamberNet = () => fakePolite((u) => {
  if (u.pathname === '/events') return { body: fixture('chambermaster/events_list.html') };
  const m = /\/events\/addtocalendar\/.*-(\d+)$/.exec(u.pathname);
  if (m) return { body: fixture('chambermaster/event_template.ics').replaceAll('{{ID}}', m[1]) };
  return { status: 404, body: 'nope' };
});

describe('icsChambermaster', () => {
  it('3 detail links (+1 search link, +1 rendermode link, 1 duplicate) -> list as html, then exactly 3 addtocalendar ICS feed requests', async () => {
    const net = chamberNet();
    const r = await adapter.fetch(ctx(net));
    expect(net.calls[0]).toMatchObject({ url: LIST, kind: 'html' });
    const ics = net.calls.slice(1);
    expect(ics).toHaveLength(3);
    expect(ics.every((c) => c.kind === 'feed')).toBe(true);
    expect(ics.map((c) => c.url).sort()).toEqual([
      'https://chamber.example.test/events/addtocalendar/sample-art-walk-2002?format=ICal',
      'https://chamber.example.test/events/addtocalendar/sample-block-party-2001?format=ICal',
      'https://chamber.example.test/events/addtocalendar/sample-trail-day-2003?format=ICal',
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
  it('caps detail fetches at page_cap - 1 (the list page uses one)', async () => {
    const net = chamberNet();
    await adapter.fetch(ctx(net, { page_cap: 3 }));
    expect(net.calls).toHaveLength(3); // list + 2 ICS
  });
  it('a list page that is not 200 -> http_error and no ICS requests', async () => {
    const net = fakePolite(() => ({ status: 500, body: 'x' }));
    const r = await adapter.fetch(ctx(net));
    expect(r.status).toBe('http_error');
    expect(net.calls).toHaveLength(1);
  });
});
