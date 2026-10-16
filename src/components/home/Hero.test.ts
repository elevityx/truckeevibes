// AC-R1b-03: hero line and proof text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstPaint } from '@/lib/data/firstPaint';
import { parseSnapshot } from '@/components/list/snapshot';
import { heroLine, heroProof } from './Hero';

const snap = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));
const fp = firstPaint(snap, 'all');
const THU = Date.parse('2026-10-15T15:00:00Z'); // Thu 8:00 am PDT
const SAT = Date.parse('2026-10-17T17:00:00Z'); // Sat 10:00 am PDT

describe('AC-R1b-03 hero', () => {
  it('heroLine: weekday mornings say "this week", Fri 3 pm to Mon say "This weekend"', () => {
    expect(heroLine(THU)).toBe('Around Truckee this week');
    expect(heroLine(SAT)).toBe('This weekend around Truckee');
    expect(heroLine(Date.parse('2026-10-16T21:59:00Z'))).toBe('Around Truckee this week'); // Fri 2:59 pm
    expect(heroLine(Date.parse('2026-10-16T22:00:00Z'))).toBe('This weekend around Truckee'); // Fri 3:00 pm
    expect(heroLine(Date.parse('2026-10-19T06:59:00Z'))).toBe('This weekend around Truckee'); // Sun 11:59 pm
    expect(heroLine(Date.parse('2026-10-19T07:00:00Z'))).toBe('Around Truckee this week'); // Mon 12:00 am
  });
  it('the visual fixture counts', () => {
    expect(fp.counts.hero).toEqual({ n7: 9, nw: 5, total: 35, lastStart: '2026-11-11' });
    expect(fp.counts.sources.active).toBe(4);
  });
  it('proof, desktop', () => {
    expect(heroProof(fp.counts.hero, fp.counts.sources.active, 'desktop')).toBe(
      '9 things in the next 7 days, 5 this weekend. 35 events through Nov 11 from 4 local calendars, checked daily.',
    );
  });
  it('proof, phone', () => {
    expect(heroProof(fp.counts.hero, fp.counts.sources.active, 'phone')).toBe('9 things in 7 days, 5 this weekend. 35 events from 4 local calendars, checked daily.');
  });
  it('singulars: 1 thing, 1 event, 1 local calendar', () => {
    const h = { n7: 1, nw: 0, total: 1, lastStart: '2026-10-15' };
    expect(heroProof(h, 1, 'desktop')).toBe('1 thing in the next 7 days, 0 this weekend. 1 event through Oct 15 from 1 local calendar, checked daily.');
  });
});
