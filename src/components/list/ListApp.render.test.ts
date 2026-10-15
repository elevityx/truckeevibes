// AC-M1-75 (b, e): the server render of the list already has the snapshot rows, and useClock's first render uses the given time.
// effects do not run in renderToString, so the live read is pending by construction.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';

vi.mock('@/config/public-env', () => ({ supabaseConfigured: () => true, publicEnv: { siteUrl: 'https://truckeevibes.com' } }));
vi.mock('@/lib/data/public', () => ({ listEventsWithMeta: () => new Promise(() => {}) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement('a', { href, ...rest }, children as never),
}));

import { useClock } from '@/lib/time/useClock';
import ListApp from './ListApp';

const row = {
  id: '00000000-0000-4000-8000-0000000000a1', slug: 'snapshot-static-sentinel', title: 'SNAPSHOT-STATIC-SENTINEL', summary: 's',
  startsAt: '2026-11-06T02:00:00.000Z', endsAt: null, allDay: false, startDate: null, endDate: null, timeKnown: true,
  venue: 'Example Hall', address: '1 Example St, Truckee, CA 96161', town: 'Truckee', area: 'truckee', lat: null, lng: null,
  categories: ['music'], priceKind: 'free', priceMin: null, priceMax: null, age: 'all_ages', featured: false,
  url: 'https://example.org/x', ticketUrl: null, sources: ['Example Source'],
} as VibeEvent;

describe('AC-M1-75 (b) ListApp server render', () => {
  it('has the snapshot row and not the loading copy while the live call is pending', () => {
    const html = renderToString(createElement(ListApp, { initialSnapshot: { builtAt: '2026-11-05T18:00:00.000Z', events: [row] } }));
    expect(html).toContain('SNAPSHOT-STATIC-SENTINEL');
    expect(html).not.toContain('Loading events');
  });
  it('an empty snapshot with the live call pending still shows the loading copy', () => {
    const html = renderToString(createElement(ListApp, { initialSnapshot: { builtAt: null, events: [] } }));
    expect(html).toContain('Loading events');
  });
});

describe('AC-M1-75 (e) useClock first render', () => {
  it('prints the given initial time', () => {
    const T = Date.parse('2026-11-05T18:00:00.000Z');
    const Probe = () => createElement('span', null, `now=${useClock(60_000, T)}`);
    expect(renderToString(createElement(Probe))).toContain(`now=${T}`);
  });
});
