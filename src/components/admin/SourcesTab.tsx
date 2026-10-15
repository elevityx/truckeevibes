'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminSetSourceEnabled,
  adminSetSourceTrust,
  adminSourceHealth,
  toDataError,
  userMessage,
  type SourceHealthRow,
  type SourceTrust,
} from '@/lib/data';
import { formatDay } from '@/lib/time/pacific';
import { ago } from './format';
import { amberReason, redReason, sourceHealth, type Health } from './sourceHealth';

const TRUSTS: SourceTrust[] = ['auto', 'review', 'link_only'];
const LABEL: Record<Health, string> = { red: 'Needs attention', amber: 'Check soon', green: 'Healthy', off: 'Off' };

/** Source health board: one row per source with its status, last runs, open cards and the enable / trust controls. */
export default function SourcesTab({ onForbidden }: { onForbidden(): void }) {
  const [rows, setRows] = useState<SourceHealthRow[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setRows(await adminSourceHealth());
      setNow(Date.now());
      setErr('');
    } catch (e) {
      const d = toDataError(e);
      if (d.code === 'forbidden') return onForbidden();
      setErr(userMessage(d));
    }
  }, [onForbidden]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function act(slug: string, fn: () => Promise<void>) {
    setBusy(slug);
    setErr('');
    try {
      await fn();
      await load();
    } catch (e) {
      const d = toDataError(e);
      if (d.code === 'forbidden') return onForbidden();
      setErr(userMessage(d));
    } finally {
      setBusy('');
    }
  }

  const when = new Date(now);
  return (
    <div className="panel">
      <h3>Sources</h3>
      {err && <p className="err" role="alert">{err}</p>}
      {rows === null ? (
        <p className="fine">Loading…</p>
      ) : (
        <ul className="hlist">
          {rows.map((r) => {
            const h = sourceHealth(r, when);
            const why = h === 'red' ? redReason(r, when) : h === 'amber' ? amberReason(r, when) : null;
            const last = r.lastRuns[0];
            return (
              <li key={r.slug} className={`hrow ${h}`}>
                <div className="hmain">
                  <span className={`hdot ${h}`} aria-hidden="true" />
                  <div>
                    <span className="src-name">{r.name}</span>
                    <span className="src-meta">
                      {' '}
                      {LABEL[h]}
                      {why ? `: ${why}` : ''}
                    </span>
                    <p className="src-meta">
                      {r.slug} · every {r.cadence} · {r.ingestDisposition} · last read {ago(r.lastSuccessAt, now)}
                      {last ? ` · last run ${last.status} (${last.found} found, ${last.new} new)` : ''}
                    </p>
                    <p className="src-meta">
                      {r.openCards7d} open cards this week · {r.heldRunsPending} held {r.heldRunsPending === 1 ? 'run' : 'runs'}
                      {r.termsRecheckAt ? ` · terms re-check ${formatDay(r.termsRecheckAt, 'America/Los_Angeles')}` : ''}
                    </p>
                  </div>
                </div>
                <div className="hctl">
                  <select
                    className="field"
                    aria-label={`Trust for ${r.name}`}
                    value={r.trust}
                    disabled={busy === r.slug}
                    onChange={(ev) => void act(r.slug, () => adminSetSourceTrust(r.slug, ev.target.value as SourceTrust))}
                  >
                    {TRUSTS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy === r.slug}
                    onClick={() => void act(r.slug, () => adminSetSourceEnabled(r.slug, !r.enabled))}
                  >
                    {r.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
