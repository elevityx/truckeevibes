'use client';

import Sheet from '@/components/ui/Sheet';
import { publicEnv } from '@/config/public-env';
import type { VibeEvent } from '@/lib/data/types';
import { CATEGORY_LABELS } from '@/lib/categories';
import AlsoOn, { alsoOn } from './AlsoOn';
import DateChip from './DateChip';
import { buildIcs, icsFileName } from './ics';
import { CalIcon, DirIcon, ShareIcon, TicketIcon, WebIcon, XIcon } from './icons';
import { directionsUrl, eventShareUrl, googleCalendarUrl, hasPlace, placeLine, safeWebsite } from './links';
import { agesText, isFar, priceText, sheetWhenLine } from './when';

interface Props {
  event: VibeEvent;
  /** Every loaded event: the "Also on" dates come from the other occurrences of this one. */
  events: readonly VibeEvent[];
  now: number;
  tz: string;
  /** The pick line when this event is one of Our picks. */
  pickLine?: string | null;
  /** Opens another event in this same sheet (the Also on dates). */
  onOpenEvent(id: string): void;
  onClose(): void;
  onToast(msg: string): void;
}

/** Download the event as a calendar file. A blob URL made from our own generated text; nothing is injected as HTML. */
function downloadIcs(e: VibeEvent) {
  const url = URL.createObjectURL(new Blob([buildIcs(e)], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = icsFileName(e);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Event details. Every data string renders as React text; links pass through safeWebsite or are built from our own URLs. */
export default function EventSheet({ event: e, events, now, tz, pickLine = null, onOpenEvent, onClose, onToast }: Props) {
  const organizer = safeWebsite(e.url) ?? safeWebsite(e.ticketUrl);
  const tickets = safeWebsite(e.ticketUrl);
  const price = priceText(e);
  const place = placeLine(e);
  const also = alsoOn(e, events, now, tz);
  const cats = e.categories.slice(0, 2).map((c) => CATEGORY_LABELS[c]).filter(Boolean);

  const share = async () => {
    const url = eventShareUrl(publicEnv.siteUrl, e.id);
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: e.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      onToast('Link copied');
    } catch {
      /* the visitor cancelled the share sheet, or the browser blocked copying */
    }
  };

  return (
    <Sheet label="Event details" onClose={onClose}>
      <div className="sheet-in esheet">
        <div className="sheet-top">
          <p className="eyebrow">Event</p>
          <button type="button" className="iconbtn x" aria-label="Close event details" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <div className="ehead">
          <DateChip iso={e.startsAt} tz={tz} big />
          <div className="ehead-t">
            <h2 className="etitle">{e.title}</h2>
            <p className="ewhenl">{sheetWhenLine(e, tz)} · Pacific time</p>
            <p className="etags">
              {pickLine && <span className="tg pick">Our pick</span>}
              {cats.map((c) => (
                <span key={c} className="tg">{c}</span>
              ))}
              {e.age === '21_plus' && <span className="tg t21">21+</span>}
              {e.age === '18_plus' && <span className="tg t21">18+</span>}
              {e.priceKind === 'free' && <span className="tg free">Free</span>}
              {isFar(e) && <span className="tg drive">Worth the drive</span>}
            </p>
          </div>
        </div>
        {pickLine && <p className="pickline">{pickLine}</p>}
        <dl className="kv">
          <dt>Where</dt>
          <dd>
            {e.venue ?? (place || 'Not listed.')}
            {e.venue && e.address && (
              <>
                <br />
                <span className="small">{e.address}</span>
              </>
            )}
          </dd>
          <dt>Price</dt>
          <dd>{price ?? "Not listed. Check the organizer's page."}</dd>
          <dt>Ages</dt>
          <dd>{agesText(e.age)}</dd>
          {also.length > 0 && (
            <>
              <dt>Also on</dt>
              <dd>
                <AlsoOn items={also} tz={tz} onOpen={onOpenEvent} />
              </dd>
            </>
          )}
          <dt>Listed by</dt>
          <dd>
            {e.sources.length > 0 ? <a href="/sources/">{e.sources.join(' · ')}</a> : 'Not listed.'}
          </dd>
        </dl>
        {e.summary && <p className="small edesc">{e.summary}</p>}
        <div className="eacts">
          {organizer && (
            <a className="btn" href={organizer} target="_blank" rel="nofollow ugc noopener noreferrer">
              <WebIcon />
              Organizer&apos;s page
            </a>
          )}
          <button type="button" className="btn ghost" onClick={() => downloadIcs(e)}>
            <CalIcon />
            Add to calendar
          </button>
          {hasPlace(e) && (
            <a className="btn ghost" href={directionsUrl(e)} target="_blank" rel="noopener noreferrer">
              <DirIcon />
              Directions
            </a>
          )}
          <button type="button" className="btn share" onClick={() => void share()}>
            <ShareIcon />
            Share
          </button>
        </div>
        <p className="elinks">
          <a href={googleCalendarUrl(e, tz)} target="_blank" rel="noopener noreferrer">Google Calendar</a>
          {tickets && tickets !== organizer && (
            <a className="btn ghost" href={tickets} target="_blank" rel="nofollow ugc noopener noreferrer">
              <TicketIcon />
              Tickets
            </a>
          )}
        </p>
      </div>
    </Sheet>
  );
}
