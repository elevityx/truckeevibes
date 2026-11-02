// @vitest-environment happy-dom
// AC-SV2-35 (Spec_Sources_V2 §10 DOM tests): the Jobs tab mounted in a DOM with adminJobs and the GitHub reader mocked. It loads once,
// on the first show; it renders the batch matched to the 11th GitHub run (astra spec-r1 P2); a paused GitHub reader and a failed
// adminJobs each degrade one part only; a rebuild that failed at the deploy-hook step shows the #13 possible cause.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adminJobs = vi.fn();
const load = vi.fn();
const canRefresh = vi.fn(() => true);
const createGithubReader = vi.fn(() => ({ load: (force?: boolean) => load(force), canRefresh: () => canRefresh() }));

vi.mock('@/lib/data', async () => {
  const errors = await vi.importActual<typeof import('@/lib/data/errors')>('@/lib/data/errors');
  const types = await vi.importActual<typeof import('@/lib/data/types')>('@/lib/data/types');
  return { ...types, ...errors, adminJobs: (...a: unknown[]) => adminJobs(...a) };
});
vi.mock('@/lib/data/github', () => ({
  GH_API: 'https://api.github.com/repos/elevityx/truckeevibes',
  RUN_URL_RE: /^https:\/\/github\.com\/elevityx\/truckeevibes\/actions\/runs\/\d+$/,
  createGithubReader: (...a: unknown[]) => createGithubReader(...(a as [])),
}));

import { DataError } from '@/lib/data/types';
import JobsTab from './JobsTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-11-01T20:00:00Z');
const at = (hhmmss: string) => `2026-11-01T${hhmmss}Z`;
const url = (id: number) => `https://github.com/elevityx/truckeevibes/actions/runs/${id}`;

// The cancelled-dispatch fixture: the 10 newest runs are cancelled workflow_dispatch runs (18:10 .. 18:19, 20 s each); the 11th, the
// scheduled run 18:00:10 .. 18:05:00, is the only one whose window holds the batch issued at 18:00:30.
const CANCELLED = Array.from({ length: 10 }, (_, i) => {
  const m = String(19 - i).padStart(2, '0');
  return {
    id: 9000 + (10 - i), attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'cancelled',
    createdAt: at(`18:${m}:00`), startedAt: at(`18:${m}:05`), updatedAt: at(`18:${m}:25`), url: url(9000 + (10 - i)),
  };
});
const ELEVENTH = {
  id: 8999, attempt: 1, event: 'schedule', status: 'completed', conclusion: 'success',
  createdAt: at('18:00:00'), startedAt: at('18:00:10'), updatedAt: at('18:05:00'), url: url(8999),
};
const INGEST = [...CANCELLED, ELEVENTH];
const BATCH = {
  issuedAt: at('18:00:30'), grants: 3, pending: 0, unused: 1, runNow: ['alibi-truckee'],
  runs: [
    { slug: 'alibi-truckee', status: 'ok', found: 4, new: 1, changed: 0, errorCode: null, finishedAt: at('18:01:30') },
    { slug: 'moodys-bistro', status: 'http_error', found: 0, new: 0, changed: 0, errorCode: 'http_500', finishedAt: at('18:02:00') },
  ],
};
const JOBS = { generatedAt: new Date(NOW).toISOString(), batches: [BATCH], manual: [], stamps: [] };
const REBUILD_OK = {
  id: 7001, attempt: 1, event: 'schedule', status: 'completed', conclusion: 'success',
  createdAt: at('13:00:00'), startedAt: at('13:00:05'), updatedAt: at('13:00:40'), url: url(7001),
};
const REBUILD_HOOK_FAIL = { ...REBUILD_OK, id: 7002, conclusion: 'failure', failedStep: 'Call the Pages deploy hook', url: url(7002) };
const ghOk = (rebuild: unknown[] = [REBUILD_OK]) => ({ ok: true, ingest: INGEST, rebuild, fetchedAt: NOW });

