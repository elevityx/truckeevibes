import type { VibeEvent } from '@/lib/data/types';
import type { Snapshot } from './snapshot';

// Pure state for the public list: the build snapshot is the first state, the live read replaces it.

export interface ListLoad {
  events: VibeEvent[];
  source: 'snapshot' | 'live';
  builtAt: string | null;
  livePending: boolean;
  liveFailed: boolean;
  truncated: boolean;
}

export function initialLoad(s: Pick<Snapshot, 'builtAt' | 'events'>, configured: boolean): ListLoad {
  return { events: s.events, source: 'snapshot', builtAt: s.builtAt, livePending: configured, liveFailed: false, truncated: false };
}

export function liveLoaded(cur: ListLoad, r: { events: VibeEvent[]; truncated: boolean }): ListLoad {
  return { ...cur, events: r.events, source: 'live', livePending: false, liveFailed: false, truncated: r.truncated };
}

/** Events are kept; only the flags change. */
export function liveFailedLoad(cur: ListLoad): ListLoad {
  return { ...cur, livePending: false, liveFailed: true };
}

export const showLoading = (l: ListLoad): boolean => l.livePending && l.events.length === 0;
