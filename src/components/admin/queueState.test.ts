// S1.12 QueueTab state. Interface assumptions (pure, no DOM):
//   queueReducer(state, action), initialQueueState, reviewSeconds(openedAtMs | undefined, decidedAtMs) -> int 0..600,
//   canDecide(state, id), openCount(state).
//   State = { cards: QueueCard[]; openedAt: Record<id, ms>; busy: Record<id, true>; errors: Record<id, DataErrorCode> }.
//   Actions: loaded{cards} | opened{id, at} | decide_start{id} | decided{id} | decide_failed{id, code}.
import { describe, expect, it } from 'vitest';
import type { QueueCard } from '@/lib/data/adminQueue';
import { canDecide, initialQueueState, openCount, queueReducer, reviewSeconds, type QueueState } from './queueState';

function card(id: string, startsAt: string | null, createdAt = '2026-11-05T00:00:00Z', kind: QueueCard['kind'] = 'event'): QueueCard {
  return {
    id, kind, createdAt, openedAt: null, sourceId: 's',
    event: startsAt ? ({ id: 'e-' + id, title: id, startsAt } as QueueCard['event']) : null,
    sources: [], duplicates: [], otherEvent: null, heldRun: null,
  };
}
const ids = (s: QueueState) => s.cards.map((c) => c.id);
const load = (cards: QueueCard[], from: QueueState = initialQueueState) => queueReducer(from, { type: 'loaded', cards });

describe('reviewSeconds', () => {
  it('= min(600, round((decide - open) / 1000))', () => {
    expect(reviewSeconds(1_000, 1_000)).toBe(0);
    expect(reviewSeconds(0, 12_000)).toBe(12);
    expect(reviewSeconds(0, 1_400)).toBe(1);
    expect(reviewSeconds(0, 1_500)).toBe(2);
    expect(reviewSeconds(0, 600_000)).toBe(600);
    expect(reviewSeconds(0, 600_400)).toBe(600);
    expect(reviewSeconds(0, 3_600_000)).toBe(600);
  });
  it('an unopened card or a clock that went backwards is 0, never negative', () => {
    expect(reviewSeconds(undefined, 5_000)).toBe(0);
    expect(reviewSeconds(10_000, 5_000)).toBe(0);
  });
});

describe('loaded', () => {
  it('sorts soonest event first, then created_at; cards with no event (held_run, budget) last', () => {
    const s = load([
      card('late', '2026-11-09T00:00:00Z'),
      card('held', null, '2026-11-01T00:00:00Z', 'held_run'),
      card('soon-b', '2026-11-06T00:00:00Z', '2026-11-05T02:00:00Z'),
      card('soon-a', '2026-11-06T00:00:00Z', '2026-11-05T01:00:00Z'),
    ]);
    expect(ids(s)).toEqual(['soon-a', 'soon-b', 'late', 'held']);
  });
  it('does not mutate the action payload', () => {
    const cards = [card('b', '2026-11-07T00:00:00Z'), card('a', '2026-11-06T00:00:00Z')];
    load(cards);
    expect(cards.map((c) => c.id)).toEqual(['b', 'a']);
  });
  it('keeps timers for cards still present and drops the rest (reload mid-review)', () => {
    let s = load([card('a', '2026-11-06T00:00:00Z'), card('b', '2026-11-07T00:00:00Z')]);
    s = queueReducer(s, { type: 'opened', id: 'a', at: 1000 });
    s = queueReducer(s, { type: 'opened', id: 'b', at: 2000 });
    s = load([card('a', '2026-11-06T00:00:00Z')], s);
    expect(s.openedAt).toEqual({ a: 1000 });
  });
  it('openCount is the number of cards', () => {
    expect(openCount(initialQueueState)).toBe(0);
    expect(openCount(load([card('a', null), card('b', null)]))).toBe(2);
  });
});

