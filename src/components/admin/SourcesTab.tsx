'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminDispatch,
  adminDispatchStatus,
  adminSetForceDue,
  adminSetReadRequest,
  adminSetSourceEnabled,
  adminSetSourceTrust,
  adminSourceHealth,
  toDataError,
  userMessage,
  type DataError,
  type SourceHealthRow,
  type SourceTrust,
} from '@/lib/data';
import { formatDay } from '@/lib/time/pacific';
import { ago } from './format';
import { createRequestGate, gated } from './requestGate';
import {
  SETUP_NOTE, dispatchText, readRequestErrorText, readRequestView, runNowErrorText, runNowView, type Setup,
} from './runNow';
import { amberReason, offReason, redReason, sourceHealth, type Health } from './sourceHealth';

const TRUSTS: SourceTrust[] = ['auto', 'review', 'link_only'];
const LABEL: Record<Health, string> = { red: 'Needs attention', amber: 'Check soon', green: 'Healthy', off: 'Off', oncommand: 'Read on command' };
const REFRESH_MS = 60_000;
const READ_REQUESTED_NOTE = 'Read requested. The conductor reads it with scripts/manual-read.sh requested; nothing is fetched by the server.';

/** Source health board: one row per source with its status, last runs, open cards, Run now / Read request and the enable / trust controls. */
export default function SourcesTab({ onForbidden, active }: { onForbidden(): void; active: boolean }) {
  const [rows, setRows] = useState<SourceHealthRow[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [setup, setSetup] = useState<Setup>('loading');
  const [notes, setNotes] = useState<Record<string, { text: string; err: boolean }>>({});
  const gate = useRef(createRequestGate());
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      await gated(gate.current, () => adminSourceHealth(), (r) => {
        setRows(r);
        setNow(Date.now());
      });
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

  // Sources V2: whether Run now can wake the Ingest workflow (the token is set); until then the buttons read "needs setup".
  useEffect(() => {
    const t = setTimeout(() => {
      adminDispatchStatus().then(setSetup, (e) => {
        if (toDataError(e).code === 'forbidden') onForbidden();
        else setSetup('needs_setup');
      });
    }, 0);
    return () => clearTimeout(t);
  }, [onForbidden]);

  // Refresh every 60 s and on becoming visible, only while this tab is showing and the page is visible.
  useEffect(() => {
    if (!active) return;
    const visible = () => document.visibilityState === 'visible';
    const id = setInterval(() => { if (visible()) void load(); }, REFRESH_MS);
    const onVis = () => { if (visible()) void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [active, load]);

  const note = (slug: string, text: string, isErr: boolean) => setNotes((n) => ({ ...n, [slug]: { text, err: isErr } }));

  // Only the load begun after the last mutation paints: invalidate before the change, reload after it settles (either way).
  async function act(slug: string, fn: () => Promise<void>, errText?: (d: DataError) => string) {
    setBusy((b) => ({ ...b, [slug]: true }));
    setErr('');
    setNotes(({ [slug]: _old, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
    gate.current.invalidate();
    try {
      try {
        await fn();
      } catch (e) {
        const d = toDataError(e);
        if (d.code === 'forbidden') return onForbidden();
        note(slug, errText ? errText(d) : userMessage(d), true);
      }
      await load();
    } finally {
      setBusy(({ [slug]: _drop, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
    }
  }

  const runNow = (r: SourceHealthRow) => act(r.slug, async () => {
    await adminSetForceDue(r.slug, true); // a refused stamp throws here, so no dispatch is sent
    const o = await adminDispatch();
    if (o.outcome === 'not_configured') setSetup('needs_setup');
    note(r.slug, dispatchText(o, r.name), false);
  }, (d) => runNowErrorText(d, r));
  const clearRunNow = (r: SourceHealthRow) => act(r.slug, async () => { await adminSetForceDue(r.slug, false); }, (d) => runNowErrorText(d, r));
  const requestRead = (r: SourceHealthRow) => act(r.slug, async () => {
    await adminSetReadRequest(r.slug, true);
    note(r.slug, READ_REQUESTED_NOTE, false);
  }, readRequestErrorText);
  const clearRead = (r: SourceHealthRow) => act(r.slug, async () => { await adminSetReadRequest(r.slug, false); }, readRequestErrorText);

  const when = new Date(now);
  const schedulable = (rows ?? []).some((r) => !r.manualOnly && r.enabled && r.trust !== 'link_only');
  return (
    <div className="panel">
      <h3>Sources</h3>
      {setup === 'needs_setup' && schedulable && <p className="fine" role="note">{SETUP_NOTE}</p>}
      {err && <p className="err" role="alert">{err}</p>}
      {rows === null ? (
        <p className="fine">Loading…</p>
      ) : (
        <ul className="hlist">
          {rows.map((r) => {
            const h = sourceHealth(r, when);
            const why = h === 'red' ? redReason(r, when) : h === 'amber' ? amberReason(r, when) : h === 'off' ? offReason(r) : null;
            const last = r.lastRuns[0];
            const isBusy = !!busy[r.slug];
            const rn = r.manualOnly ? null : runNowView(r, setup, now);
            const rr = r.manualOnly ? readRequestView(r, now) : null;
            const n = notes[r.slug];
            return (
              <li key={r.slug} className={`hrow ${h}`}>
                <div className="hmain">
                  <span className={`hdot ${h}`} aria-hidden="true" />
                  <div>
                    <span className="src-name">{r.name}</span>
                    {r.manualOnly && <>{' '}<span className="pill">Read on command</span></>}
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
                    {rr && <p className="src-meta">{rr.lastRead} · {rr.nextAllowed}</p>}
                    {rr?.status && <p className="src-meta run-now">{rr.status}</p>}
                    {rn?.status && <p className="src-meta run-now">{rn.status}</p>}
                    <p className={n?.err ? 'src-meta err' : 'src-meta'} aria-live="polite">{n?.text ?? ''}</p>
                  </div>
                </div>
                <div className="hctl">
                  {rn?.show && rn.button && (
                    <button
                      type="button"
                      className="btn"
                      aria-label={rn.button.aria}
                      disabled={rn.button.disabled || isBusy}
                      onClick={() => void runNow(r)}
                    >
                      {rn.button.label}
                    </button>
                  )}
                  {rn?.show && rn.cancel && (
                    <button type="button" className="btn ghost" disabled={isBusy} onClick={() => void clearRunNow(r)}>
                      {rn.cancel}
                    </button>
                  )}
                  {rr?.button && (
                    <button type="button" className="btn" disabled={rr.button.disabled || isBusy} onClick={() => void requestRead(r)}>
                      {rr.button.label}
                    </button>
                  )}
                  {rr?.cancel && (
                    <button type="button" className="btn ghost" disabled={isBusy} onClick={() => void clearRead(r)}>
                      {rr.cancel}
                    </button>
                  )}
                  <select
                    className="field"
                    aria-label={`Trust for ${r.name}`}
                    value={r.trust}
                    disabled={isBusy}
                    onChange={(ev) => void act(r.slug, () => adminSetSourceTrust(r.slug, ev.target.value as SourceTrust))}
                  >
                    {TRUSTS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={isBusy}
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
