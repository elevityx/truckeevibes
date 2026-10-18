// AC-M1-73 (a-c) (A6-2): the per-host spacer serializes callers through a promise chain.
import { describe, expect, it } from 'vitest';
import { createSpacer } from './rateLimit';
import { makeClock } from '../testing/fakes';

describe('createSpacer under concurrency (AC-M1-73 a-c)', () => {
  it('(a) three concurrent acquires after a start at T0: four distinct starts, each >= 1,000 ms after the previous', async () => {
    const clock = makeClock();
    const sp = createSpacer({ now: clock.now, sleep: clock.sleep });
    const first = await sp.acquire('h', 1000);
    const rest = await Promise.all([sp.acquire('h', 1000), sp.acquire('h', 1000), sp.acquire('h', 1000)]);
    const all = [first, ...rest].sort((x, y) => x - y);
    expect(new Set(all).size).toBe(4);
    for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBeGreaterThanOrEqual(1000);
  });

  it('(a) another host in the same Promise.all is not delayed by host h', async () => {
    // Manual clock: sleep parks until the test releases it, so a stalled host h cannot move k's start.
    let t = Date.parse('2026-10-15T12:00:00Z');
    const parked: (() => void)[] = [];
    const sp = createSpacer({ now: () => t, sleep: (ms) => new Promise<void>((r) => { parked.push(() => { t += ms; r(); }); }) });
    await sp.acquire('h', 1000);
    const t0 = t;
    const hs = [sp.acquire('h', 1000), sp.acquire('h', 1000)];
    const k = sp.acquire('k', 1000);
    expect(await Promise.race([k, new Promise<string>((r) => setTimeout(() => r('stuck'), 200))])).toBe(t0); // k is not queued behind h
    for (let i = 0; i < 4 && parked.length; i++) { parked.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    await Promise.all(hs);
  });

  it('(b) mixed gaps: acquire(5000) and acquire(1000) together after T0 -> first >= T0+5000, second >= first+1000', async () => {
    const clock = makeClock();
    const sp = createSpacer({ now: clock.now, sleep: clock.sleep });
    const t0 = await sp.acquire('h', 1000);
    const [a, b] = await Promise.all([sp.acquire('h', 5000), sp.acquire('h', 1000)]);
    expect(a - t0).toBeGreaterThanOrEqual(5000);
    expect(b - a).toBeGreaterThanOrEqual(1000);
  });

  it('(c) no leak: after everything settles a fresh acquire(0) resolves at once without sleeping', async () => {
    const clock = makeClock();
    let sleeps = 0;
    const sp = createSpacer({ now: clock.now, sleep: async (ms) => { sleeps++; await clock.sleep(ms); } });
    await Promise.all([sp.acquire('h', 1000), sp.acquire('h', 1000), sp.acquire('h', 1000)]);
    const before = sleeps;
    const got = await Promise.race([sp.acquire('h', 0), new Promise<string>((r) => setTimeout(() => r('stuck'), 200))]);
    expect(got).not.toBe('stuck');
    expect(sleeps).toBe(before);
    expect(sp.lastStart('h')).toBe(got);
  });
});

describe('Spacer.raise (A12 family floor)', () => {
  it('a raised floor is sticky, takes the max, and applies to later acquires with a smaller gap', async () => {
    const clock = makeClock();
    const sp = createSpacer({ now: clock.now, sleep: clock.sleep });
    sp.raise('k', 5000);
    sp.raise('k', 2000); // never lowers
    const a = await sp.acquire('k', 1000);
    const b = await sp.acquire('k', 1000);
    expect(b - a).toBeGreaterThanOrEqual(5000);
    const c = await sp.acquire('k', 8000);
    expect(c - b).toBeGreaterThanOrEqual(8000);
    const other = await sp.acquire('other', 1000);
    expect(other).toBe(clock.now());
  });
});
