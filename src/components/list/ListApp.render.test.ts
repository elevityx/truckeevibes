// AC-M1-75 (b, e) and AC-R1b-04: the server render of the list already has the snapshot rows, the tiles, and useClock's first render uses the given time.
// effects do not run in renderToString, so the live read is pending by construction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';

vi.mock('@/config/public-env', () => ({ supabaseConfigured: () => true, publicEnv: { siteUrl: 'https://truckeevibes.com' } }));
vi.mock('@/lib/data/public', () => ({ listEventsWithMeta: () => new Promise(() => {}) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement('a', { href, ...rest }, children as never),
}));

import { parseSnapshot } from '@/components/list/snapshot';
import { firstPaint } from '@/lib/data/firstPaint';
import { useClock } from '@/lib/time/useClock';
import ListApp from './ListApp';

const row = {
  id: '00000000-0000-4000-8000-0000000000a1', slug: 'snapshot-static-sentinel', title: 'SNAPSHOT-STATIC-SENTINEL', summary: 's',
  startsAt: '2026-11-06T02:00:00.000Z', endsAt: null, allDay: false, startDate: null, endDate: null, timeKnown: true,
  venue: 'Example Hall', address: '1 Example St, Truckee, CA 96161', town: 'Truckee', area: 'truckee', lat: null, lng: null,
  categories: ['music'], priceKind: 'free', priceMin: null, priceMax: null, age: 'all_ages', featured: false,
  url: 'https://example.org/x', ticketUrl: null, sources: ['Example Source'],
} as VibeEvent;

const props = (snapshot: { builtAt: string | null; events: VibeEvent[] }) => {
  const fp = firstPaint({ ...snapshot, sources: [] }, 'all');
  return { list: 'all' as const, ...fp, picks: [] };
};

describe('AC-M1-75 (b) ListApp server render', () => {
  it('has the snapshot row and not the loading copy while the live call is pending', () => {
    const html = renderToString(createElement(ListApp, props({ builtAt: '2026-11-05T18:00:00.000Z', events: [row] })));
    expect(html).toContain('SNAPSHOT-STATIC-SENTINEL');
    expect(html).not.toContain('Checking');
  });
  it('an empty snapshot with the live call pending still shows the loading state', () => {
    const html = renderToString(createElement(ListApp, props({ builtAt: null, events: [] })));
    expect(html).toContain('Checking');
  });
});

describe('AC-R1b-04 tiles', () => {
  const snap = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));
  const html = renderToString(createElement(ListApp, { list: 'all', ...firstPaint(snap, 'all'), picks: [] })).replace(/<!-- -->/g, '');
  const nav = /<div[^>]*role="group"[^>]*aria-label="Lists"[^>]*>(.*?)<\/div><\/div>/.exec(html)![1];
  const tiles = [...nav.matchAll(/<(button|a)\b[^>]*class="tile[^"]*"[^>]*>.*?<\/\1>/g)].map((m) => m[0]);
  it('8 tiles in LISTS order, all buttons while the routes are not live', () => {
    expect(tiles).toHaveLength(8);
    expect(tiles.every((t) => t.startsWith('<button'))).toBe(true);
    const labels = tiles.map((t) => /<span class="lb">([^<]*)<\/span>/.exec(t)![1]);
    expect(labels).toEqual(['All', 'Art', 'Music', '21+', 'Kids', 'Family friendly', 'Outdoors', 'Food & drink'].map((l) => l.replace('&', '&amp;')));
  });
  it('the Kids tile says Soon and has no digit', () => {
    const kids = tiles[4];
    expect(kids).toContain('Soon');
    expect(kids.replace(/<[^>]*>/g, '')).not.toMatch(/\d/);
  });
  it('the All tile is pressed and the others are not', () => {
    expect(tiles[0]).toContain('aria-pressed="true"');
    for (const t of tiles.slice(1)) expect(t).toContain('aria-pressed="false"');
  });
  it('counts', () => {
    expect(tiles.map((t) => /<span class="n">([^<]*)<\/span>/.exec(t)![1])).toEqual(['35', '11', '10', '2', 'Soon', '1', '6', '23']);
  });
});

describe('AC-R1b-14 empty snapshot render', () => {
  const html = renderToString(createElement(ListApp, { ...props({ builtAt: '2026-10-15T13:04:00Z', events: [] }), list: 'all' })).replace(/<!-- -->/g, '');
  it('no "0 local calendars", no zero tile or rail counts, no zero hero numbers', () => {
    expect(html).not.toMatch(/(^|\D)0 local calendars/);
    expect(html).not.toMatch(/<span class="n">0<\/span>/);
    expect(html).not.toContain('0 things');
  });
  it('the tiles are a group of toggle buttons, not a nav', () => {
    expect(html).toContain('role="group"');
    expect(html).not.toMatch(/<nav[^>]*aria-label="Lists"/);
  });
});

describe('AC-M1-75 (e) useClock first render', () => {
  it('prints the given initial time', () => {
    const T = Date.parse('2026-11-05T18:00:00.000Z');
    const Probe = () => createElement('span', null, `now=${useClock(60_000, T)}`);
    expect(renderToString(createElement(Probe))).toContain(`now=${T}`);
  });
});
