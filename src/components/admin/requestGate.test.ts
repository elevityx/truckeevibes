// AC-M1-79 (a-c): generation-token gate for admin loads. Interface assumption (spec A7-5): createRequestGate, gated.
import { describe, expect, it } from 'vitest';
import type { QueueCard } from '@/lib/data/adminQueue';
import { initialQueueState, queueReducer } from './queueState';
import { createRequestGate, gated } from './requestGate';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('gated', () => {
  it('L2 then L1 resolving: only L2 applies, L1 is stale', async () => {
    const g = createRequestGate();
    const d1 = deferred<string>(); const d2 = deferred<string>();
    const applied: string[] = [];
    const p1 = gated(g, () => d1.promise, (v) => applied.push(v));
    const p2 = gated(g, () => d2.promise, (v) => applied.push(v));
    d2.resolve('L2'); d1.resolve('L1');
    expect(await p2).toBe('applied');
    expect(await p1).toBe('stale');
    expect(applied).toEqual(['L2']);
  });
  it('L1 then L2 resolving: L1 is already stale once L2 began, last applied value is L2', async () => {
    const g = createRequestGate();
    const d1 = deferred<string>(); const d2 = deferred<string>();
    const applied: string[] = [];
    const p1 = gated(g, () => d1.promise, (v) => applied.push(v));
    const p2 = gated(g, () => d2.promise, (v) => applied.push(v));
    d1.resolve('L1'); d2.resolve('L2');
    await Promise.all([p1, p2]);
    expect(applied[applied.length - 1]).toBe('L2');
  });
  it('sequential loads both apply', async () => {
    const g = createRequestGate();
    const applied: string[] = [];
    expect(await gated(g, async () => 'a', (v) => applied.push(v))).toBe('applied');
    expect(await gated(g, async () => 'b', (v) => applied.push(v))).toBe('applied');
    expect(applied).toEqual(['a', 'b']);
  });
  it('a stale rejection is swallowed; a current rejection rethrows', async () => {
    const g = createRequestGate();
    const d1 = deferred<string>();
    const p1 = gated(g, () => d1.promise, () => {});
    const p2 = gated(g, async () => 'ok', () => {});
    d1.reject(new Error('late'));
    expect(await p1).toBe('stale');
    expect(await p2).toBe('applied');
    await expect(gated(g, async () => { throw new Error('boom'); }, () => {})).rejects.toThrow('boom');
  });
  it('invalidate() makes an in-flight load stale', async () => {
    const g = createRequestGate();
    const d = deferred<string>();
    const applied: string[] = [];
    const p = gated(g, () => d.promise, (v) => applied.push(v));
    g.invalidate();
    d.resolve('x');
    expect(await p).toBe('stale');
    expect(applied).toEqual([]);
  });
});

const card = (id: string) => ({ id, kind: 'source_budget', createdAt: '2026-11-05T00:00:00Z', openedAt: null, sourceId: null, event: null, sources: [], duplicates: [], otherEvent: null, heldRun: null }) as QueueCard;

describe('queue ordering with the gate', () => {
  it('a load begun before a decision cannot re-add the decided card', async () => {
    const g = createRequestGate();
    let state = queueReducer(initialQueueState, { type: 'loaded', cards: [card('A')] });
    const l1 = deferred<QueueCard[]>();
    const p1 = gated(g, () => l1.promise, (cards) => { state = queueReducer(state, { type: 'loaded', cards }); });
    g.invalidate();
    state = queueReducer(state, { type: 'decide_start', id: 'A' });
    state = queueReducer(state, { type: 'decided', id: 'A' });
    l1.resolve([card('A')]);
    expect(await p1).toBe('stale');
    expect(state.cards.map((c) => c.id)).not.toContain('A');
  });
  it('a load that resolves first applies, then the decision removes the card', async () => {
    const g = createRequestGate();
    let state = initialQueueState;
    await gated(g, async () => [card('A')], (cards) => { state = queueReducer(state, { type: 'loaded', cards }); });
    expect(state.cards.map((c) => c.id)).toEqual(['A']);
    g.invalidate();
    state = queueReducer(state, { type: 'decide_start', id: 'A' });
    state = queueReducer(state, { type: 'decided', id: 'A' });
    expect(state.cards.map((c) => c.id)).not.toContain('A');
  });
});

describe('sources ordering with the gate', () => {
  async function run(order: 'L2 first' | 'L1 first') {
    const g = createRequestGate();
    let rows = 'none';
    g.invalidate(); // mutation M1
    const d1 = deferred<string>();
    const p1 = gated(g, () => d1.promise, (v) => { rows = v; });
    g.invalidate(); // mutation M2
    const d2 = deferred<string>();
    const p2 = gated(g, () => d2.promise, (v) => { rows = v; });
    if (order === 'L2 first') { d2.resolve('L2'); d1.resolve('L1'); } else { d1.resolve('L1'); d2.resolve('L2'); }
    await Promise.all([p1, p2]);
    return rows;
  }
  it('L2 then L1: final rows are L2', async () => expect(await run('L2 first')).toBe('L2'));
  it('L1 then L2: final rows are L2', async () => expect(await run('L1 first')).toBe('L2'));
});
