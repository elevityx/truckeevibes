'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminAcceptLightsRemovals,
  adminLightsEvents,
  adminLightsMirrorStatus,
  adminSetLightsInclude,
  adminSetLightsOverride,
  toDataError,
  userMessage,
  type LightsEventRow,
  type LightsInclude,
  type LightsMirrorStatus,
  type LightsSeason,
} from '@/lib/data';
import { formatDay, formatRange } from '@/lib/time/pacific';
import { ago } from './format';
import { acceptErrorMessage, acceptPayload, canShowAnyway, currentPair, holdSummary } from './lightsTab';
import { createRequestGate, gated } from './requestGate';

const TZ = 'America/Los_Angeles';
const INCLUDES: LightsInclude[] = ['auto', 'yes', 'no'];
const SEASONS: LightsSeason[] = ['halloween', 'christmas'];

/** Lights tab (SD5): held Lights mirror removals to accept as shown, and the Vibes events added to a Lights season. */
export default function LightsTab({ onForbidden }: { onForbidden(): void }) {
  const [pair, setPair] = useState(() => currentPair(new Date()));
  const [status, setStatus] = useState<LightsMirrorStatus | null>(null);
  const [events, setEvents] = useState<LightsEventRow[] | null>(null);
  const [err, setErr] = useState('');
  const [holdErr, setHoldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [now, setNow] = useState(() => Date.now());
  const gate = useRef(createRequestGate());

  const fail = useCallback((e: unknown) => {
    const d = toDataError(e);
    if (d.code === 'forbidden') return onForbidden();
    setErr(userMessage(d));
  }, [onForbidden]);

  const load = useCallback(async () => {
    try {
      await gated(gate.current, () => Promise.all([adminLightsMirrorStatus(), adminLightsEvents(pair.season, pair.year)]), ([s, ev]) => {
        setStatus(s);
        setEvents(ev);
        setNow(Date.now());
      });
    } catch (e) {
      fail(e);
    }
  }, [pair, fail]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function act(key: string, fn: () => Promise<void>, onError?: (e: unknown) => boolean) {
    setBusy((b) => ({ ...b, [key]: true }));
    setErr('');
    gate.current.invalidate();
    try {
      try {
        await fn();
      } catch (e) {
        if (!onError?.(e)) fail(e);
      }
      await load();
    } finally {
      setBusy(({ [key]: _drop, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
    }
  }

  return (
    <div className="panel">
      <h3>Lights</h3>
      {err && <p className="err" role="alert">{err}</p>}

      <h4>Held removals</h4>
      {status === null ? (
        <p className="fine">Loading…</p>
      ) : status.holds.length === 0 ? (
        <p className="fine">No held removals. Every Lights read has been applied.</p>
      ) : (
        <ul className="hlist">
          {status.holds.map((h) => {
            const key = `${h.region}:${h.season}:${h.year}`;
            const s = holdSummary(h);
            return (
              <li key={key} className="hrow amber">
                <div className="hmain">
                  <div>
                    <span className="src-name">{h.season} {h.year}: {s.count} {s.count === 1 ? 'event' : 'events'} missing from Lights</span>
                    <p className="src-meta">
                      first seen {ago(h.firstObsAt, now)} · last seen {ago(h.lastObsAt, now)} · {s.observations} {s.observations === 1 ? 'read' : 'reads'}
                    </p>
                    <ul className="src-meta">
                      {h.removalSet.map((r) => (
                        <li key={r.id}>{r.title ?? r.id}{r.startsAt ? ` · ${formatDay(r.startsAt, TZ)}` : ''}</li>
                      ))}
                    </ul>
                    {holdErr[key] && <p className="err" role="alert">{holdErr[key]}</p>}
                  </div>
                </div>
                <div className="hctl">
                  <button
                    type="button"
                    className="btn"
                    disabled={!!busy[key]}
                    onClick={() => {
                      const p = acceptPayload(h);
                      setHoldErr(({ [key]: _drop, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
                      void act(key, () => adminAcceptLightsRemovals(p.region, p.season, p.year, p.ids), (e) => {
                        const d = toDataError(e);
                        if (d.code === 'forbidden') return false;
                        setHoldErr((m) => ({ ...m, [key]: acceptErrorMessage(e) }));
                        return true;
                      });
                    }}
                  >
                    Accept removals
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h4>Vibes events on Lights</h4>
      <div className="hctl">
        <select className="field" aria-label="Season" value={pair.season} onChange={(e) => setPair((p) => ({ ...p, season: e.target.value as LightsSeason }))}>
          {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="field" aria-label="Year" value={pair.year} onChange={(e) => setPair((p) => ({ ...p, year: Number(e.target.value) }))}>
          {[pair.year - 1, pair.year, pair.year + 1].filter((y) => y >= 2025).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {events === null ? (
        <p className="fine">Loading…</p>
      ) : events.length === 0 ? (
        <p className="fine">No Vibes events are eligible for {pair.season} {pair.year}.</p>
      ) : (
        <ul className="hlist">
          {events.map((r) => (
            <li key={r.id} className={`hrow ${r.shown ? 'green' : 'off'}`}>
              <div className="hmain">
                <div>
                  <span className="src-name">{r.title}</span>
                  <p className="src-meta">
                    {formatRange(r.startsAt, null, TZ)} · {r.shown ? 'shown on Lights' : r.coveredLive ? 'Lights already lists it' : r.vetoed ? 'removed on Lights' : 'not shown'}
                  </p>
                </div>
              </div>
              <div className="hctl">
                <select
                  className="field"
                  aria-label={`Lights for ${r.title}`}
                  value={r.lightsInclude}
                  disabled={!!busy[r.id]}
                  onChange={(ev) => void act(r.id, () => adminSetLightsInclude(r.id, ev.target.value as LightsInclude))}
                >
                  {INCLUDES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                {canShowAnyway(r) && (
                  <button type="button" className="btn ghost" disabled={!!busy[r.id]} onClick={() => void act(r.id, () => adminSetLightsOverride(r.id))}>
                    Show on Lights anyway
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
