// AC-R1b-06: day groups on the visual fixture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '@/components/list/snapshot';
import { applyFilters, withSpan } from '@/lib/filters/predicates';
import { EMPTY_FILTERS } from '@/lib/filters/state';
import DayGroup, { planDays } from './DayGroup';

const TZ = 'America/Los_Angeles';
const NOW = Date.parse('2026-10-15T15:00:00Z');
const snap = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));
const all = snap.events.map((e) => withSpan(e, TZ));
const strip = (h: string) => h.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('AC-R1b-06 planDays (no filters, list all)', () => {
  const plan = planDays(applyFilters(all, EMPTY_FILTERS, NOW, TZ), { now: NOW, tz: TZ, fillEmpty: true });
  it('7 day heads Thu Oct 15 to Wed Oct 21', () => {
    expect(plan.days.map((d) => d.date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
    expect(plan.days.map((d) => d.events.length)).toEqual([1, 0, 2, 3, 1, 1, 1]);
  });
  it('Later: 26 more through Nov 11', () => {
    expect(plan.later.total).toBe(26);
    expect(plan.later.last).toBe('2026-11-11');
  });
});

describe('AC-R1b-06 DayGroup render', () => {
  const html = (events = all, o: Partial<{ filtered: boolean; fillEmpty: boolean }> = {}) =>
    strip(renderToStaticMarkup(createElement(DayGroup, { events, tz: TZ, now: NOW, fillEmpty: o.fillEmpty ?? true, onOpen: () => {} })));
  it('every day is shown; an empty day says so', () => {
    const h = html(applyFilters(all, EMPTY_FILTERS, NOW, TZ));
    expect(h).toContain('Today · Thursday, Oct 15');
    expect(h).toContain('Today · Thu Oct 15');
    expect(h).toContain('Saturday, Oct 17');
    expect(h).toContain('Wed Oct 21');
    expect(h.match(/<h2 class="gh">/g)!.length).toBeGreaterThanOrEqual(7);
    expect(h.match(/Nothing listed yet\. Organizers: <a href="\/sources\/#add">add your calendar<\/a>\./g)).toHaveLength(1);
  });
  it('Later divider, exactly 6 Later rows, then Show the rest (20 more)', () => {
    const h = html(applyFilters(all, EMPTY_FILTERS, NOW, TZ));
    expect(h).toContain('26 more through Nov 11');
    expect(h).toContain('Show the rest (20 more)');
    const later = h.slice(h.indexOf('class="later"'));
    expect(later.match(/class="drow"/g)).toHaveLength(6);
    const before = h.slice(0, h.indexOf('class="later"'));
    expect(before.match(/class="drow"/g)).toHaveLength(9);
  });
  it('with the Truckee filter there is no empty-day placeholder', () => {
    const f = applyFilters(all, { ...EMPTY_FILTERS, areas: ['truckee'] }, NOW, TZ);
    const h = html(f, { fillEmpty: false });
    expect(h).not.toContain('Nothing listed yet');
  });
});
