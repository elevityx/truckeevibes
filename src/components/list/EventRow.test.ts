// AC-R1b-07
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { EventRow, shortVenue } from './EventRow';

const TZ = 'America/Los_Angeles';
const base = {
  id: 'a', slug: 'a', title: 'Example Event', summary: '', startsAt: '2026-10-16T01:00:00Z', endsAt: null, allDay: false, startDate: null, endDate: null,
  timeKnown: true, venue: 'Example Ale Works - Example Public House', address: null, town: 'Truckee', area: 'truckee', lat: null, lng: null, categories: ['music'],
  priceKind: 'unknown', priceMin: null, priceMax: null, age: 'unknown', featured: false, url: null, ticketUrl: null, sources: [],
} as VibeEvent;
const html = (o: Partial<VibeEvent>) => renderToStaticMarkup(createElement(EventRow, { e: { ...base, ...o }, tz: TZ, onOpen: () => {} })).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");

describe('AC-R1b-07 EventRow', () => {
  it('keeps a 70-character title unchanged', () => {
    const t = 'Example Harvest Supper with Live Music, Dancing and a Silent Auction!!'.slice(0, 70);
    expect(t).toHaveLength(70);
    expect(html({ title: t })).toContain(`<strong>${t}</strong>`);
  });
  it('shortVenue is the text before the first " - "', () => {
    expect(shortVenue('Example Ale Works - Example Public House')).toBe('Example Ale Works');
    expect(shortVenue('Plain Venue')).toBe('Plain Venue');
    expect(shortVenue(null)).toBe('');
  });
  it('tags', () => {
    expect(html({ priceKind: 'free' })).toContain('<span class="tg free">Free</span>');
    expect(html({ age: '21_plus' })).toContain('>21+</span>');
    expect(html({ age: '18_plus' })).toContain('>18+</span>');
    expect(html({ area: 'reno_carson' })).toContain('>Worth the drive</span>');
    const none = html({});
    for (const t of ['>Free<', '>21+<', '>18+<', 'Worth the drive']) expect(none).not.toContain(t);
  });
  it('the accessible name is the visible text (label-in-name), plus a hidden date and age words', () => {
    const h = html({ age: '18_plus' });
    expect(h).not.toContain('aria-label');
    expect(h.indexOf('Example Event')).toBeGreaterThan(-1);
    expect(h).toMatch(/<span class="sr-only">[^<]*18 and over<\/span>/);
    expect(html({ age: '21_plus' })).toMatch(/<span class="sr-only">[^<]*21 and over<\/span>/);
    expect(h.indexOf('class="t"')).toBeLessThan(h.indexOf('class="sr-only"'));
  });
  it('a button, with the short venue and town', () => {
    const h = html({});
    expect(h).toMatch(/^<button type="button" class="drow"/);
    expect(h).toContain('Example Ale Works');
    expect(h).not.toContain('Example Public House');
    expect(h).toContain('Truckee');
  });
});

describe('AC-R1b-07 list.css', () => {
  const css = readFileSync(join(process.cwd(), 'src/components/list/list.css'), 'utf8');
  it('no ellipsis and no line clamp', () => {
    expect(css).not.toContain('text-overflow: ellipsis');
    expect(css).not.toContain('text-overflow:ellipsis');
    expect(css).not.toContain('-webkit-line-clamp');
  });
});

describe('R1b-1 #6 list.css is on tokens', () => {
  const css = readFileSync(join(process.cwd(), 'src/components/list/list.css'), 'utf8');
  it('no raw px font sizes and no px radii', () => {
    expect(css.match(/font-size:\s*\d[\d.]*px/g) ?? []).toEqual([]);
    expect(css.match(/border-radius:\s*\d[\d.]*px/g) ?? []).toEqual([]);
  });
});
