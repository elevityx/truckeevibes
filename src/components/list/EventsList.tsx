import type { VibeEvent } from '@/lib/data/types';
import { groupEvents } from '@/lib/time/pacific';
import { EventRow } from './EventRow';

interface Props {
  /** Already filtered, all-day events already spanned (see withSpan). */
  events: VibeEvent[];
  tz: string;
  now: number;
  filtered: boolean;
  onOpen(id: string): void;
  onClear(): void;
}

/** Today · This week · Later, by start time. */
export default function EventsList({ events, tz, now, filtered, onOpen, onClear }: Props) {
  const g = groupEvents(events, now, tz);
  const groups: [string, VibeEvent[]][] = [
    ['Today', g.today],
    ['This week', g.week],
    ['Later', g.later],
  ];
  const total = g.today.length + g.week.length + g.later.length;
  if (total === 0) {
    return (
      <div className="eempty">
        <p>{filtered ? 'Nothing matches those filters.' : 'No events to show yet. Check back soon.'}</p>
        {filtered && (
          <button type="button" className="btn ghost" onClick={onClear}>
            Clear all filters
          </button>
        )}
      </div>
    );
  }
  return (
    <>
      {groups.map(
        ([label, items]) =>
          items.length > 0 && (
            <section key={label} className="grp" aria-label={label}>
              <h3>
                {label} <span className="gn">{items.length}</span>
              </h3>
              <ul>
                {items.map((e) => (
                  <li key={e.id}>
                    <EventRow e={e} tz={tz} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
    </>
  );
}
