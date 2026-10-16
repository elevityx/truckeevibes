// AC-R1b-14 (live reconcile, unknown counts) and AC-R1b-17 (live failure paths), as pure state.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { heroProof } from '@/components/home/Hero';
import { parseSnapshot } from '@/components/list/snapshot';
import { buildCounts } from '@/lib/data/firstPaint';
import type { VibeEvent } from '@/lib/data/types';
import { homeModel, chooseView, refreshNotice } from './homeModel';
import { initialLoad, liveFailedLoad, liveLoaded } from './listLoad';

const NOW = Date.parse('2026-10-15T15:00:00Z');
const full = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));
const empty = { builtAt: '2026-10-15T13:04:00Z', events: [] as VibeEvent[] };
const emptyCounts = buildCounts([], [], Date.parse(empty.builtAt), 'America/Los_Angeles');
const fullCounts = buildCounts(full.events, full.sources, Date.parse(full.builtAt!), 'America/Los_Angeles');

describe('AC-R1b-14 unknown counts never show as 0', () => {
  it('an empty snapshot with live pending: no hero numbers, no tile counts, no sources clause', () => {
    const m = homeModel({ load: initialLoad(empty, true), counts: emptyCounts, liveSources: null, now: NOW });
    expect(m.known).toBe(false);
    expect(m.hero).toBeNull();
    expect(m.tileCounts).toBeNull();
    expect(m.activeSources).toBe(0);
  });
  it('after a mocked live read of 3 sources and 5 events the hero says "from 3 local calendars"', () => {
    const rows = full.events.slice(0, 5);
    const load = liveLoaded(initialLoad(empty, true), { events: rows, truncated: false });
    const src = [1, 2, 3].map((i) => ({ name: `S${i}`, homepageUrl: `https://example.org/${i}`, status: 'active' as const }));
    const m = homeModel({ load, counts: emptyCounts, liveSources: src, now: NOW });
    expect(m.known).toBe(true);
    expect(m.activeSources).toBe(3);
    expect(heroProof(m.hero!, m.activeSources, 'desktop')).toContain('from 3 local calendars, checked daily.');
    expect(m.tileCounts!.all).toBe(5);
  });
  it('a snapshot with events but no known sources omits the calendars clause, never "0 local calendars"', () => {
    const c = buildCounts(full.events, [], Date.parse(full.builtAt!), 'America/Los_Angeles');
    const m = homeModel({ load: initialLoad(full, false), counts: c, liveSources: null, now: NOW });
    expect(m.known).toBe(true);
    const p = heroProof(m.hero!, m.activeSources, 'desktop');
    expect(p).not.toContain('local calendar');
    expect(p).toBe('9 things in the next 7 days, 5 this weekend. 35 events through Nov 11, checked daily.');
  });
  it('a live source read replaces the build sources', () => {
    const m = homeModel({ load: initialLoad(full, false), counts: fullCounts, liveSources: [{ name: 'Only', homepageUrl: 'https://example.org/', status: 'active' }], now: NOW });
    expect(m.activeSources).toBe(1);
    expect(m.activeNames).toEqual(['Only']);
  });
});

describe('AC-R1b-17 live failure paths', () => {
  it('with snapshot rows: the rows stay and a refresh notice appears', () => {
    const load = liveFailedLoad(initialLoad(full, true));
    expect(chooseView({ load, empty: false, upcoming: 35, shown: 35 })).toBe('list');
    expect(refreshNotice(load, false)).toBe(true);
  });
  it('with an empty snapshot: the Error card, no notice', () => {
    const load = liveFailedLoad(initialLoad(empty, true));
    expect(chooseView({ load, empty: true, upcoming: 0, shown: 0 })).toBe('error');
    expect(refreshNotice(load, true)).toBe(false);
  });
  it('the other views', () => {
    expect(chooseView({ load: initialLoad(empty, true), empty: true, upcoming: 0, shown: 0 })).toBe('loading');
    expect(chooseView({ load: initialLoad(empty, false), empty: true, upcoming: 0, shown: 0 })).toBe('empty');
    expect(chooseView({ load: initialLoad(full, false), empty: false, upcoming: 35, shown: 0 })).toBe('noresults');
  });
});
