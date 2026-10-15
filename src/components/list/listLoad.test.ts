// AC-M1-75 (c): pure list-load state. Interface assumption (spec A7-1 step 4): initialLoad, liveLoaded, liveFailedLoad, showLoading.
import { describe, expect, it } from 'vitest';
import type { VibeEvent } from '@/lib/data/types';
import { initialLoad, liveFailedLoad, liveLoaded, showLoading } from './listLoad';

const ev = (id: string) => ({ id, title: `T-${id}`, startsAt: '2026-11-06T02:00:00.000Z', categories: [], sources: [] }) as unknown as VibeEvent;
const snap = { builtAt: '2026-11-05T18:00:00.000Z', events: [ev('a')] };
const empty = { builtAt: null, events: [] };

describe('initialLoad', () => {
  it('a snapshot row with live pending shows the row, not the loading copy', () => {
    const l = initialLoad(snap, true);
    expect(l.events.map((e) => e.id)).toEqual(['a']);
    expect(l.source).toBe('snapshot');
    expect(l.builtAt).toBe(snap.builtAt);
    expect(l.livePending).toBe(true);
    expect(l.liveFailed).toBe(false);
    expect(l.truncated).toBe(false);
    expect(showLoading(l)).toBe(false);
  });
  it('an empty snapshot with live pending shows loading', () => {
    expect(showLoading(initialLoad(empty, true))).toBe(true);
  });
  it('an empty snapshot with no database shows no loading and nothing pending', () => {
    const l = initialLoad(empty, false);
    expect(showLoading(l)).toBe(false);
    expect(l.livePending).toBe(false);
  });
});

describe('transitions', () => {
  it('with a live read still pending, the state is still the snapshot rows', () => {
    const pending = new Promise<never>(() => {});
    void pending;
    const l = initialLoad(snap, true);
    expect(l.events).toEqual(snap.events);
    expect(l.source).toBe('snapshot');
  });
  it('liveFailedLoad keeps the rows and flags the failure', () => {
    const l = liveFailedLoad(initialLoad(snap, true));
    expect(l.events.map((e) => e.id)).toEqual(['a']);
    expect(l.liveFailed).toBe(true);
    expect(l.livePending).toBe(false);
  });
  it('liveLoaded replaces the rows and copies truncated', () => {
    const l = liveLoaded(initialLoad(snap, true), { events: [ev('b'), ev('c')], truncated: true });
    expect(l.events.map((e) => e.id)).toEqual(['b', 'c']);
    expect(l.source).toBe('live');
    expect(l.truncated).toBe(true);
    expect(l.livePending).toBe(false);
    expect(l.liveFailed).toBe(false);
    expect(l.builtAt).toBe(snap.builtAt);
    expect(liveLoaded(initialLoad(snap, true), { events: [], truncated: false }).truncated).toBe(false);
  });
});
