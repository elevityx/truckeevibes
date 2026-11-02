// AC-SV2-34 (Spec_Sources_V2 §10 jobs.ts): the Jobs panel's pure join and labels.
import { describe, expect, it } from 'vitest';
import type { IngestBatch, JobRun, ManualRead, StampRow } from '@/lib/data/adminJobs';
import type { GhRebuildRun, GhRun } from '@/lib/data/github';
import { ago } from './format';
import { PUBLIC_NOTICE } from './runNow';
import {
  HOOK_STEP, batchSummary, eventLabel, joinBatches, manualText, matchText, noticeLines, rebuildReason, runLabel, runNowLabel, stampText,
  visibleRuns,
} from './jobs';

const T0 = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60_000;
const NOW = T0 + 6 * 60 * MIN;
const iso = (m: number) => new Date(T0 + m * MIN).toISOString(); // T0 + m minutes

let nextId = 1000;
function run(o: Partial<GhRun> & { start?: number | null; end?: number; created?: number } = {}): GhRun {
  const { start = 0, end = 10, created, ...rest } = o;
  const id = nextId++;
  return {
    id, attempt: 1, event: 'schedule', status: 'completed', conclusion: 'success',
    createdAt: iso(created ?? (start ?? 0)), startedAt: start === null ? null : iso(start), updatedAt: iso(end),
    url: `https://github.com/elevityx/truckeevibes/actions/runs/${id}`, ...rest,
  };
}
const jr = (slug: string, status = 'ok', found = 3): JobRun => ({
  slug, status, found, new: 0, changed: 0, errorCode: status === 'ok' ? null : status, finishedAt: iso(5),
});
function batch(m: number, o: Partial<IngestBatch> = {}): IngestBatch {
  return { issuedAt: iso(m), grants: 1, pending: 0, unused: 0, runNow: [], runs: [jr('alibi-truckee')], ...o };
}

describe('joinBatches', () => {
  it('one run, one batch inside its window -> likely', () => {
    const r = run({ start: 0, end: 10 });
    const b = batch(2);
    const m = joinBatches([b], [r], NOW);
    expect(m.get(b.issuedAt)).toEqual({ run: r, why: 'likely' });
  });
  it('two adjacent runs whose windows both hold the batch -> ambiguous', () => {
    const a = run({ start: 0, end: 10 });
    const c = run({ start: 5, end: 20 });
    const b = batch(7);
    expect(joinBatches([b], [c, a], NOW).get(b.issuedAt)).toEqual({ run: null, why: 'ambiguous' });
  });
  it('a run holding two batches -> both ambiguous', () => {
    const r = run({ start: 0, end: 10 });
    const b1 = batch(2);
    const b2 = batch(4);
    const m = joinBatches([b2, b1], [r], NOW);
    expect(m.get(b1.issuedAt)).toEqual({ run: null, why: 'ambiguous' });
    expect(m.get(b2.issuedAt)).toEqual({ run: null, why: 'ambiguous' });
  });
  it('a batch before an attempt-2 run\'s startedAt -> none (the rerun did not issue it)', () => {
    const r = run({ attempt: 2, created: 0, start: 60, end: 70 });
    const b = batch(5);
    expect(joinBatches([b], [r], NOW).get(b.issuedAt)).toEqual({ run: null, why: 'none' });
  });
  it('a batch older than every listed run -> older', () => {
    const r = run({ start: 60, end: 70 });
    const b = batch(-30);
    expect(joinBatches([b], [r], NOW).get(b.issuedAt)).toEqual({ run: null, why: 'older' });
  });
  it('a run that is not completed has the window [startedAt, now]', () => {
    const r = run({ start: 0, end: 1, status: 'in_progress', conclusion: null });
    const b = batch(30);
    expect(joinBatches([b], [r], NOW).get(b.issuedAt)).toEqual({ run: r, why: 'likely' });
  });
  it('a run with startedAt null is never a candidate (and is labelled Queued)', () => {
    const q = run({ created: 0, start: null, end: 0, status: 'queued', conclusion: null });
    const b = batch(2);
    expect(joinBatches([b], [q], NOW).get(b.issuedAt)).toEqual({ run: null, why: 'none' });
    expect(runLabel(q)).toBe('Queued');
  });
});

