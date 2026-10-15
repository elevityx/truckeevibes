'use client';

import { useId } from 'react';
import type { When } from '@/lib/data/types';

const NAMED: [Exclude<When, { date: string }>, string][] = [
  ['today', 'Today'],
  ['tonight', 'Tonight'],
  ['tomorrow', 'Tomorrow'],
  ['weekend', 'This weekend'],
  ['7d', 'Next 7 days'],
];

const isDate = (w: When | null): w is { date: string } => typeof w === 'object' && w !== null;

interface Props {
  when: When | null;
  /** YYYY-MM-DD of today in Pacific time, the earliest pickable date. */
  minDate: string;
  onChange(when: When | null): void;
}

/** Sticky segmented "When" row. Pressing the active choice again clears it. */
export default function WhenRow({ when, minDate, onChange }: Props) {
  const id = useId();
  const dateOn = isDate(when);
  return (
    <div className="when" role="group" aria-label="When">
      <div className="when-in">
        {NAMED.map(([v, label]) => (
          <button key={v} type="button" className="wseg" aria-pressed={when === v} onClick={() => onChange(when === v ? null : v)}>
            {label}
          </button>
        ))}
        <label className={`wseg datepick${dateOn ? ' on' : ''}`} htmlFor={id}>
          <span>{dateOn ? when.date : 'Pick a date'}</span>
          <input
            id={id}
            type="date"
            min={minDate}
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
