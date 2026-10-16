'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FilterButton from '@/components/filters/FilterButton';
import FinderBar from '@/components/home/FinderBar';
import { finderCounts } from '@/components/home/finderCounts';
import Hero from '@/components/home/Hero';
import PicksRow from '@/components/home/PicksRow';
import Tiles from '@/components/home/Tiles';
import { supabaseConfigured } from '@/config/public-env';
import { areaCounts, kindCounts, type BuildCounts } from '@/lib/data/firstPaint';
import { applyFilters, REGION_TZ, withSpan } from '@/lib/filters/predicates';
import { EMPTY_FILTERS, activeFilterCount, pageUrl, parseFilters, type FilterState } from '@/lib/filters/state';
import { LISTS, listBySlug, type ListSlug } from '@/lib/lists';
import type { Pick as PickItem } from '@/lib/picks';
import { addDays, formatDay, formatTimes, localDate } from '@/lib/time/pacific';
import { CLOCK_TICK_MS, useClock } from '@/lib/time/useClock';
import DayGroup from './DayGroup';
import { chooseView, homeModel, refreshNotice } from './homeModel';
import { initialLoad, liveFailedLoad, liveLoaded, retryLoad } from './listLoad';
import { EmptyState, ErrorState, LoadingState, NoResultsState } from './ListStates';
import Rail from './Rail';
import type { Snapshot, SnapshotSource } from './snapshot';
import './list.css';

const TZ = REGION_TZ;
/** The date picker reaches this many days ahead (R1c). */
const DATE_WINDOW_DAYS = 120;
// The sheets open on interaction only: keep them out of the first-paint bundle.
const FilterSheet = dynamic(() => import('@/components/filters/FilterSheet'));
const EventSheet = dynamic(() => import('./EventSheet'));

interface Props {
  list: ListSlug;
  initialSnapshot: Pick<Snapshot, 'builtAt' | 'events'>;
  counts: BuildCounts;
  /** Our picks, already joined to events at build (src/lib/picks.ts). */
  picks: readonly PickItem[];
}

