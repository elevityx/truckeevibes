'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FilterButton from '@/components/filters/FilterButton';
import FilterControls from '@/components/filters/FilterControls';
import FilterSheet from '@/components/filters/FilterSheet';
import WhenRow from '@/components/filters/WhenRow';
import { supabaseConfigured } from '@/config/public-env';
import { listEventsWithMeta } from '@/lib/data/public';
import type { VibeEvent } from '@/lib/data/types';
import { applyFilters, REGION_TZ, withSpan } from '@/lib/filters/predicates';
import { EMPTY_FILTERS, activeFilterCount, filtersUrl, parseFilters, type FilterState } from '@/lib/filters/state';
import { formatDay, formatTimes, localDate } from '@/lib/time/pacific';
import { useClock } from '@/lib/time/useClock';
import EventSheet from './EventSheet';
import EventsList from './EventsList';
import { fetchSnapshot } from './snapshot';
import './list.css';

const TZ = REGION_TZ;

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; events: VibeEvent[]; source: 'snapshot' | 'live'; builtAt: string | null; liveFailed: boolean; truncated: boolean };

/** The public list: first paint from the build snapshot, then the live read. Filters and the open event live in the URL. */
export default function ListApp() {
  const now = useClock();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [eventId, setEventId] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState('');
  const ready = useRef(false);

  // Filters and ?event= come from the URL after mount (the static export has no search string at build time).
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(parseFilters(window.location.search));
      setEventId(new URLSearchParams(window.location.search).get('event'));
      ready.current = true;
    }, 0);
    const onPop = () => {
      setFilters(parseFilters(window.location.search));
      setEventId(new URLSearchParams(window.location.search).get('event'));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      clearTimeout(t);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    let alive = true;
    (async () => {
      const snap = await fetchSnapshot(ctl.signal);
      if (!alive) return;
      const configured = supabaseConfigured();
      setLoad({
        phase: 'ready', events: snap?.events ?? [], source: 'snapshot', builtAt: snap?.builtAt ?? null,
        // Without a database there is no live read to wait for; the snapshot is all there is.
        liveFailed: false, truncated: false,
      });
      if (!configured) return;
      try {
        const r = await listEventsWithMeta();
        if (alive) setLoad({ phase: 'ready', events: r.events, source: 'live', builtAt: snap?.builtAt ?? null, liveFailed: false, truncated: r.truncated });
      } catch {
        if (alive) setLoad((cur) => (cur.phase === 'ready' ? { ...cur, liveFailed: true } : cur));
      }
    })();
    return () => {
      alive = false;
      ctl.abort();
    };
  }, []);

  const writeUrl = useCallback((f: FilterState, id: string | null) => {
    const u = new URL(window.location.href);
    const base = filtersUrl(u.toString(), f);
    const next = new URL(base, u.origin);
    if (id) next.searchParams.set('event', id);
    else next.searchParams.delete('event');
    window.history.replaceState(null, '', next.pathname + next.search + next.hash);
  }, []);

  const setF = useCallback(
    (f: FilterState) => {
      setFilters(f);
      writeUrl(f, eventId);
    },
    [eventId, writeUrl],
  );
  const open = useCallback(
    (id: string | null) => {
      setEventId(id);
      writeUrl(filters, id);
    },
    [filters, writeUrl],
  );

  const events = useMemo(() => (load.phase === 'ready' ? load.events.map((e) => withSpan(e, TZ)) : []), [load]);
  const shown = useMemo(() => applyFilters(events, filters, now, TZ), [events, filters, now]);
  const selected = useMemo(() => (eventId ? events.find((e) => e.id === eventId) ?? null : null), [events, eventId]);
  const today = localDate(now, TZ);
  const nFilters = (filters.areas.length ? 1 : 0) + (filters.free ? 1 : 0);
  const filtered = activeFilterCount(filters) > 0;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const asOf = load.phase === 'ready' && load.builtAt ? `${formatDay(load.builtAt, TZ)} · ${formatTimes(load.builtAt, null, TZ)}` : null;

  return (
    <div className="lp">
      <header className="lp-head">
        <div className="lp-bar">
          <Link className="wm disp" href="/">TruckeeVibes</Link>
          <nav className="lp-nav" aria-label="Site">
            <Link href="/sources/">Sources</Link>
            <Link href="/about/">About</Link>
          </nav>
        </div>
        <WhenRow when={filters.when} minDate={today} onChange={(w) => setF({ ...filters, when: w })} />
      </header>

      <div className="lp-body">
        <aside className="rail" aria-label="Filters">
          <h2>Filters</h2>
          <FilterControls state={filters} onChange={setF} />
          {filtered && (
            <button type="button" className="linkbtn" onClick={() => setF(EMPTY_FILTERS)}>
              Clear all
            </button>
          )}
        </aside>

        <main className="lp-main">
          <div className="list-head">
            <h1 className="disp">Events in Truckee and North Lake Tahoe</h1>
            <p>
              Pacific time
              {load.phase === 'ready' && ` · ${shown.length} ${shown.length === 1 ? 'event' : 'events'}`}
            </p>
          </div>
          <div className="lp-tools">
            <FilterButton count={nFilters} onClick={() => setSheet(true)} />
            {filtered && (
              <button type="button" className="linkbtn" onClick={() => setF(EMPTY_FILTERS)}>
                Clear all
              </button>
            )}
          </div>

          {load.phase === 'ready' && load.liveFailed && (
            <p className="notice" role="status">
              Showing events as of {asOf ?? 'the last update'}. We could not reach the server, so this list may be out of date.
            </p>
          )}
          {load.phase === 'ready' && load.truncated && !load.liveFailed && (
            <p className="notice" role="status">Showing the next 60 days of events.</p>
          )}

          {load.phase === 'loading' ? (
            <p className="fine" role="status">Loading events…</p>
          ) : (
            <EventsList events={shown} tz={TZ} now={now} filtered={filtered} onOpen={open} onClear={() => setF(EMPTY_FILTERS)} />
          )}
          <p className="land-ack">Truckee sits on the ancestral homeland of the Washoe (Wašiw) people.</p>
        </main>
      </div>

      {sheet && <FilterSheet state={filters} resultCount={shown.length} onChange={setF} onClose={() => setSheet(false)} />}
      {selected && <EventSheet event={selected} tz={TZ} onClose={() => open(null)} onToast={setToast} />}
      {toast && <div className="ltoast" role="status">{toast}</div>}
    </div>
  );
}
