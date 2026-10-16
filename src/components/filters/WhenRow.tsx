'use client';

import { useId } from 'react';
import type { When } from '@/lib/data/types';
import { dayLabel, startOfDay } from '@/lib/time/pacific';

const isDate = (w: When | null): w is { date: string } => typeof w === 'object' && w !== null;

type Named = Exclude<When, { date: string }>;
/** Tomorrow stays parseable from a link but has no pill (R1c). `n` keys the count shown on the pill. */
const NAMED: { v: Named; long: string; short?: string; n?: 'today' | 'weekend' | 'd7' }[] = [
  { v: 'today', long: 'Today', n: 'today' },
  { v: 'tonight', long: 'Tonight' },
  { v: 'weekend', long: 'This weekend', short: 'Weekend', n: 'weekend' },
  { v: '7d', long: 'Next 7 days', n: 'd7' },
];

interface Props {
  when: When | null;
  /** YYYY-MM-DD of today in Pacific time, the earliest pickable date. */
  minDate: string;
  /** The latest pickable date (today + 120 days). */
  maxDate: string;
  tz: string;
  /** null = unknown: no counts are shown. */
  counts: { today: number; weekend: number; d7: number } | null;
  onChange(when: When | null): void;
}

/** The When pills. Pressing the active choice again clears it. */
export default function WhenRow({ when, minDate, maxDate, tz, counts, onChange }: Props) {
  const id = useId();
  const dateOn = isDate(when);
  const label = dateOn ? dayLabel(new Date(startOfDay(when.date, tz) + 12 * 3_600_000).toISOString(), tz) : 'Pick a date';
  return (
    <div className="when" role="group" aria-label="When">
      <div className="when-in">
        {NAMED.map((p) => (
          <button key={p.v} type="button" className="pill" aria-pressed={when === p.v} onClick={() => onChange(when === p.v ? null : p.v)}>
            {p.short ? (
              <>
                <span className="dsk">{p.long}</span>
                <span className="phn">{p.short}</span>
              </>
            ) : (
              p.long
            )}
            {p.n && counts && <> <span className="n">{counts[p.n]}</span></>}
          </button>
        ))}
        <label className={`pill datepick${dateOn ? ' on' : ''}`} htmlFor={id}>
          <span>{label}</span>
          <input
            id={id}
            type="date"
            min={minDate}
            max={maxDate}
            value={dateOn ? when.date : ''}
            aria-label="Pick a date"
            onChange={(ev) => {
              const v = ev.target.value;
              onChange(/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : null);
            }}
          />
        </label>
      </div>
    </div>
  );
}
