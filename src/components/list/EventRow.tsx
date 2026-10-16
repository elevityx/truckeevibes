import type { VibeEvent } from '@/lib/data/types';
import EventGlyph from './EventGlyph';
import { ChevIcon } from './icons';
import { townOf } from './links';
import { isFar, timeText, whenLine } from './when';

interface RowProps {
  e: VibeEvent;
  tz: string;
  onOpen(id: string): void;
}

/** "Example Ale Works - Example Public House" -> "Example Ale Works". */
export function shortVenue(v: string | null | undefined): string {
  if (!v) return '';
  const i = v.indexOf(' - ');
  return (i === -1 ? v : v.slice(0, i)).trim();
}

/**
 * One day-list row (canvas .drow). A button in R1b (the sheet opens in place); an anchor from R2a. Every string is data and renders as
 * React text. Desktop: time | title + "venue · town" + tags | glyph. Phone: "time · town" above the title, venue as meta, chevron.
 */
export function EventRow({ e, tz, onOpen }: RowProps) {
  const town = e.town ?? (e.address ? townOf(e.address) : '');
  const venue = shortVenue(e.venue);
  const free = e.priceKind === 'free';
  const far = isFar(e);
  const a21 = e.age === '21_plus';
  const a18 = e.age === '18_plus';
  return (
    <button
      type="button"
      className="drow"
      onClick={() => onOpen(e.id)}
      aria-label={`${e.title}, ${whenLine(e, tz)}${town ? `, ${town}` : ''}${free ? ', free' : ''}${a21 ? ', 21 and over' : ''}${a18 ? ', 18 and over' : ''}${far ? ', worth the drive' : ''}`}
    >
      <span className="t">
        {timeText(e, tz)}
        {town && <span className="phn"> · {town}</span>}
      </span>
      <span className="i">
        <strong>{e.title}</strong>
        <span className="meta">
          {(venue || town) && (
            <span>
              {venue}
              {town && <span className={venue ? 'dsk' : undefined}>{venue ? ` · ${town}` : town}</span>}
            </span>
          )}
          {free && <span className="tg free">Free</span>}
          {a21 && <span className="tg t21">21+</span>}
          {a18 && <span className="tg t21">18+</span>}
          {far && <span className="tg drive">Worth the drive</span>}
        </span>
      </span>
      <span className="r" aria-hidden="true">
        <span className="glyph dsk">
          <EventGlyph categories={e.categories} />
        </span>
        <span className="chev phn">
          <ChevIcon />
        </span>
      </span>
    </button>
  );
}
