'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminListSources,
  adminSetSourceEnabled,
  adminSetSourceTrust,
  toDataError,
  userMessage,
  type AdminSource,
  type SourceTrust,
} from '@/lib/data';

const TRUSTS: SourceTrust[] = ['auto', 'review', 'link_only'];

/** Read-only list of sources, with the enable toggle and the trust select. The database gate decides what is allowed. */
export default function SourcesTab({ onForbidden }: { onForbidden(): void }) {
  const [rows, setRows] = useState<AdminSource[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await adminListSources());
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

  return (
    <div className="panel">
      <h3>Sources</h3>
      {err && <p className="err" role="alert">{err}</p>}
      {rows === null ? (
        <p className="fine">Loading…</p>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Source</th><th>Class</th><th>Disposition</th><th>Trust</th><th>Enabled</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.slug} className={r.enabled ? '' : 'dim'}>
                  <td>
                    <span className="src-name">{r.name}</span>
                    <br />
                    <span className="src-meta">{r.slug} · {r.family}{r.optOut ? ' · opted out' : ''}</span>
                  </td>
                  <td>{r.class}</td>
                  <td>{r.ingestDisposition}</td>
                  <td>
                    <select
                      className="field"
                      aria-label={`Trust for ${r.name}`}
                      value={r.trust}
                      disabled={busy === r.slug}
                      onChange={(ev) => void act(r.slug, () => adminSetSourceTrust(r.slug, ev.target.value as SourceTrust))}
                    >
                      {TRUSTS.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy === r.slug}
                      onClick={() => void act(r.slug, () => adminSetSourceEnabled(r.slug, !r.enabled))}
                    >
                      {r.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
