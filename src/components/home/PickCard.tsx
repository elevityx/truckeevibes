import { shortVenue } from '@/components/list/EventRow';
import { timeText } from '@/components/list/when';
import type { Pick } from '@/lib/picks';
import { dayLabel } from '@/lib/time/pacific';

/** One of Our picks (canvas .card.pick): aspen top edge, an optional 3:2 photo, the tag, when, title, our line, venue. A button that opens the sheet. */
export default function PickCard({ pick, tz, onOpen }: { pick: Pick; tz: string; onOpen(id: string): void }) {
  const e = pick.event;
  const venue = shortVenue(e.venue);
  return (
    <button type="button" className="card pick" onClick={() => onOpen(e.id)}>
      {pick.photo && (
        // A plain img on purpose: the site is a static export with no image optimizer, and the file is ours (/photos/).
        // eslint-disable-next-line @next/next/no-img-element
        <img className="photo" src={pick.photo.src} alt={pick.photo.alt} width={600} height={400} loading="lazy" />
      )}
      <span className="cbody">
        <span className="row">
          <span className="tg pick">Our pick</span>
          <span className="meta">
            {dayLabel(e.startsAt, tz)} · {timeText(e, tz)}
            {e.town ? ` · ${e.town}` : ''}
          </span>
        </span>
        <strong className="h2">{e.title}</strong>
        <span className="pickline">{pick.line}</span>
        {venue && <span className="small">{venue}</span>}
      </span>
    </button>
  );
}
