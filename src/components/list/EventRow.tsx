import type { VibeEvent } from '@/lib/data/types';
import DateChip from './DateChip';
import EventGlyph from './EventGlyph';
import { ChevIcon } from './icons';
import { townOf } from './links';
import { is21, isFar, timeText, whenLine } from './when';

interface RowProps {
  e: VibeEvent;
  tz: string;
  onOpen(id: string): void;
}

/** Every string here is data and renders as React text. */
export function EventRow({ e, tz, onOpen }: RowProps) {
  const town = e.town ?? (e.address ? townOf(e.address) : '');
  const free = e.priceKind === 'free';
  const far = isFar(e);
  const adults = is21(e);
  return (
    <button
      type="button"
      className="erow"
      onClick={() => onOpen(e.id)}
      aria-label={`${e.title}, ${whenLine(e, tz)}${town ? `, ${town}` : ''}${free ? ', free' : ''}${adults ? ', 21 and over' : ''}${far ? ', worth the drive' : ''}`}
    >
      <DateChip iso={e.startsAt} tz={tz} />
      <span className="info" aria-hidden="true">
        <strong>{e.title}</strong>
        <span className="meta">
          <span>
            {timeText(e, tz)}
            {town && ` · ${town}`}
          </span>
          {free && <span className="chipf">Free</span>}
          {adults && <span className="t21">21+</span>}
          {far && <span className="tdrive">Worth the drive</span>}
        </span>
      </span>
      <span className="glyph" aria-hidden="true">
        <EventGlyph categories={e.categories} />
      </span>
      <span className="chev" aria-hidden="true">
        <ChevIcon />
      </span>
    </button>
  );
}
