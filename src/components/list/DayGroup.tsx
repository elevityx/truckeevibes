'use client';

import { useState } from 'react';
import type { VibeEvent } from '@/lib/data/types';
import { addDays, dayLabel, localDate, longDay, monthDay, startOfDay } from '@/lib/time/pacific';
import { EventRow } from './EventRow';

/** The Later section shows this many rows before "Show the rest". */
export const LATER_ROWS = 6;
const DAYS = 7;

export interface PlannedDay {
  date: string;
  events: VibeEvent[];
}

export interface DayPlan {
  /** Today through today + 6: all seven when fillEmpty, otherwise only days with events. */
  days: PlannedDay[];
  /** After the seven days: the day groups, the event total and the last start date. */
  later: { groups: PlannedDay[]; total: number; last: string | null };
}

/**
 * Group already-filtered events by Pacific day. A multi-day event that started earlier counts on today. `fillEmpty` keeps the days
 * with nothing (list "All", no filter active).
 */
export function planDays(events: readonly VibeEvent[], o: { now: number; tz: string; fillEmpty: boolean }): DayPlan {
  const today = localDate(o.now, o.tz);
  const sorted = [...events].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const by = new Map<string, VibeEvent[]>();
  for (const e of sorted) {
    const d = localDate(Date.parse(e.startsAt), o.tz);
    const k = d < today ? today : d;
    (by.get(k) ?? by.set(k, []).get(k)!).push(e);
  }
  const week = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
  const days = week.filter((d) => o.fillEmpty || by.has(d)).map((date) => ({ date, events: by.get(date) ?? [] }));
  const laterDates = [...by.keys()].filter((d) => d > week[DAYS - 1]).sort();
  const groups = laterDates.map((date) => ({ date, events: by.get(date)! }));
  return { days, later: { groups, total: groups.reduce((n, g) => n + g.events.length, 0), last: laterDates.at(-1) ?? null } };
}

interface Props {
  /** Already filtered, all-day events already spanned (see withSpan). */
  events: VibeEvent[];
  tz: string;
  now: number;
  /** true = list "All" with no filter active: every one of the next seven days is shown. */
  fillEmpty: boolean;
  onOpen(id: string): void;
}

function DayHead({ date, count, today, tz }: { date: string; count: number; today: boolean; tz: string }) {
  const iso = new Date(startOfDay(date, tz) + 12 * 3_600_000).toISOString();
  return (
    <div className="dayh">
      <h2 className="gh">
        <span className="dsk">{today ? `Today · ${longDay(iso, tz)}` : longDay(iso, tz)}</span>
        <span className="phn">{today ? `Today · ${dayLabel(iso, tz)}` : dayLabel(iso, tz)}</span>
      </h2>
      <span className="cnt">{count}</span>
    </div>
  );
}

/** The day-by-day list: seven day groups, then "Later". */
export default function DayGroup({ events, tz, now, fillEmpty, onOpen }: Props) {
  const [all, setAll] = useState(false);
  const plan = planDays(events, { now, tz, fillEmpty });
  const today = localDate(now, tz);
  const limit = all ? Infinity : LATER_ROWS;
  const later = plan.later.groups.map((g, i) => {
    const before = plan.later.groups.slice(0, i).reduce((n, x) => n + x.events.length, 0);
    return { ...g, rows: g.events.slice(0, Math.max(0, limit - before)) };
  });
  const rest = plan.later.total - later.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div className="days">
      {plan.days.map((d) => (
        <div key={d.date} className="day">
          <DayHead date={d.date} count={d.events.length} today={d.date === today} tz={tz} />
          {d.events.length === 0 ? (
            <p className="small">
              Nothing listed yet. Organizers: <a href="/sources/#add">add your calendar</a>.
            </p>
          ) : (
            <ul className="rows">
              {d.events.map((e) => (
                <li key={e.id}>
                  <EventRow e={e} tz={tz} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {plan.later.total > 0 && (
        <div className="later">
          <div className="later-h">
            <h2 className="gh">Later</h2>
            <span className="small">
              {plan.later.total} more through {monthDay(plan.later.last!)}
            </span>
            <span className="later-rule" aria-hidden="true" />
          </div>
          {later
            .filter((g) => g.rows.length > 0)
            .map((g) => (
              <div key={g.date} className="day">
                <DayHead date={g.date} count={g.events.length} today={false} tz={tz} />
                <ul className="rows">
                  {g.rows.map((e) => (
                    <li key={e.id}>
                      <EventRow e={e} tz={tz} onOpen={onOpen} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {rest > 0 && (
            <button type="button" className="btn ghost" onClick={() => setAll(true)}>
              Show the rest ({rest} more)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