let root: Root | null = null;
let box: HTMLElement;
const onForbidden = vi.fn();
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function settle() {
  for (let i = 0; i < 5; i++) await flush();
}
async function render(active: boolean) {
  if (!root) {
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
  }
  await act(async () => { root!.render(createElement(JobsTab, { onForbidden, active })); });
  await settle();
}
const text = () => (box.textContent ?? '').replace(/\s+/g, ' ');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  for (const f of [adminJobs, load, onForbidden, createGithubReader]) f.mockClear();
  adminJobs.mockReset();
  load.mockReset();
  adminJobs.mockResolvedValue(JOBS);
  load.mockResolvedValue(ghOk());
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  box?.remove();
  vi.useRealTimers();
});

describe('AC-SV2-35 Jobs tab: loads once, on the first show', () => {
  it('mounted with active=false: no load', async () => {
    await render(false);
    expect(adminJobs).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('the first active=true loads adminJobs(10) and the reader once each; toggling active again does not reload', async () => {
    await render(false);
    await render(true);
    expect(adminJobs).toHaveBeenCalledTimes(1);
    expect(adminJobs).toHaveBeenCalledWith(10);
    expect(load).toHaveBeenCalledTimes(1);
    await render(false);
    await render(true);
    expect(adminJobs).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('AC-SV2-35 Jobs tab: the batch matched to the 11th run is rendered', () => {
  it('shows batchSummary, runNowLabel and the likely-run link of the 11th run', async () => {
    await render(true);
    const t = text();
    expect(t).toContain('Ingest runs');
    expect(t).toContain('3 sources: 1 ok, 1 failed, 1 no result recorded');
    expect(t).toContain('Run now: alibi-truckee (ok, 4 found)');
    const links = [...box.querySelectorAll<HTMLAnchorElement>('a')].filter((a) => (a.textContent ?? '').includes('View on GitHub (likely run)'));
    const eleventh = links.find((a) => a.getAttribute('href') === ELEVENTH.url);
    expect(eleventh, 'likely-run link to the 11th run').toBeDefined();
    expect(eleventh!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(eleventh!.getAttribute('target')).toBe('_blank');
    expect(t).toContain('(older run)');
    expect(t).toContain('Started by hand (Run now or gh)');
    expect(t).toContain('Cancelled (usually replaced by a newer queued run)');
    expect(t).toContain('Site rebuild after a run: not recorded.');
  });
});

describe('AC-SV2-35 Jobs tab: degraded states', () => {
  it('GitHub paused: the paused line, and the DB sections still render', async () => {
    load.mockResolvedValue({ ok: false, reason: 'paused', until: NOW + 30 * 60_000 });
    await render(true);
    expect(text()).toMatch(/GitHub data paused until \d{1,2}:\d{2}.*\(shared hourly limit\)\./);
    expect(text()).not.toContain('Jobs data unavailable.');
  });

  it('adminJobs rejecting: "Jobs data unavailable." while the GitHub sections render', async () => {
    adminJobs.mockRejectedValue(new DataError('unknown'));
    await render(true);
    const t = text();
    expect(t).toContain('Jobs data unavailable.');
    expect(t).toContain('Ingest runs');
    expect(t).toContain('Daily rebuild');
    expect(t).toContain('Started by hand (Run now or gh)');
    expect(onForbidden).not.toHaveBeenCalled();
  });

  it('adminJobs forbidden calls onForbidden', async () => {
    adminJobs.mockRejectedValue(new DataError('forbidden'));
    await render(true);
    expect(onForbidden).toHaveBeenCalled();
  });

  it('a rebuild that failed at HOOK_STEP shows the #13 possible-cause line', async () => {
    load.mockResolvedValue(ghOk([REBUILD_HOOK_FAIL, REBUILD_OK]));
    await render(true);
    expect(text()).toContain("Failed at 'Call the Pages deploy hook' · possible cause: PAGES_DEPLOY_HOOK_URL missing (#13)");
  });
});