// grok r3 P2 / astra spec-r1 P2: 10 newer cancelled dispatches must not hide the run that holds the batch.
describe('the cancelled-dispatch fixture', () => {
  const holder = run({ start: 0, end: 8 });
  const cancelled = Array.from({ length: 10 }, (_, i) =>
    run({ event: 'workflow_dispatch', conclusion: 'cancelled', start: 20 + i * 2, end: 20 + i * 2 + 1 }),
  ).reverse(); // newest first, like GitHub
  const runs = [...cancelled, holder];
  const b = batch(3, { runNow: ['alibi-truckee'] });

  it('the join still matches the 11th run', () => {
    expect(joinBatches([b], runs, NOW).get(b.issuedAt)).toEqual({ run: holder, why: 'likely' });
  });
  it('visibleRuns keeps the newest 10 plus the older likely run, newest first, no duplicates', () => {
    const m = joinBatches([b], runs, NOW);
    const v = visibleRuns(runs, m);
    expect(v).toHaveLength(11);
    expect(v.slice(0, 10)).toEqual(cancelled);
    expect(v[10]).toBe(holder);
    expect(new Set(v.map((r) => r.id)).size).toBe(11);
  });
  it('visibleRuns caps unmatched older runs', () => {
    const older = run({ start: -100, end: -90 });
    const m = joinBatches([b], [...runs, older], NOW);
    expect(visibleRuns([...runs, older], m)).not.toContain(older);
    expect(visibleRuns([...runs, older], m, 3)).toEqual([...cancelled.slice(0, 3), holder]);
  });
});

describe('labels', () => {
  it('eventLabel', () => {
    expect(eventLabel('schedule')).toBe('Scheduled');
    expect(eventLabel('workflow_dispatch')).toBe('Started by hand (Run now or gh)');
    expect(eventLabel('push')).toBe('push');
  });
  it('runLabel', () => {
    expect(runLabel(run({ status: 'in_progress', conclusion: null }))).toBe('Running');
    expect(runLabel(run({ status: 'queued', conclusion: null }))).toBe('Queued');
    expect(runLabel(run({ status: 'waiting', conclusion: null }))).toBe('Queued');
    expect(runLabel(run({ conclusion: 'success' }))).toBe('Succeeded');
    expect(runLabel(run({ conclusion: 'failure' }))).toBe('Failed');
    expect(runLabel(run({ conclusion: 'cancelled' }))).toBe('Cancelled (usually replaced by a newer queued run)');
    expect(runLabel(run({ conclusion: 'skipped' }))).toBe('skipped');
  });
  it('matchText', () => {
    expect(matchText({ run: run(), why: 'likely' })).toBe('likely run');
    expect(matchText({ run: null, why: 'none' })).toBe('not matched to a GitHub run');
    expect(matchText({ run: null, why: 'ambiguous' })).toBe('not matched to a GitHub run');
    expect(matchText({ run: null, why: 'older' })).toBe('older than the GitHub list');
  });
});

describe('batchSummary (astra R3-4: "no result recorded")', () => {
  it('counts ok (ok + not_modified), failed and unused', () => {
    const b = batch(0, { grants: 4, unused: 1, runs: [jr('a'), jr('b', 'not_modified'), jr('c', 'http_error')] });
    expect(batchSummary(b)).toBe('4 sources: 2 ok, 1 failed, 1 no result recorded');
  });
  it('adds "being read" only when grants are pending', () => {
    const b = batch(0, { grants: 3, pending: 2, unused: 0, runs: [jr('a')] });
    expect(batchSummary(b)).toBe('3 sources: 1 ok, 0 failed, 0 no result recorded, 2 being read');
  });
  it('never says "did not finish reading"', () => {
    expect(batchSummary(batch(0, { grants: 2, unused: 2, runs: [] }))).not.toMatch(/did not finish reading/);
  });
});

describe('runNowLabel', () => {
  it('null without a Run now', () => {
    expect(runNowLabel(batch(0))).toBeNull();
  });
  it('the slug with its run result', () => {
    expect(runNowLabel(batch(0, { runNow: ['alibi-truckee'], runs: [jr('alibi-truckee', 'ok', 9)] }))).toBe('Run now: alibi-truckee (ok, 9 found)');
  });
  it('no run and unused grants -> no result recorded; pending -> being read', () => {
    expect(runNowLabel(batch(0, { runNow: ['alibi-truckee'], runs: [], unused: 1 }))).toBe('Run now: alibi-truckee (no result recorded)');
    expect(runNowLabel(batch(0, { runNow: ['alibi-truckee'], runs: [], pending: 1 }))).toBe('Run now: alibi-truckee (being read)');
  });
  it('two batches with run_now ["alibi-truckee"] are both labelled (grok r3 P2)', () => {
    const b1 = batch(0, { runNow: ['alibi-truckee'], runs: [jr('alibi-truckee', 'ok', 2)] });
    const b2 = batch(-300, { runNow: ['alibi-truckee'], runs: [jr('alibi-truckee', 'ok', 4)] });
    expect(runNowLabel(b1)).toBe('Run now: alibi-truckee (ok, 2 found)');
    expect(runNowLabel(b2)).toBe('Run now: alibi-truckee (ok, 4 found)');
  });
});

