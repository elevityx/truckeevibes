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

// Visual tests only: a build with this flag set starts in the "live read failed" state. Read here and nowhere else.
const FORCE_LIVE_ERROR = process.env.NEXT_PUBLIC_FORCE_LIVE_ERROR === '1';

export function initialLoad(s: Pick<Snapshot, 'builtAt' | 'events'>, configured: boolean): ListLoad {
  if (FORCE_LIVE_ERROR) return { events: s.events, source: 'snapshot', builtAt: s.builtAt, livePending: false, liveFailed: true, truncated: false };
  return { events: s.events, source: 'snapshot', builtAt: s.builtAt, livePending: configured, liveFailed: false, truncated: false };
}

export function liveLoaded(cur: ListLoad, r: { events: VibeEvent[]; truncated: boolean }): ListLoad {
  return { ...cur, events: r.events, source: 'live', livePending: false, liveFailed: false, truncated: r.truncated };
}

/** Events are kept; only the flags change. */
export function liveFailedLoad(cur: ListLoad): ListLoad {
  return { ...cur, livePending: false, liveFailed: true };
}

/** A retry: the live read is pending again; the rows already shown stay. */
export function retryLoad(cur: ListLoad): ListLoad {
  return { ...cur, livePending: true, liveFailed: false };
}

export const showLoading = (l: ListLoad): boolean => l.livePending && l.events.length === 0;
