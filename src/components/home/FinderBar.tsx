'use client';

import { useEffect, useRef, useState } from 'react';
import WhenRow from '@/components/filters/WhenRow';
import { SearchIcon } from '@/components/list/icons';
import { AREAS, AREA_SHORT, cleanQuery, type FilterState } from '@/lib/filters/state';
import { chipAreas, type FinderCounts } from './finderCounts';

interface Props {
  filters: FilterState;
  /** null = counts unknown (empty snapshot, live not loaded): none are shown. */
  counts: FinderCounts | null;
  minDate: string;
  maxDate: string;
  tz: string;
  onChange(next: FilterState): void;
  /** Phone "More areas": opens the filter sheet. */
  onMore(): void;
}

const SEARCH_IDLE_MS = 250;

/**
 * The finder (canvas "Find an event"): search, When pills, and the Free / Kids OK switches (desktop) or the sideways chip row (phone).
 * The search text is local state; the URL and the list follow after 250 ms idle.
 */
export default function FinderBar({ filters, counts, minDate, maxDate, tz, onChange, onMore }: Props) {
  const [text, setText] = useState(filters.q);
  const latest = useRef(filters);
  const send = useRef(onChange);
  useEffect(() => {
    latest.current = filters;
    send.current = onChange;
  });
  // An outside change (the URL arriving after mount, "Clear filters", back/forward) replaces what is typed.
  const [seenQ, setSeenQ] = useState(filters.q);
  if (seenQ !== filters.q) {
    setSeenQ(filters.q);
    if (cleanQuery(text) !== filters.q) setText(filters.q);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onText = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const q = cleanQuery(v);
      if (q !== latest.current.q) send.current({ ...latest.current, q });
    }, SEARCH_IDLE_MS);
  };

  const num = (n: number | undefined) => (counts && n !== undefined ? <> <span className="n">{n}</span></> : null);
  const toggleArea = (a: string) =>
    onChange({ ...filters, areas: filters.areas.includes(a) ? filters.areas.filter((x) => x !== a) : AREAS.filter((x) => x === a || filters.areas.includes(x)) });

  return (
    <section className="find" aria-label="Find an event">
      <label className="search">
        <SearchIcon />
        <input
          type="search"
          name="q"
          value={text}
          maxLength={80}
          autoComplete="off"
          placeholder={counts ? `Search ${counts.total} events` : 'Search events'}
          aria-label="Search events"
          onChange={(e) => onText(e.target.value)}
        />
      </label>
      <WhenRow
        when={filters.when}
        minDate={minDate}
        maxDate={maxDate}
        tz={tz}
        counts={counts}
        onChange={(w) => onChange({ ...filters, when: w })}
      />
      <div className="switches">
        <button type="button" className="sw" role="switch" aria-checked={filters.free} onClick={() => onChange({ ...filters, free: !filters.free })}>
          <span className="tr" aria-hidden="true" />
          <span className="lab">
            Free only{num(counts?.free)}
          </span>
        </button>
        <button type="button" className="sw" role="switch" aria-checked={filters.kids} onClick={() => onChange({ ...filters, kids: !filters.kids })}>
          <span className="tr" aria-hidden="true" />
          <span className="lab">
            Kids OK{num(counts?.kids)}
          </span>
        </button>
      </div>
      <div className="chiprow" role="group" aria-label="Narrow it down">
        <button type="button" className="chip" aria-pressed={filters.free} onClick={() => onChange({ ...filters, free: !filters.free })}>
          Free{num(counts?.free)}
        </button>
        <button type="button" className="chip" aria-pressed={filters.kids} onClick={() => onChange({ ...filters, kids: !filters.kids })}>
          Kids{num(counts?.kids)}
        </button>
        {chipAreas(counts?.areas ?? {}, filters.areas).map((a) => (
          <button key={a} type="button" className="chip" aria-pressed={filters.areas.includes(a)} onClick={() => toggleArea(a)}>
            {AREA_SHORT[a]}
            {num(counts?.areas[a])}
          </button>
        ))}
        <button type="button" className="chip" aria-haspopup="dialog" onClick={onMore}>
          More areas
        </button>
      </div>
    </section>
  );
}
