// Per-host spacing for politeFetch, with an injectable clock so tests never wait in real time.
export interface Spacer {
  /** Sleeps until `gapMs` has passed since the last request started on `host`, then records this start. */
  acquire(host: string, gapMs: number): Promise<number>;
  lastStart(host: string): number | undefined;
}

export function createSpacer(deps: { now: () => number; sleep: (ms: number) => Promise<void>; starts?: Map<string, number> }): Spacer {
  const starts = deps.starts ?? new Map<string, number>();
  return {
    async acquire(host, gapMs) {
      const last = starts.get(host);
      if (last !== undefined) {
        const wait = last + gapMs - deps.now();
        if (wait > 0) await deps.sleep(wait);
      }
      const at = deps.now();
      starts.set(host, at);
      return at;
    },
    lastStart: (host) => starts.get(host),
  };
}
