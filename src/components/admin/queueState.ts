import type { QueueCard } from '@/lib/data/adminQueue';
import type { DataErrorCode } from '@/lib/data/types';

// Pure state for the review queue (S1.12). No DOM, no clock: callers pass times in.

export interface QueueState {
  cards: QueueCard[];
  /** When the owner opened each card in this session (ms); the review timer. */
  openedAt: Record<string, number>;
  busy: Record<string, true>;
  errors: Record<string, DataErrorCode>;
}

export type QueueAction =
  | { type: 'loaded'; cards: QueueCard[] }
  | { type: 'opened'; id: string; at: number }
  | { type: 'decide_start'; id: string }
  | { type: 'decided'; id: string }
  | { type: 'decide_failed'; id: string; code: DataErrorCode };

export const initialQueueState: QueueState = { cards: [], openedAt: {}, busy: {}, errors: {} };

/** min(600, round((decide - open) / 1000)); an unopened card or a clock that went backwards is 0. */
export function reviewSeconds(openedAtMs: number | undefined, decidedAtMs: number): number {
  if (openedAtMs === undefined) return 0;
  return Math.min(600, Math.max(0, Math.round((decidedAtMs - openedAtMs) / 1000)));
}

function sortCards(cards: readonly QueueCard[]): QueueCard[] {
  const key = (c: QueueCard) => (c.event ? Date.parse(c.event.startsAt) : Number.POSITIVE_INFINITY);
  return [...cards].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

function without<T>(rec: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _drop, ...rest } = rec; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}

function removeCard(s: QueueState, id: string): QueueState {
  return {
    cards: s.cards.filter((c) => c.id !== id),
    openedAt: without(s.openedAt, id),
    busy: without(s.busy, id),
    errors: without(s.errors, id),
  };
}

const has = (s: QueueState, id: string) => s.cards.some((c) => c.id === id);

export function queueReducer(s: QueueState, a: QueueAction): QueueState {
  switch (a.type) {
    case 'loaded': {
      const cards = sortCards(a.cards);
      const keep = new Set(cards.map((c) => c.id));
      const pick = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => keep.has(id))) as Record<string, T>;
      return { cards, openedAt: pick(s.openedAt), busy: pick(s.busy), errors: pick(s.errors) };
    }
    case 'opened':
      if (!has(s, a.id)) return s;
      if (s.openedAt[a.id] !== undefined) return s;
      return { ...s, openedAt: { ...s.openedAt, [a.id]: a.at } };
    case 'decide_start':
      if (!has(s, a.id) || s.busy[a.id]) return s;
      return { ...s, busy: { ...s.busy, [a.id]: true }, errors: without(s.errors, a.id) };
    case 'decided':
      return has(s, a.id) ? removeCard(s, a.id) : s;
    case 'decide_failed':
      if (!has(s, a.id)) return s;
      // Decided somewhere else: nothing left to do with this card.
      if (a.code === 'not_pending') return removeCard(s, a.id);
      return { ...s, busy: without(s.busy, a.id), errors: { ...s.errors, [a.id]: a.code } };
  }
}

export const canDecide = (s: QueueState, id: string): boolean => has(s, id) && !s.busy[id];
export const openCount = (s: QueueState): number => s.cards.length;
