'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminJobs, toDataError, type AdminJobs } from '@/lib/data';
import { createGithubReader, type GhDeps, type GhRun, type GhState } from '@/lib/data/github';
import { dayLabel, localTime } from '@/lib/time/pacific';
import {
  batchSummary, eventLabel, joinBatches, manualText, matchText, noticeLines, rebuildReason, runLabel, runNowLabel, stampText, visibleRuns,
} from './jobs';

const PT = 'America/Los_Angeles';
const CAP = 10;

/** localStorage, or null where it is blocked (private mode, sandboxed frames); every access is also wrapped by the reader. */
function safeLocalStorage(): GhDeps['storage'] {
  try {
    const s = window.localStorage;
    return s ? s : null;
  } catch {
    return null;
  }
}

const stamp = (iso: string) => `${dayLabel(iso, PT)} ${localTime(Date.parse(iso), PT)}`;

function RunLink({ run }: { run: GhRun }) {
  if (!run.url) return null;
  return <> · <a href={run.url} rel="noopener noreferrer" target="_blank">View on GitHub (likely run)</a></>;
}

/** Jobs: recent Ingest runs (GitHub, read from the browser) joined to the DB grant batches, Daily rebuild runs, manual reads and stamps. */
export default function JobsTab({ onForbidden, active }: { onForbidden(): void; active: boolean }) {
  const reader = useRef<ReturnType<typeof createGithubReader> | null>(null);
  const loaded = useRef(false);
  const [jobs, setJobs] = useState<AdminJobs | null>(null);
  const [jobsErr, setJobsErr] = useState(false);
  const [gh, setGh] = useState<GhState | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [refreshable, setRefreshable] = useState(false);

  const getReader = () => {
    if (!reader.current) {
      reader.current = createGithubReader({ fetch: window.fetch.bind(window), now: Date.now, storage: safeLocalStorage() });
    }
    return reader.current;
  };

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    const r = getReader();
    const db = adminJobs(10).then((j) => { setJobs(j); setJobsErr(false); }, (e) => {
      if (toDataError(e).code === 'forbidden') onForbidden();
      else setJobsErr(true);
    });
    const git = r.load(force).then(setGh, () => setGh({ ok: false, reason: 'unavailable' }));
    await Promise.all([db, git]);
    setNow(Date.now());
    setLoading(false);
    setRefreshable(r.canRefresh());
  }, [onForbidden]);

  // Load once, on the first show.
  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    const t = setTimeout(() => void load(false), 0);
    return () => clearTimeout(t);
  }, [active, load]);

  // The Refresh button opens once the GitHub cache is a minute old (and not while paused): re-check it while the tab is showing.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { if (reader.current) setRefreshable(reader.current.canRefresh()); }, 15_000);
    return () => clearInterval(id);
  }, [active]);

  const ingest = gh?.ok ? gh.ingest : [];
  const rebuild = gh?.ok ? gh.rebuild : null;
  const batches = jobs?.batches ?? [];
  const matches = joinBatches(batches, ingest, now);
  const byRun = new Map<number, (typeof batches)[number]>();
  for (const b of batches) {
    const m = matches.get(b.issuedAt);
    if (m?.why === 'likely') byRun.set(m.run.id, b);
  }
  const shown = visibleRuns(ingest, matches, CAP);
  const unmatched = batches.filter((b) => matches.get(b.issuedAt)?.why !== 'likely');

  return (
    <div className="panel">
      <h3>Jobs</h3>
      <section className="jobs-sec">
        {noticeLines(rebuild).map((l) => <p key={l} className="fine">{l}</p>)}
        <div>
          <button type="button" className="btn ghost" disabled={loading || !refreshable} onClick={() => void load(true)}>Refresh</button>
        </div>
        {gh && !gh.ok && gh.reason === 'paused' && (
          <p className="fine">GitHub data paused until {localTime(gh.until, PT)} (shared hourly limit).</p>
        )}
        {gh && !gh.ok && gh.reason === 'unavailable' && <p className="fine">GitHub data unavailable.</p>}
        {jobsErr && <p className="err" role="alert">Jobs data unavailable.</p>}
      </section>

      <section className="jobs-sec">
        <h4>Ingest runs</h4>
        {shown.map((r) => {
          const b = byRun.get(r.id);
          const older = ingest.indexOf(r) >= CAP;
          const rn = b ? runNowLabel(b) : null;
          return (
            <div key={r.id} className="jobs-row">
              {stamp(r.createdAt)}{older ? ' (older run)' : ''} · {eventLabel(r.event)} · {runLabel(r)}
              {b ? ` · ${batchSummary(b)}` : ''}{rn ? ` · ${rn}` : ''}
              {b && <RunLink run={r} />}
            </div>
          );
        })}
        <p className="fine">Site rebuild after a run: not recorded.</p>
        {unmatched.length > 0 && (
          <>
            <h4>Batches not matched to a GitHub run</h4>
            {unmatched.map((b) => {
              const m = matches.get(b.issuedAt);
              const rn = runNowLabel(b);
              return (
                <div key={b.issuedAt} className="jobs-row">
                  {stamp(b.issuedAt)} · {batchSummary(b)}{rn ? ` · ${rn}` : ''}{m ? ` · ${matchText(m)}` : ''}
                </div>
              );
            })}
          </>
        )}
      </section>

      <section className="jobs-sec">
        <h4>Daily rebuild</h4>
        {(rebuild ?? []).slice(0, 5).map((r) => {
          const why = rebuildReason(r);
          return (
            <div key={r.id} className="jobs-row">
              {stamp(r.createdAt)} · {eventLabel(r.event)} · {runLabel(r)}{why ? ` · ${why}` : ''}
              {r.url && <> · <a href={r.url} rel="noopener noreferrer" target="_blank">View on GitHub</a></>}
            </div>
          );
        })}
      </section>

      <section className="jobs-sec">
        <h4>Manual reads</h4>
        {(jobs?.manual ?? []).slice(0, 10).map((m) => (
          <div key={`${m.issuedAt}-${m.slug}`} className="jobs-row">{stamp(m.issuedAt)} · {manualText(m)}</div>
        ))}
      </section>

      <section className="jobs-sec">
        <h4>Requests</h4>
        {(jobs?.stamps ?? []).map((s) => (
          <div key={`${s.kind}-${s.slug}`} className="jobs-row">{stampText(s, now)}</div>
        ))}
      </section>
    </div>
  );
}
