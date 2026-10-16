import type { ReactNode } from 'react';
import type { VibeEvent, When } from '@/lib/data/types';
import { activeFilterCount, type FilterState } from '@/lib/filters/state';
import { addDays, dayLabel, formatTimes, localDate, weekdayName } from '@/lib/time/pacific';
import MessageCard from './MessageCard';
import Skeleton from './Skeleton';

/** Loading: the live read is pending and the snapshot is empty. */
export function LoadingState({ calendars }: { calendars: number }) {
  return (
    <div className="state">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} />
      ))}
      <p className="small" role="status">
        Checking {calendars} {calendars === 1 ? 'calendar' : 'calendars'}…
      </p>
    </div>
  );
}

/** Empty: nothing upcoming in the whole list. */
export function EmptyState({ builtAt, now, tz }: { builtAt: string | null; now: number; tz: string }) {
  const todayStr = localDate(now, tz);
  return (
    <div className="state">
      <MessageCard title="Nothing listed yet">
        <p>
          The calendars we read have nothing for the next 30 days. That usually means our morning read failed, not that the town is quiet. Organizers: add your calendar.
        </p>
        <a className="btn" href="/sources/#add">Add your calendar</a>
      </MessageCard>
      {builtAt && (
        <p className="small">
          Last checked {localDate(Date.parse(builtAt), tz) === todayStr ? 'today' : dayLabel(builtAt, tz)}, {formatTimes(builtAt, null, tz)} Pacific.
        </p>
      )}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One-day When values name the day; the rest are "Nothing matches yet". */
function dayTitle(when: When | null, now: number, tz: string): string | null {
  if (!when) return null;
  const today = localDate(now, tz);
  if (typeof when === 'object') return weekdayName(when.date);
  if (when === 'today' || when === 'tonight') return weekdayName(today);
  if (when === 'tomorrow') return weekdayName(addDays(today, 1));
  return null;
}

export function noResultsCopy(f: FilterState, listEvents: readonly VibeEvent[], now: number, tz: string): { title: string; body: string; showSeven: boolean } {
  const day = dayTitle(f.when, now, tz);
  const clauses: string[] = [];
  const showSeven = f.when !== null && f.when !== '7d';
  if (showSeven) clauses.push('Try Next 7 days');
  if (f.free && !listEvents.some((e) => e.priceKind === 'free')) {
    clauses.push('turn off Free: every event we have this month is missing a price, so Free hides all of them');
  }
  if (f.areas.length > 0 && clauses.length === 0) clauses.push('clear the area filter');
  const body = clauses.length > 0 ? `${cap(clauses.join(', or '))}.` : 'Try clearing a filter.';
  return { title: day ? `Nothing listed for ${day} yet` : 'Nothing matches yet', body, showSeven };
}

/** No results: filters are active and nothing matches. */
export function NoResultsState({
  filters, listEvents, now, tz, onShow7d, onClear,
}: { filters: FilterState; listEvents: readonly VibeEvent[]; now: number; tz: string; onShow7d(): void; onClear(): void }) {
  const c = noResultsCopy(filters, listEvents, now, tz);
  const n = activeFilterCount(filters);
  return (
    <div className="state">
      <MessageCard title={c.title}>
        <p>{c.body}</p>
        {c.showSeven && (
          <button type="button" className="btn" onClick={onShow7d}>Show Next 7 days</button>
        )}
      </MessageCard>
      {n > 0 && (
        <button type="button" className="btn ghost wide" onClick={onClear}>Clear filters ({n})</button>
      )}
    </div>
  );
}

/** Error: the live read failed and there are no rows to show. */
export function ErrorState({
  builtAt, now, tz, hasRows, onRetry, onShowSnapshot,
}: { builtAt: string | null; now: number; tz: string; hasRows: boolean; onRetry(): void; onShowSnapshot(): void }): ReactNode {
  const todayStr = localDate(now, tz);
  const morning = builtAt ? localDate(Date.parse(builtAt), tz) === todayStr : false;
  const when = !builtAt ? 'the last update' : morning ? 'this morning' : dayLabel(builtAt, tz);
  return (
    <div className="state">
      <MessageCard title="Couldn't load the list" tone="danger">
        <p>Check your connection and try again. If it keeps failing, the fault is ours: the last good list is from {when}.</p>
        <button type="button" className="btn" onClick={onRetry}>Try again</button>
      </MessageCard>
      {hasRows && (
        <button type="button" className="btn ghost wide" onClick={onShowSnapshot}>
          Show {morning ? "this morning's list" : `the list from ${when}`}
        </button>
      )}
    </div>
  );
}
