// Spec_Sources_V2 §7 (AC-SV2-24, r2 astra spec-r1 P2): drives the REAL `main(argv, deps)` of both manual readers with fake deps.
// Nothing here touches the Supabase CLI, curl or the network: `./manualDb` is mocked with functions that refuse to run, so even a
// reader that still runs `main` at import (before the testable-entry change) cannot reach the real CLI; process.exit is stubbed.
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./manualDb', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const refuse = (name: string) => () => Promise.reject(new Error(`test: real manualDb.${name} must never run`));
  return {
    ...real,
    sql: refuse('sql'),
    manualGrant: refuse('manualGrant'),
    pendingRequests: refuse('pendingRequests'),
    submit: refuse('submit'),
    recordBlock: refuse('recordBlock'),
    drain: refuse('drain'),
    curlHttp: () => { throw new Error('test: real manualDb.curlHttp must never run'); },
  };
});

type Main = (argv: string[], deps: Record<string, unknown>) => Promise<number>;
interface Rec { grant: unknown[][]; http: unknown[]; curlHttp: number; submit: unknown[][]; logs: string[] }
interface Over { grant?: () => Promise<{ grant: string; source?: unknown; refused?: string }>; pending?: unknown[]; sqlRows?: unknown[] }

function fakeDeps(o: Over = {}) {
  const rec: Rec = { grant: [], http: [], curlHttp: 0, submit: [], logs: [] };
  const deps = {
    sql: async () => o.sqlRows ?? [],
    manualGrant: async (slug: string, opts?: unknown) => { rec.grant.push([slug, opts]); return o.grant ? o.grant() : { grant: '', refused: 'gate' }; },
    pendingRequests: async () => o.pending ?? [],
    curlHttp: () => { rec.curlHttp++; return async (req: unknown) => { rec.http.push(req); return { status: 200, body: '' }; }; },
    submit: async (...a: unknown[]) => { rec.submit.push(a); return {}; },
    recordBlock: async () => {},
    drain: async () => {},
    log: (line: string) => { rec.logs.push(line); },
  };
  return { deps, rec };
}

let manualRead: { main?: Main };
let tdrpd: { main?: Main };
beforeAll(async () => {
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  manualRead = (await import('./manual-read')) as unknown as { main?: Main };
  tdrpd = (await import('./tdrpd-refresh')) as unknown as { main?: Main };
});
const mainOf = (m: { main?: Main }): Main => {
  expect(typeof m.main, 'the reader exports a testable main(argv, deps)').toBe('function');
  return m.main as Main;
};

