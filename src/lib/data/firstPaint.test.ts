// DR6: first paint embeds at most 300 rows starting before builtAt day + 30 days; counts come from the full snapshot.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSnapshot } from '@/components/list/snapshot';
import type { VibeEvent } from '@/lib/data/types';
import { firstPaint } from './firstPaint';

const snap = parseSnapshot(JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/snapshot-visual.json'), 'utf8')));

describe('firstPaint', () => {
  it('home: all 35 fixture rows (last start Nov 11 is inside builtAt + 30 days)', () => {
    const fp = firstPaint(snap, 'all');
    expect(fp.initialSnapshot.events).toHaveLength(35);
    expect(fp.initialSnapshot.builtAt).toBe(snap.builtAt);
    expect(fp.counts.lists.all).toBe(35);
    expect(fp.counts.areas).toMatchObject({ truckee: 22, incline_crystal_bay: 13, donner_lake: 0, reno_carson: 0 });
    expect(fp.counts.kinds).toMatchObject({ 'food-drink': 23, nightlife: 22, arts: 11, family: 0, kids: 0 });
    expect(fp.counts.sources).toMatchObject({ active: 4, paused: 2, linkOnly: 8 });
    expect(fp.counts.sources.activeNames).toHaveLength(4);
  });
  it('a list embeds only its own rows, but counts stay from the full snapshot', () => {
    const fp = firstPaint(snap, 'music');
    expect(fp.initialSnapshot.events).toHaveLength(10);
    expect(fp.counts.lists.all).toBe(35);
  });
  it('caps at 300 rows and drops rows starting 30+ days after the build day', () => {
    const mk = (i: number, days: number): VibeEvent => ({
      ...snap.events[0], id: `id-${i}`, startsAt: new Date(Date.parse('2026-10-16T02:00:00Z') + days * 86_400_000 + i * 60_000).toISOString(),
    });
    const events = [...Array.from({ length: 320 }, (_, i) => mk(i, 1)), mk(900, 45)];
    const fp = firstPaint({ builtAt: snap.builtAt, events, sources: [] }, 'all');
    expect(fp.initialSnapshot.events).toHaveLength(300);
    expect(fp.counts.hero.total).toBe(321);
  });
  it('an empty snapshot gives zeroes and no lastStart', () => {
    const fp = firstPaint({ builtAt: null, events: [], sources: [] }, 'all');
    expect(fp.initialSnapshot.events).toEqual([]);
    expect(fp.counts.hero).toEqual({ n7: 0, nw: 0, total: 0, lastStart: null });
  });
});