/** The public list: first paint from the build snapshot, then the live read. Filters and the open event live in the URL. */
export default function ListApp({ list, initialSnapshot, counts, picks }: Props) {
  // The first render uses the build time as "now" so server and hydration agree; the real clock takes over right after mount.
  const builtMs = initialSnapshot.builtAt ? Date.parse(initialSnapshot.builtAt) : 0;
  const now = useClock(CLOCK_TICK_MS, builtMs);
  const [load, setLoad] = useState(() => initialLoad(initialSnapshot, supabaseConfigured()));
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [active, setActive] = useState<ListSlug>(list);
  const [eventId, setEventId] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [liveSources, setLiveSources] = useState<SnapshotSource[] | null>(null);
  const ready = useRef(false);
  // The floating Filters button only appears once the finder has scrolled out of view (it would sit on the first screen's content).
  const finderRef = useRef<HTMLDivElement>(null);
  const [finderInView, setFinderInView] = useState(true);

  useEffect(() => {
    const el = finderRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setFinderInView(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);

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

  // The snapshot is already state; the live read only reconciles it. A retry (attempt > 0) always tries.
  useEffect(() => {
    if (!supabaseConfigured() && attempt === 0) return;
    let alive = true;
    // Loaded on demand: the data layer (and the Supabase client) stays out of the first-paint bundle.
    import('@/lib/data/public')
      .then((m) => m.listEventsWithMeta())
      .then((r) => alive && setLoad((c) => liveLoaded(c, r)))
      .catch(() => alive && setLoad(liveFailedLoad));
    return () => {
      alive = false;
    };
  }, [attempt]);

  // DR8: the hero's calendar count reconciles with the live source list, like Sources and About. A failure keeps the build value.
  useEffect(() => {
    if (!supabaseConfigured()) return;
    let alive = true;
    import('@/lib/data')
      .then((m) => m.listSourcesPublic())
      .then((r) => alive && r.length > 0 && setLiveSources(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const writeUrl = useCallback((f: FilterState, id: string | null) => {
    window.history.replaceState(null, '', pageUrl(window.location.href, f, id));
  }, []);

  const setF = useCallback(
    (f: FilterState) => {
      setFilters(f);
      writeUrl(f, eventId);
    },
    [eventId, writeUrl],
  );
  // Stable, so the memoized rows do not re-render on every filter change.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  const open = useCallback(
    (id: string | null) => {
      setEventId(id);
      writeUrl(filtersRef.current, id);
    },
    [writeUrl],
  );

  const def = listBySlug(active) ?? LISTS[0];
  const events = useMemo(() => load.events.map((e) => withSpan(e, TZ)), [load.events]);
  const upcoming = useMemo(() => applyFilters(events, EMPTY_FILTERS, now, TZ), [events, now]);
  const listEvents = useMemo(() => upcoming.filter((e) => def.match(e)), [upcoming, def]);
  const shown = useMemo(() => applyFilters(listEvents, filters, now, TZ), [listEvents, filters, now]);
  const selected = useMemo(() => (eventId ? events.find((e) => e.id === eventId) ?? null : null), [events, eventId]);
  const today = localDate(now, TZ);
  const nActive = activeFilterCount(filters);
  // Our picks: once the live rows arrive, a pick whose event is gone drops out. The row shows on the unfiltered home list only.
  const livePicks = useMemo(() => {
    if (load.source !== 'live') return picks;
    const ids = new Set(events.map((e) => e.id));
    return picks.filter((p) => ids.has(p.event.id));
  }, [load.source, picks, events]);
  const pickedIds = useMemo(() => new Set(livePicks.map((p) => p.event.id)), [livePicks]);
  const pickLine = eventId ? livePicks.find((p) => p.event.id === eventId)?.line ?? null : null;

  // Build-time counts cover the full snapshot (first paint embeds at most 300 rows); live rows replace them. Unknown counts show nothing.
  const model = homeModel({ load, counts, liveSources, now });
  const fromBuild = load.source === 'snapshot' && active === list;
  const railCounts = useMemo(
    () => ({
      areas: fromBuild ? counts.areas : areaCounts(listEvents),
      kinds: fromBuild ? counts.kinds : kindCounts(listEvents),
      sources: { ...counts.sources, activeNames: model.activeNames },
    }),
    [fromBuild, counts, listEvents, model.activeNames],
  );
  const listLast = listEvents.reduce<string | null>((m, e) => {
    const d = localDate(Date.parse(e.startsAt), TZ);
    return m === null || d > m ? d : m;
  }, null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const asOf = load.builtAt ? `${formatDay(load.builtAt, TZ)} · ${formatTimes(load.builtAt, null, TZ)}` : null;
  const empty = events.length === 0;

  const finder = useMemo(() => finderCounts(listEvents, filters, now, TZ), [listEvents, filters, now]);

  const view = chooseView({ load, empty, upcoming: upcoming.length, shown: shown.length });
  let body;
  if (view === 'loading') body = <LoadingState calendars={model.activeSources} />;
  else if (view === 'error') {
    body = (
      <ErrorState
        builtAt={load.builtAt}
        now={now}
        tz={TZ}
        onRetry={() => {
          setLoad(retryLoad);
          setAttempt((n) => n + 1);
        }}
      />
    );
  } else if (view === 'empty') body = <EmptyState builtAt={load.builtAt} now={now} tz={TZ} />;
  else if (view === 'noresults') {
    body = (
      <NoResultsState
        filters={filters}
        listEvents={listEvents}
        now={now}
        tz={TZ}
        onShow7d={() => setF({ ...filters, when: '7d' })}
        onClear={() => setF(EMPTY_FILTERS)}
      />
    );
  } else body = <DayGroup events={shown} tz={TZ} now={now} fillEmpty={active === 'all' && nActive === 0} pickedIds={pickedIds} onOpen={open} />;

  return (
    <div className={`lp${active === 'all' ? '' : ' is-list'}`}>
      <div className="wrap">
        <Hero now={now} list={def} listCount={listEvents.length} listLast={listLast} hero={model.hero} activeSources={model.activeSources} />
        <Tiles counts={model.tileCounts} active={active} onSelect={(s) => setActive((cur) => (cur === s ? 'all' : s))} />
        <div ref={finderRef}>
          <FinderBar
            filters={filters}
            counts={model.known ? finder : null}
            minDate={today}
            maxDate={addDays(today, DATE_WINDOW_DAYS)}
            tz={TZ}
            onChange={setF}
            onMore={() => setSheet(true)}
          />
        </div>
        {active === 'all' && nActive === 0 && view === 'list' && <PicksRow picks={livePicks} tz={TZ} onOpen={open} />}
      </div>

      <div className="wrap cols">
        <Rail counts={railCounts} filters={filters} known={model.known} onChange={setF} />
        <div className="col">
          {refreshNotice(load, empty) && (
            <p className="notice" role="status">
              Showing events as of {asOf ?? 'the last update'}. We could not reach the server, so this list may be out of date.
            </p>
          )}
          {load.truncated && !load.liveFailed && (
            <p className="notice" role="status">Showing the next 60 days of events.</p>
          )}
          {body}
        </div>
      </div>

      <FilterButton count={nActive} hidden={view !== 'list' || finderInView} onClick={() => setSheet(true)} />
      {sheet && <FilterSheet state={filters} resultCount={shown.length} onChange={setF} onClose={() => setSheet(false)} />}
      {selected && (
        <EventSheet event={selected} events={events} now={now} tz={TZ} pickLine={pickLine} onOpenEvent={open} onClose={() => open(null)} onToast={setToast} />
      )}
      {toast && <div className="ltoast" role="status">{toast}</div>}
    </div>
  );
}
