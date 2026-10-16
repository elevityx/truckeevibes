// AC-R1c-10 EventSheet content, plus the Sheet drag rule and AlsoOn.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { parseSnapshot } from '@/components/list/snapshot';
import { dragCloses } from '@/components/ui/Sheet';
import type { VibeEvent } from '@/lib/data/types';

vi.mock('@/config/public-env', () => ({ supabaseConfigured: () => false, publicEnv: { siteUrl: 'https://truckeevibes.com' } }));

import { alsoOn, normalizeTitle } from './AlsoOn';
import EventSheet from './EventSheet';

const TZ = 'America/Los_Angeles';
const NOW = Date.parse('2026-10-15T15:00:00Z');
const snap = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));
const events = snap.events;
const series = events.filter((e) => e.title === 'Example Sunday Market');
const first = series[0];

const render = (e: VibeEvent, over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(EventSheet, { event: e, events, now: NOW, tz: TZ, onOpenEvent: () => {}, onClose: () => {}, onToast: () => {}, ...over })).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
const labels = (h: string) => [...h.matchAll(/<dt>(.*?)<\/dt>/g)].map((m) => m[1]);
const dd = (h: string, label: string) => {
  const m = new RegExp(`<dt>${label}</dt><dd>(.*?)</dd>`).exec(h);
  return m ? m[1].replace(/<[^>]*>/g, '') : null;
};

describe('AC-R1c-10 EventSheet', () => {
  const h = render(first);
  it('has four series occurrences in the fixture', () => expect(series).toHaveLength(4));
  it('labels in order: Where, Price, Ages, Also on, Listed by', () => {
    expect(labels(h)).toEqual(['Where', 'Price', 'Ages', 'Also on', 'Listed by']);
  });
  it('Price and Ages fall back; Also on lists the other Sundays', () => {
    expect(dd(h, 'Price')).toBe("Not listed. Check the organizer's page.");
    expect(dd(h, 'Ages')).toBe('Not listed.');
    expect(dd(h, 'Also on')).toBe('Oct 25, Nov 1, Nov 8');
  });
  it('Also on is absent when there are no other dates', () => {
    const solo = render(events.find((e) => e.title === 'Example Event 1')!);
    expect(labels(solo)).toEqual(['Where', 'Price', 'Ages', 'Listed by']);
  });
  it('Where shows the venue and the address; Listed by links /sources/', () => {
    expect(dd(h, 'Where')).toContain('Example Plaza');
    expect(dd(h, 'Where')).toContain('Example St');
    expect(h).toMatch(/<dt>Listed by<\/dt><dd><a href="\/sources\/">Example Source [A-N]<\/a><\/dd>/);
  });
  it('title, long date line with the zone, the 2x date chip and the close button', () => {
    expect(h).toContain('<h2 class="etitle">Example Sunday Market</h2>');
    expect(h).toContain('Sunday, Oct 18 · ');
    expect(h).toContain(' · Pacific time');
    expect(h).toContain('class="dchip x2"');
    expect(h).toContain('aria-label="Close event details"');
  });
  it('actions: Organizer\'s page, Add to calendar, Directions, Share, then the Google Calendar link', () => {
    const labelsIn = [...h.matchAll(/<(?:a|button)[^>]*class="btn[^"]*"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)</g)].map((m) => m[1]);
    expect(labelsIn.slice(0, 4)).toEqual(["Organizer's page", 'Add to calendar', 'Directions', 'Share']);
    expect(h).toContain('>Google Calendar</a>');
  });
  it('tags: Our pick only for a picked event, then up to two kinds, ages and Free', () => {
    expect(h).not.toContain('tg pick');
    const p = render(first, { pickLine: 'An example line.' });
    expect(p).toContain('<span class="tg pick">Our pick</span>');
    expect(p).toContain('<p class="pickline">An example line.</p>');
    expect(h).not.toContain('class="pickline"');
    const e = { ...first, categories: ['music', 'arts', 'sports'], age: '21_plus', priceKind: 'free' } as VibeEvent;
    const t = render(e);
    expect(t).toContain('<span class="tg">Music</span><span class="tg">Arts</span>');
    expect(t).not.toContain('Sports');
    expect(t).toContain('<span class="tg t21">21+</span>');
    expect(t).toContain('<span class="tg free">Free</span>');
    expect(dd(t, 'Ages')).toBe('21+');
    expect(dd(t, 'Price')).toBe('Free');
  });
  it('an event with url javascript:alert(1) and no ticket URL has no Organizer\'s page link', () => {
    const bad = render({ ...first, url: 'javascript:alert(1)', ticketUrl: null } as VibeEvent);
    expect(bad).not.toContain("Organizer's page");
    expect(bad).not.toContain('javascript:');
  });
  it("falls back to the ticket URL for the organizer's page; a different ticket URL adds Tickets", () => {
    const t = render({ ...first, url: null, ticketUrl: 'https://example.org/t' } as VibeEvent);
    expect(t).toContain('href="https://example.org/t"');
    expect(t).not.toContain('>Tickets<');
    const both = render({ ...first, url: 'https://example.org/a', ticketUrl: 'https://example.org/t' } as VibeEvent);
    expect(both).toContain('Tickets');
  });
});

describe('alsoOn', () => {
  it('same normalized title and venue, upcoming only, soonest first, at most six', () => {
    const base = { ...first, venue: 'V', title: 'Weekly  Jam' } as VibeEvent;
    const mk = (i: number, over: Partial<VibeEvent> = {}) =>
      ({ ...base, id: `x${i}`, title: 'weekly jam', startsAt: new Date(NOW + (10 - i) * 86_400_000).toISOString(), endsAt: null, ...over }) as VibeEvent;
    const list = [base, ...Array.from({ length: 8 }, (_, i) => mk(i)), mk(20, { venue: 'Other' }), mk(21, { startsAt: new Date(NOW - 86_400_000).toISOString() })];
    const out = alsoOn(base, list, NOW, TZ);
    expect(out).toHaveLength(6);
    expect(out.map((e) => e.id)).toEqual(['x7', 'x6', 'x5', 'x4', 'x3', 'x2']);
    expect(normalizeTitle('  Weekly   JAM ')).toBe('weekly jam');
  });
});

describe('sheet handle drag', () => {
  it('closes past 80 px or faster than 0.5 px/ms', () => {
    expect(dragCloses(120, 1000)).toBe(true);
    expect(dragCloses(81, 5000)).toBe(true);
    expect(dragCloses(80, 5000)).toBe(false);
    expect(dragCloses(40, 50)).toBe(true); // 0.8 px/ms
    expect(dragCloses(40, 200)).toBe(false); // 0.2 px/ms
    expect(dragCloses(-30, 10)).toBe(false);
    expect(dragCloses(0, 10)).toBe(false);
  });
});
