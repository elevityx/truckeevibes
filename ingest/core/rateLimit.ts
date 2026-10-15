// Per-host spacing for politeFetch, with an injectable clock so tests never wait in real time.
export interface Spacer {
  /** FIFO per host: waits for earlier callers on `host`, then until `gapMs` after the last start, then records this start. */
  acquire(host: string, gapMs: number): Promise<number>;
  lastStart(host: string): number | undefined;
}

export function createSpacer(deps: { now: () => number; sleep: (ms: number) => Promise<void> }): Spacer {
  const starts = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  return {
    async acquire(host, gapMs) {
      const prev = tails.get(host) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      tails.set(host, mine); // synchronous: the turn is reserved before any await
      try {
        await prev; // prev only ever resolves (never rejects)
        const last = starts.get(host);
        if (last !== undefined) {
          const wait = last + gapMs - deps.now();
          if (wait > 0) await deps.sleep(wait);
        }
        const at = deps.now();
        starts.set(host, at);
        return at;
      } finally {
        // Released at request start, not after the response. Deferred one microtask so this caller resumes (and issues
        // its request) before the next waiter runs; otherwise a shared fake clock can advance between start and send.
        queueMicrotask(release);
        if (tails.get(host) === mine) tails.delete(host);
      }
    },
    lastStart: (host) => starts.get(host),
  };
}
