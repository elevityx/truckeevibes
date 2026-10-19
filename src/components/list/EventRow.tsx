import { memo } from 'react';
import type { VibeEvent } from '@/lib/data/types';
import EventGlyph from './EventGlyph';
import { ChevIcon } from './icons';
import { ACCESS_TAG_LABELS } from '@/lib/categories';
import { townOf } from './links';
import { isFar, timeText, whenLine } from './when';

interface RowProps {
  e: VibeEvent;
  tz: string;
  /** One of Our picks: the aspen top edge and the "Our pick" tag. */
  picked?: boolean;
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
export const EventRow = memo(function EventRow({ e, tz, picked = false, onOpen }: RowProps) {
  const town = e.town ?? (e.address ? townOf(e.address) : '');
  const venue = shortVenue(e.venue);
  const free = e.priceKind === 'free';
  const members = e.categories.includes('members-only');
  const far = isFar(e);
  const a21 = e.age === '21_plus';
  const a18 = e.age === '18_plus';
  return (
    <button
      type="button"
      className={`drow${picked ? ' pick' : ''}`}
      onClick={() => onOpen(e.id)}
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
          {picked && <span className="tg pick">Our pick</span>}
          {free && <span className="tg free">Free</span>}
          {members && <span className="tg members">{ACCESS_TAG_LABELS['members-only']}</span>}
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
      {/* The name is the visible text; this hidden tail adds the full date and the age words (label-in-name, WCAG 2.5.3). */}
      <span className="sr-only">
        . {whenLine(e, tz)}
        {a21 ? ', 21 and over' : ''}
        {a18 ? ', 18 and over' : ''}
        {far ? ', worth the drive' : ''}
      </span>
    </button>
  );
});
