// Port of Truckee Lights src/lib/time/pacific.ts notEnded (:212-219) and src/lib/time/useClock.ts startClock.
const HOUR = 3_600_000;
/** An event with no end time counts as 3 hours long (same as the database's "not ended" rule). */
export const DEFAULT_LENGTH_MS = 3 * HOUR;
/** Events stay listed until 1 hour after they end (same as the database's public read policy). */
export const GRACE_MS = HOUR;
export const CLOCK_TICK_MS = 60_000;

/** When the event stops counting as upcoming: its end, or start + 3 h. */
export function endOf(e: { startsAt: string; endsAt: string | null }): number {
  return e.endsAt ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + DEFAULT_LENGTH_MS;
}

/** Mirrors the public read policy: listed until 1 hour after the end. */
export function notEnded(e: { startsAt: string; endsAt: string | null }, now: number): boolean {
  return endOf(e) > now - GRACE_MS;
}

/** Calls onTick(now()) on a timer and whenever the tab becomes visible again. Returns the cleanup. */
export function startClock(
  onTick: (now: number) => void,
  now: () => number,
  intervalMs: number = CLOCK_TICK_MS,
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> | null = typeof document === 'undefined' ? null : document,
): () => void {
  const tick = () => onTick(now());
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
