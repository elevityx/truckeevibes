import type { VibeEvent } from '@/lib/data/types';
import { monthDay, localDate } from '@/lib/time/pacific';
import { notEndedAt } from '@/lib/filters/predicates';

export const ALSO_ON_MAX = 6;

/** Lowercase, collapsed spaces: two listings of the same series match. */
export const normalizeTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Other upcoming events with the same title and venue, soonest first, at most six. */
export function alsoOn(e: VibeEvent, events: readonly VibeEvent[], now: number, tz: string): VibeEvent[] {
  const key = normalizeTitle(e.title);
  return events
    .filter((o) => o.id !== e.id && normalizeTitle(o.title) === key && (o.venue ?? '') === (e.venue ?? '') && notEndedAt(o, now, tz))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, ALSO_ON_MAX);
}

/** "Oct 25, Nov 1, Nov 8", each date a button that opens that event. */
export default function AlsoOn({ items, tz, onOpen }: { items: readonly VibeEvent[]; tz: string; onOpen(id: string): void }) {
  return (
    <>
      {items.map((o, i) => (
        <span key={o.id}>
          <button type="button" className="linkbtn also" onClick={() => onOpen(o.id)}>
            {monthDay(localDate(Date.parse(o.startsAt), tz))}
          </button>
          {i < items.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  );
}