describe('manual-read.ts main(argv, deps)', () => {
  it('--requested <slug> -> manualGrant(slug, { requested: true })', async () => {
    const { deps, rec } = fakeDeps();
    await mainOf(manualRead)(['--requested', 'bar-of-america'], deps);
    expect(rec.grant).toEqual([['bar-of-america', { requested: true }]]);
  });
  it('<slug> -> manualGrant(slug, {}) with no requested flag', async () => {
    const { deps, rec } = fakeDeps();
    await mainOf(manualRead)(['bar-of-america'], deps);
    expect(rec.grant).toHaveLength(1);
    const [slug, opts] = rec.grant[0] as [string, { requested?: boolean } | undefined];
    expect(slug).toBe('bar-of-america');
    expect(Boolean(opts?.requested)).toBe(false);
  });
  it('a withdrawn request -> exit 3, "request withdrawn" logged, zero source requests', async () => {
    const { deps, rec } = fakeDeps({ grant: async () => ({ grant: '', refused: 'withdrawn' }) });
    expect(await mainOf(manualRead)(['--requested', 'bar-of-america'], deps)).toBe(3);
    expect(rec.logs.some((l) => l.includes('request withdrawn: skipped (nothing read)'))).toBe(true);
    expect(rec.http).toHaveLength(0);
    expect(rec.submit).toHaveLength(0);
  });
  it('a gated grant (read in the last 24 h) -> exit 3 with the existing refusal line, zero source requests', async () => {
    const { deps, rec } = fakeDeps({ grant: async () => ({ grant: '', refused: 'gate' }) });
    expect(await mainOf(manualRead)(['--requested', 'diamond-peak'], deps)).toBe(3);
    expect(rec.logs.some((l) => l.includes('grant refused'))).toBe(true);
    expect(rec.logs.some((l) => l.includes('request withdrawn'))).toBe(false);
    expect(rec.http).toHaveLength(0);
  });
  it('manualGrant rejecting grant_call_failed -> main rejects (the entry exits 1), zero source requests', async () => {
    const { deps, rec } = fakeDeps({ grant: () => Promise.reject(new Error('grant_call_failed')) });
    await expect(mainOf(manualRead)(['--requested', 'bar-of-america'], deps)).rejects.toThrow('grant_call_failed');
    expect(rec.http).toHaveLength(0);
  });
  it('--requests prints the formatRequests lines and reads nothing', async () => {
    const pending = [
      { slug: 'bar-of-america', requestedAt: '2026-11-02T02:40:00.000Z', nextDueAt: null },
      { slug: 'diamond-peak', requestedAt: '2026-11-02T02:41:00.000Z', nextDueAt: '2999-01-01T17:17:00.000Z' },
    ];
    const { deps, rec } = fakeDeps({ pending });
    expect(await mainOf(manualRead)(['--requests'], deps)).toBe(0);
    expect(rec.logs).toHaveLength(2);
    expect(rec.logs[0]).toMatch(/^bar-of-america · requested .+ PT · readable now$/u);
    expect(rec.logs[1]).toMatch(/^diamond-peak · requested .+ PT · readable after .+ PT$/u);
    expect(rec.grant).toHaveLength(0);
    expect(rec.http).toHaveLength(0);
  });
  it('--requests with nothing pending prints "no pending read requests"', async () => {
    const { deps, rec } = fakeDeps({ pending: [] });
    expect(await mainOf(manualRead)(['--requests'], deps)).toBe(0);
    expect(rec.logs).toEqual(['no pending read requests']);
  });
  it('--requests --slugs prints only the slugs, one per line', async () => {
    const pending = [
      { slug: 'bar-of-america', requestedAt: '2026-11-02T02:40:00.000Z', nextDueAt: null },
      { slug: 'tdrpd-rec1', requestedAt: '2026-11-02T02:41:00.000Z', nextDueAt: null },
    ];
    const { deps, rec } = fakeDeps({ pending });
    expect(await mainOf(manualRead)(['--requests', '--slugs'], deps)).toBe(0);
    expect(rec.logs).toEqual(['bar-of-america', 'tdrpd-rec1']);
    expect(rec.grant).toHaveLength(0);
  });
  it('tdrpd-rec1 stays refused here with the usage line (exit 1, no grant)', async () => {
    const { deps, rec } = fakeDeps();
    expect(await mainOf(manualRead)(['tdrpd-rec1'], deps)).toBe(1);
    expect(rec.logs.some((l) => l.includes('usage: manual-read.ts <slug>'))).toBe(true);
    expect(rec.grant).toHaveLength(0);
  });
});

describe('tdrpd-refresh.ts main(argv, deps)', () => {
  const sqlRows = [{ config: {}, ok: true }];
  it("--requested -> manualGrant('tdrpd-rec1', { requested: true })", async () => {
    const { deps, rec } = fakeDeps({ sqlRows });
    await mainOf(tdrpd)(['--requested'], deps);
    expect(rec.grant).toEqual([['tdrpd-rec1', { requested: true }]]);
  });
  it('a withdrawn request -> exit 3, "request withdrawn: nothing read", zero source requests', async () => {
    const { deps, rec } = fakeDeps({ sqlRows, grant: async () => ({ grant: '', refused: 'withdrawn' }) });
    expect(await mainOf(tdrpd)(['--requested'], deps)).toBe(3);
    expect(rec.logs.some((l) => l.includes('request withdrawn: nothing read'))).toBe(true);
    expect(rec.http).toHaveLength(0);
    expect(rec.curlHttp).toBe(0);
    expect(rec.submit).toHaveLength(0);
  });
  it("no flag -> manualGrant('tdrpd-rec1', { requested: false }); a gated grant exits 3 with zero requests", async () => {
    const { deps, rec } = fakeDeps({ sqlRows });
    expect(await mainOf(tdrpd)([], deps)).toBe(3);
    expect(rec.grant).toEqual([['tdrpd-rec1', { requested: false }]]);
    expect(rec.http).toHaveLength(0);
  });
  it('manualGrant rejecting grant_call_failed -> main rejects, zero source requests', async () => {
    const { deps, rec } = fakeDeps({ sqlRows, grant: () => Promise.reject(new Error('grant_call_failed')) });
    await expect(mainOf(tdrpd)(['--requested'], deps)).rejects.toThrow('grant_call_failed');
    expect(rec.http).toHaveLength(0);
  });
});
