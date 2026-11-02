// Sources V2 (§10): the Jobs panel's pure join of DB grant batches to GitHub Ingest runs, and its labels. A batch is matched to a run
// only when each is the other's single candidate ("likely run"); no GitHub run id is stored, so nothing here claims more.
import type { IngestBatch, ManualRead, StampRow } from '@/lib/data/adminJobs';
import type { GhRebuildRun, GhRun } from '@/lib/data/github';
import { ago } from './format';
import { PUBLIC_NOTICE } from './runNow';

export const HOOK_STEP = 'Call the Pages deploy hook'; // pinned at scripts/check-workflows.mjs:34

export type Match = { run: GhRun; why: 'likely' } | { run: null; why: 'none' | 'ambiguous' | 'older' };

function windowOf(r: GhRun, now: number): [number, number] | null {
  if (r.startedAt === null) return null;
  return [Date.parse(r.startedAt), r.status === 'completed' ? Date.parse(r.updatedAt) : now];
}

/** Called with EVERY parsed ingest run (never the display slice). Key = issuedAt. */
export function joinBatches(batches: IngestBatch[], runs: GhRun[], now: number): Map<string, Match> {
  const wins = runs.map((r) => ({ r, w: windowOf(r, now) }));
  const holds = (w: [number, number] | null, at: number) => w !== null && at >= w[0] && at <= w[1];
  const runsOf = new Map<string, GhRun[]>();
  const batchesOf = new Map<number, number>();
  for (const b of batches) {
    const at = Date.parse(b.issuedAt);
    const c = wins.filter((x) => holds(x.w, at)).map((x) => x.r);
    runsOf.set(b.issuedAt, c);
    for (const r of c) batchesOf.set(r.id, (batchesOf.get(r.id) ?? 0) + 1);
  }
  const oldest = runs.length ? Math.min(...runs.map((r) => Date.parse(r.createdAt))) : -Infinity;
  const out = new Map<string, Match>();
  for (const b of batches) {
    const c = runsOf.get(b.issuedAt) ?? [];
    if (c.length === 1 && batchesOf.get(c[0].id) === 1) out.set(b.issuedAt, { run: c[0], why: 'likely' });
    else if (c.length >= 2 || (c.length === 1 && (batchesOf.get(c[0].id) ?? 0) >= 2)) out.set(b.issuedAt, { run: null, why: 'ambiguous' });
    else if (Date.parse(b.issuedAt) < oldest) out.set(b.issuedAt, { run: null, why: 'older' });
    else out.set(b.issuedAt, { run: null, why: 'none' });
  }
  return out;
}

export function eventLabel(e: string): string {
  if (e === 'schedule') return 'Scheduled';
  if (e === 'workflow_dispatch') return 'Started by hand (Run now or gh)';
  return e;
}

export function runLabel(r: GhRun): string {
  if (r.status !== 'completed') return r.status === 'in_progress' ? 'Running' : 'Queued';
  if (r.conclusion === 'success') return 'Succeeded';
  if (r.conclusion === 'failure') return 'Failed';
  if (r.conclusion === 'cancelled') return 'Cancelled (usually replaced by a newer queued run)';
  return r.conclusion ?? r.status;
}

const OK = ['ok', 'not_modified'];

export function batchSummary(b: IngestBatch): string {
  const ok = b.runs.filter((r) => OK.includes(r.status)).length;
  const failed = b.runs.length - ok;
  return `${b.grants} sources: ${ok} ok, ${failed} failed, ${b.unused} no result recorded${b.pending > 0 ? `, ${b.pending} being read` : ''}`;
}

export function runNowLabel(b: IngestBatch): string | null {
  if (b.runNow.length === 0) return null;
  const parts = b.runNow.map((slug) => {
    const r = b.runs.find((x) => x.slug === slug);
    if (r) return `${slug} (${r.status}, ${r.found} found)`;
    return `${slug} (${b.pending > 0 ? 'being read' : 'no result recorded'})`;
  });
  return `Run now: ${parts.join(', ')}`;
}

export function matchText(m: Match): string {
  if (m.why === 'likely') return 'likely run';
  if (m.why === 'older') return 'older than the GitHub list';
  return 'not matched to a GitHub run';
}

export function rebuildReason(r: GhRebuildRun): string | null {
  if (r.conclusion !== 'failure') return null;
  if (r.failedStep === HOOK_STEP) return `Failed at '${HOOK_STEP}' · possible cause: PAGES_DEPLOY_HOOK_URL missing (#13)`;
  if (typeof r.failedStep === 'string') return `Failed at '${r.failedStep}'`;
  return 'Failed (see log)';
}

export function manualText(m: ManualRead): string {
  const head = `${m.slug}${m.requested ? ' · requested' : ''}`;
  if (m.run) return `${head} · ${m.run.status}, ${m.run.found} found`;
  return `${head} · ${m.state === 'reading' ? 'being read' : 'no result recorded'}`;
}

export function stampText(s: StampRow, now: number): string {
  const head = `${s.kind === 'run_now' ? 'Run now' : 'Read request'} · ${s.name}`;
  if (s.pending) return `${head} · queued ${ago(s.requestedAt, now)}`;
  if (s.expired) return `${head} · expired unread (requested ${ago(s.requestedAt, now)})`;
  if (s.servedAt) return `${head} · done ${ago(s.servedAt, now)}`;
  return head;
}

/** The newest `cap` runs, plus every older run that is the `likely` match of a batch, newest first (list order), no duplicates. */
export function visibleRuns(runs: GhRun[], matches: Map<string, Match>, cap = 10): GhRun[] {
  const held = new Set<number>();
  for (const m of matches.values()) if (m.why === 'likely') held.add(m.run.id);
  const seen = new Set<number>();
  return runs.filter((r, i) => {
    if (seen.has(r.id)) return false;
    const keep = i < cap || held.has(r.id);
    if (keep) seen.add(r.id);
    return keep;
  });
}

export function noticeLines(rebuild: GhRebuildRun[] | null): string[] {
  const lines = [PUBLIC_NOTICE];
  if (rebuild && rebuild[0]?.conclusion === 'failure') {
    lines.push('Daily rebuild is failing (possible cause: PAGES_DEPLOY_HOOK_URL missing, #13), so the build snapshot refreshes only when a Pages build is run. The live list is not affected.');
  }
  return lines;
}
