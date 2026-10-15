'use client';
import { useEffect, useState } from 'react';

export const CLOCK_TICK_MS = 60_000;

/** Calls onTick(Date.now()) on a timer and whenever the tab becomes visible again. Returns the cleanup. */
export function startClock(
  onTick: (now: number) => void,
  intervalMs: number = CLOCK_TICK_MS,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null = typeof document === 'undefined' ? null : document,
): () => void {
  const tick = () => onTick(Date.now());
  const id = setInterval(tick, intervalMs);
  const onVisible = () => {
    if (doc && doc.visibilityState === 'visible') tick();
  };
  doc?.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(id);
    doc?.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * A "now" that advances about every minute and when the tab returns, so Today / This week never freeze at page load.
 * With `initialNow` the first render uses it (server render and hydration agree); the real clock takes over right after mount.
 */
export function useClock(intervalMs: number = CLOCK_TICK_MS, initialNow?: number): number {
  const [now, setNow] = useState(() => initialNow ?? Date.now());
  useEffect(() => {
    const first = initialNow !== undefined ? setTimeout(() => setNow(Date.now()), 0) : null;
    const stop = startClock(setNow, intervalMs);
    return () => {
      if (first !== null) clearTimeout(first);
      stop();
    };
  }, [intervalMs, initialNow]);
  return now;
}
