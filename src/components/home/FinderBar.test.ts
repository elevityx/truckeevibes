// AC-R1c-03: FinderBar counts and markup on the visual fixture at Thu 2026-10-15 08:00 PDT.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '@/components/list/snapshot';
import { applyFilters, withSpan } from '@/lib/filters/predicates';
import { EMPTY_FILTERS, type FilterState } from '@/lib/filters/state';
import FinderBar from './FinderBar';
import { chipAreas, finderCounts } from './finderCounts';

const TZ = 'America/Los_Angeles';
const NOW = Date.parse('2026-10-15T15:00:00Z');
const snap = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));
const events = snap.events.map((e) => withSpan(e, TZ));
const upcoming = applyFilters(events, EMPTY_FILTERS, NOW, TZ);
const f = (o: Partial<FilterState> = {}): FilterState => ({ ...EMPTY_FILTERS, ...o });
const render = (filters: FilterState, counts: ReturnType<typeof finderCounts> | null) =>
  renderToStaticMarkup(
    createElement(FinderBar, { filters, counts, minDate: '2026-10-15', maxDate: '2027-02-12', tz: TZ, onChange: () => {}, onMore: () => {} }),
  ).replace(/<!-- -->/g, '');
const text = (h: string) => h.replace(/<[^>]*>/g, '');

describe('AC-R1c-03 counts', () => {
  const c = finderCounts(upcoming, EMPTY_FILTERS, NOW, TZ);
  it('Today 1, This weekend 5, Next 7 days 9; Free only 0, Kids OK 1; 35 events', () => {
    expect(c).toMatchObject({ today: 1, weekend: 5, d7: 9, free: 0, kids: 1, total: 35 });
  });
  it('areas: Truckee 22, Incline & Crystal Bay 13, the rest 0', () => {
    expect(c.areas).toMatchObject({ truckee: 22, incline_crystal_bay: 13, donner_lake: 0, reno_carson: 0 });
  });
  it('with cat=music, Next 7 days is the music-only count', () => {
    const music = upcoming.filter((e) => e.categories.includes('music'));
    const expected = applyFilters(music, f({ when: '7d' }), NOW, TZ).length;
    const m = finderCounts(upcoming, f({ cats: ['music'] }), NOW, TZ);
    expect(m.d7).toBe(expected);
    expect(m.d7).toBeLessThan(c.d7);
    expect(m.d7).toBeGreaterThan(0);
  });
  it("each count ignores its own key but keeps the others (when=7d does not change the pill counts)", () => {
    const w = finderCounts(upcoming, f({ when: '7d' }), NOW, TZ);
    expect(w).toMatchObject({ today: 1, weekend: 5, d7: 9 });
    expect(w.kids).toBe(applyFilters(upcoming, f({ when: '7d', kids: true }), NOW, TZ).length);
  });
});

describe('FinderBar markup', () => {
  const counts = finderCounts(upcoming, EMPTY_FILTERS, NOW, TZ);
  const h = render(EMPTY_FILTERS, counts);
  it('search placeholder, name and type', () => {
    expect(h).toContain('type="search"');
    expect(h).toContain('name="q"');
    expect(h).toContain('placeholder="Search 35 events"');
  });
  it('When pills in order, with counts, no Tomorrow pill', () => {
    const t = text(h);
    expect(t).toContain('Today 1');
    expect(t).toContain('Tonight');
    expect(h).toContain('<span class="dsk">This weekend</span><span class="phn">Weekend</span> <span class="n">5</span>');
    expect(t).toContain('Next 7 days 9');
    expect(t).toContain('Pick a date');
    expect(t).not.toContain('Tomorrow');
    expect(h).toContain('min="2026-10-15"');
    expect(h).toContain('max="2027-02-12"');
  });
  it('desktop switches with counts', () => {
    expect(h.match(/role="switch"/g)).toHaveLength(2);
    expect(text(h)).toContain('Free only 0');
    expect(text(h)).toContain('Kids OK 1');
  });
  it('phone chips: Free, Kids, the top two areas, More areas', () => {
    const chips = [...h.matchAll(/<button type="button" class="chip"[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]));
    expect(chips).toEqual(['Free 0', 'Kids 1', 'Truckee 22', 'Incline 13', 'More areas']);
  });
  it('selected areas stay on the chip row even when empty', () => {
    expect(chipAreas({ truckee: 5, incline_crystal_bay: 3, donner_lake: 2 }, ['reno_carson'])).toEqual(['truckee', 'incline_crystal_bay', 'reno_carson']);
  });
  it('pressed state follows the filters', () => {
    const on = render(f({ when: '7d', free: true, kids: true }), counts);
    expect(on.match(/aria-pressed="true"/g)?.length).toBe(3); // Next 7 days, the Free chip, the Kids chip
    expect(on.match(/aria-checked="true"/g)).toHaveLength(2);
  });
  it('a selected date shows its day label', () => {
    expect(text(render(f({ when: { date: '2026-10-17' } }), counts))).toContain('Sat Oct 17');
  });
  it('unknown counts show no numbers', () => {
    const u = render(EMPTY_FILTERS, null);
    expect(u).not.toContain('class="n"');
    expect(u).toContain('placeholder="Search events"');
  });
});
