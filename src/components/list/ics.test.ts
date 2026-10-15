import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { buildIcs, foldLine, icsEscape, icsFileName } from './ics';

const e = {
  id: '11111111-2222-4333-8444-555555555555', slug: 'park', title: 'Music, in the Park; live', summary: 'Line one\nLine two',
  startsAt: '2026-10-30T23:00:00.000Z', endsAt: null, allDay: false, startDate: null, endDate: null, timeKnown: true,
  venue: 'Downtown Park', address: '10046 Church St, Truckee, CA', town: 'Truckee', area: 'truckee', lat: 1, lng: 2, categories: [],
  priceKind: 'free', priceMin: null, priceMax: null, age: 'all_ages', featured: false, url: 'https://example.org/park', ticketUrl: null, sources: [],
} as VibeEvent;
const NOW = '2026-10-01T00:00:00.000Z';

describe('buildIcs', () => {
  it('writes a CRLF VEVENT with UTC times, a 3 h default end, and escaped text', () => {
    const out = buildIcs(e, NOW);
    expect(out.endsWith('\r\n')).toBe(true);
    expect(out).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
    expect(out).toContain('DTSTAMP:20261001T000000Z');
    expect(out).toContain('DTSTART:20261030T230000Z');
    expect(out).toContain('DTEND:20261031T020000Z');
    expect(out).toContain('SUMMARY:Music\\, in the Park\\; live');
    expect(out).toContain('DESCRIPTION:Line one\\nLine two\\n\\nhttps://example.org/park');
    expect(out).toContain('LOCATION:Downtown Park\\, 10046 Church St\\, Truckee\\, CA');
  });
  it('writes an all-day event as DATE values with an exclusive end', () => {
    const out = buildIcs({ ...e, allDay: true, startDate: '2026-11-07', endDate: '2026-11-08' }, NOW);
    expect(out).toContain('DTSTART;VALUE=DATE:20261107');
    expect(out).toContain('DTEND;VALUE=DATE:20261108');
  });
  it('a title cannot inject a new property line', () => {
    const out = buildIcs({ ...e, title: 'x\r\nATTENDEE:evil' }, NOW);
    expect(out.split('\r\n').some((l) => l.startsWith('ATTENDEE'))).toBe(false);
  });
});

describe('helpers', () => {
  it('escapes backslash, semicolon, comma and newline', () => {
    expect(icsEscape('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });
  it('folds long lines at 75 octets', () => {
    const lines = foldLine('X:' + 'é'.repeat(80)).split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });
  it('makes a safe file name', () => {
    expect(icsFileName({ slug: '../a b' })).toBe('ab.ics');
    expect(icsFileName({ slug: '' })).toBe('event.ics');
  });
});
