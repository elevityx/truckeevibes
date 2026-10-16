// AC-R1c-07 PicksRow and AC-R1c-08 PickCard.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import type { Pick } from '@/lib/picks';
import PickCard from './PickCard';
import PicksRow from './PicksRow';

const TZ = 'America/Los_Angeles';
const mk = (n: number): Pick => ({
  event: {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, title: `Example Event ${n}`, startsAt: '2026-10-19T01:00:00Z', endsAt: '2026-10-19T03:30:00Z',
    allDay: false, timeKnown: true, venue: 'Example Hall - Main Room', town: 'Truckee', categories: ['music'],
  } as VibeEvent,
  line: `Example line ${n}.`,
  photo: null,
});
const html = (n: number) => renderToStaticMarkup(createElement(PicksRow, { picks: Array.from({ length: n }, (_, i) => mk(i + 1)), tz: TZ, onOpen: () => {} })).replace(/<!-- -->/g, '');

describe('AC-R1c-07 PicksRow', () => {
  it('renders nothing for 0', () => expect(html(0)).toBe(''));
  it('1 and 2 picks: cards, no heading', () => {
    for (const n of [1, 2]) {
      const h = html(n);
      expect(h.match(/class="card pick"/g)).toHaveLength(n);
      expect(h).not.toContain('Our picks');
      expect(h).not.toContain('a week');
    }
  });
  it('3 picks: the heading and the "Three a week" line', () => {
    const h = html(3);
    expect(h).toContain('>Our picks<');
    expect(h).toContain('Three a week, from the local who keeps this list.');
    expect(h.match(/class="card pick"/g)).toHaveLength(3);
  });
  it('4 and 5 picks: the "A few a week" line', () => {
    for (const n of [4, 5]) {
      expect(html(n)).toContain('A few a week, from the local who keeps this list.');
      expect(html(n)).not.toContain('Three a week');
    }
  });
});

describe('AC-R1c-08 PickCard', () => {
  const card = (p: Pick) => renderToStaticMarkup(createElement(PickCard, { pick: p, tz: TZ, onOpen: () => {} })).replace(/<!-- -->/g, '');
  it('without a photo there is no img', () => expect(card(mk(1))).not.toContain('<img'));
  it('with a photo there is one img with the given alt and src under /photos/', () => {
    const h = card({ ...mk(1), photo: { src: '/photos/porch.jpg', alt: 'A porch at dusk' } });
    expect(h.match(/<img/g)).toHaveLength(1);
    expect(h).toContain('src="/photos/porch.jpg"');
    expect(h).toContain('alt="A porch at dusk"');
  });
  it('shows the tag, when, title, line and short venue', () => {
    const h = card(mk(1));
    expect(h).toContain('Our pick');
    expect(h).toContain('Sun Oct 18 · 6–8:30 pm · Truckee');
    expect(h).toContain('Example Event 1');
    expect(h).toContain('Example line 1.');
    expect(h).toContain('>Example Hall<');
  });
  it('is a button', () => expect(card(mk(1)).startsWith('<button type="button"')).toBe(true));
});