describe('opened', () => {
  it('starts the timer once; a second open keeps the first time (like coalesce(opened_at, now()))', () => {
    let s = load([card('a', '2026-11-06T00:00:00Z')]);
    s = queueReducer(s, { type: 'opened', id: 'a', at: 1000 });
    s = queueReducer(s, { type: 'opened', id: 'a', at: 9000 });
    expect(s.openedAt.a).toBe(1000);
  });
  it('a card that the server already shows as opened starts its timer from now, not from the server time', () => {
    const c = { ...card('a', '2026-11-06T00:00:00Z'), openedAt: '2026-11-05T00:00:00Z' };
    const s = queueReducer(load([c]), { type: 'opened', id: 'a', at: 5000 });
    expect(s.openedAt.a).toBe(5000);
  });
  it('ignores an unknown id', () => {
    const s = load([card('a', null)]);
    expect(queueReducer(s, { type: 'opened', id: 'zzz', at: 1 })).toBe(s);
  });
});

describe('deciding', () => {
  const base = () => {
    let s = load([card('a', '2026-11-06T00:00:00Z'), card('b', '2026-11-07T00:00:00Z')]);
    s = queueReducer(s, { type: 'opened', id: 'a', at: 1000 });
    return s;
  };
  it('decide_start marks the card busy and clears an earlier error; canDecide goes false (no double submit)', () => {
    let s = queueReducer(base(), { type: 'decide_failed', id: 'a', code: 'network' });
    expect(s.errors.a).toBe('network');
    expect(canDecide(s, 'a')).toBe(true);
    s = queueReducer(s, { type: 'decide_start', id: 'a' });
    expect(canDecide(s, 'a')).toBe(false);
    expect(s.busy.a).toBe(true);
    expect(s.errors.a).toBeUndefined();
    expect(queueReducer(s, { type: 'decide_start', id: 'a' })).toBe(s);
  });
  it('decided removes the card, its timer and its busy flag; others untouched', () => {
    let s = queueReducer(base(), { type: 'decide_start', id: 'a' });
    s = queueReducer(s, { type: 'decided', id: 'a' });
    expect(ids(s)).toEqual(['b']);
    expect(s.openedAt).toEqual({});
    expect(s.busy).toEqual({});
    expect(openCount(s)).toBe(1);
  });
  it('a failed decision keeps the card, clears busy and records the code (timer keeps running)', () => {
    let s = queueReducer(base(), { type: 'decide_start', id: 'a' });
    s = queueReducer(s, { type: 'decide_failed', id: 'a', code: 'forbidden' });
    expect(ids(s)).toEqual(['a', 'b']);
    expect(canDecide(s, 'a')).toBe(true);
    expect(s.errors.a).toBe('forbidden');
    expect(s.openedAt.a).toBe(1000);
  });
  it('stale keeps the card (the owner can still Discard it)', () => {
    let s = queueReducer(base(), { type: 'decide_start', id: 'a' });
    s = queueReducer(s, { type: 'decide_failed', id: 'a', code: 'stale' });
    expect(ids(s)).toContain('a');
    expect(s.errors.a).toBe('stale');
  });
  it('not_pending means it was decided elsewhere: the card leaves the list', () => {
    let s = queueReducer(base(), { type: 'decide_start', id: 'a' });
    s = queueReducer(s, { type: 'decide_failed', id: 'a', code: 'not_pending' });
    expect(ids(s)).toEqual(['b']);
    expect(s.busy).toEqual({});
    expect(s.openedAt).toEqual({});
  });
  it('decided / failed for an unknown card changes nothing', () => {
    const s = base();
    expect(queueReducer(s, { type: 'decided', id: 'zzz' })).toBe(s);
    expect(queueReducer(s, { type: 'decide_failed', id: 'zzz', code: 'network' })).toBe(s);
  });
  it('canDecide is false for an unknown card', () => {
    expect(canDecide(base(), 'zzz')).toBe(false);
  });
});

describe('purity', () => {
  it('never mutates the previous state', () => {
    const s0 = load([card('a', '2026-11-06T00:00:00Z')]);
    const snap = JSON.stringify(s0);
    queueReducer(s0, { type: 'opened', id: 'a', at: 1 });
    queueReducer(s0, { type: 'decide_start', id: 'a' });
    queueReducer(s0, { type: 'decided', id: 'a' });
    expect(JSON.stringify(s0)).toBe(snap);
  });
});