describe('rebuildReason and noticeLines (#13)', () => {
  const rb = (o: Partial<GhRebuildRun>): GhRebuildRun => ({ ...run({ event: 'schedule' }), ...o });
  const HASH13 =
    "Failed at 'Call the Pages deploy hook' · possible cause: PAGES_DEPLOY_HOOK_URL missing (#13)";
  it('HOOK_STEP is the pinned workflow step name', () => {
    expect(HOOK_STEP).toBe('Call the Pages deploy hook');
  });
  it('failure at HOOK_STEP -> the exact #13 possible-cause sentence', () => {
    expect(rebuildReason(rb({ conclusion: 'failure', failedStep: HOOK_STEP }))).toBe(HASH13);
  });
  it('failure at another step, and with no step data', () => {
    expect(rebuildReason(rb({ conclusion: 'failure', failedStep: 'Checkout' }))).toBe("Failed at 'Checkout'");
    expect(rebuildReason(rb({ conclusion: 'failure', failedStep: null }))).toBe('Failed (see log)');
    expect(rebuildReason(rb({ conclusion: 'failure' }))).toBe('Failed (see log)');
  });
  it('not a failure -> null', () => {
    expect(rebuildReason(rb({ conclusion: 'success' }))).toBeNull();
    expect(rebuildReason(rb({ status: 'in_progress', conclusion: null }))).toBeNull();
  });
  const LINE13 =
    'Daily rebuild is failing (possible cause: PAGES_DEPLOY_HOOK_URL missing, #13), so the build snapshot refreshes only when a Pages build is run. The live list is not affected.';
  it('noticeLines adds the #13 line only when the latest rebuild failed', () => {
    expect(noticeLines(null)).toEqual([PUBLIC_NOTICE]);
    expect(noticeLines([])).toEqual([PUBLIC_NOTICE]);
    expect(noticeLines([rb({ conclusion: 'success' }), rb({ conclusion: 'failure' })])).toEqual([PUBLIC_NOTICE]);
    expect(noticeLines([rb({ conclusion: 'failure', failedStep: HOOK_STEP }), rb({ conclusion: 'success' })])).toEqual([PUBLIC_NOTICE, LINE13]);
  });
  it('no notice text claims the live list waits for a build (astra spec-r1 P2)', () => {
    for (const l of noticeLines([rb({ conclusion: 'failure' })])) {
      expect(l).not.toMatch(/live list[^.;]*(wait|after|until|next)[^.;]*build/i);
    }
  });
});

describe('manualText', () => {
  const m = (o: Partial<ManualRead>): ManualRead => ({ issuedAt: iso(0), slug: 'bar-of-america', requested: false, state: 'done', run: null, ...o });
  it('done with a run', () => {
    expect(manualText(m({ run: jr('bar-of-america', 'ok', 4) }))).toBe('bar-of-america · ok, 4 found');
    expect(manualText(m({ requested: true, run: jr('bar-of-america', 'ok', 4) }))).toBe('bar-of-america · requested · ok, 4 found');
  });
  it('reading and no result', () => {
    expect(manualText(m({ state: 'reading' }))).toBe('bar-of-america · being read');
    expect(manualText(m({ state: 'no_result', requested: true }))).toBe('bar-of-america · requested · no result recorded');
  });
});

describe('stampText (pending -> expired -> served, the runNowView order)', () => {
  const s = (o: Partial<StampRow>): StampRow => ({
    slug: 'alibi-truckee', name: 'Alibi Ale Works', kind: 'run_now', requestedAt: null, servedAt: null, pending: false, expired: false, ...o,
  });
  it('pending -> queued', () => {
    expect(stampText(s({ requestedAt: iso(300), pending: true }), NOW)).toBe(`Run now · Alibi Ale Works · queued ${ago(iso(300), NOW)}`);
  });
  it('expired -> expired unread', () => {
    expect(stampText(s({ requestedAt: iso(0), expired: true }), NOW)).toBe(
      `Run now · Alibi Ale Works · expired unread (requested ${ago(iso(0), NOW)})`,
    );
  });
  it('served -> done', () => {
    expect(stampText(s({ servedAt: iso(100) }), NOW)).toBe(`Run now · Alibi Ale Works · done ${ago(iso(100), NOW)}`);
  });
  it('a re-stamp after a serve (both times set, pending) reads "queued" (grok spec-r1 P2)', () => {
    expect(stampText(s({ requestedAt: iso(300), servedAt: iso(100), pending: true }), NOW)).toBe(
      `Run now · Alibi Ale Works · queued ${ago(iso(300), NOW)}`,
    );
  });
  it('the Read request kind', () => {
    expect(stampText(s({ kind: 'read_request', name: 'Bar of America', requestedAt: iso(300), pending: true }), NOW)).toBe(
      `Read request · Bar of America · queued ${ago(iso(300), NOW)}`,
    );
    expect(stampText(s({ kind: 'read_request', name: 'Bar of America', servedAt: iso(100) }), NOW)).toBe(
      `Read request · Bar of America · done ${ago(iso(100), NOW)}`,
    );
  });
});
