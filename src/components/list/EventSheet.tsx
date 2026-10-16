'use client';

import Sheet from '@/components/ui/Sheet';
import { publicEnv } from '@/config/public-env';
import type { VibeEvent } from '@/lib/data/types';
import DateChip from './DateChip';
import { buildIcs, icsFileName } from './ics';
import { CalIcon, DirIcon, ShareIcon, TicketIcon, WebIcon, XIcon } from './icons';
import { directionsUrl, eventShareUrl, googleCalendarUrl, hasPlace, placeLine, safeWebsite } from './links';
import { is21, isFar, priceText, whenLine } from './when';

interface Props {
  event: VibeEvent;
  tz: string;
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
export default function EventSheet({ event: e, tz, onClose, onToast }: Props) {
  const website = safeWebsite(e.url);
  const tickets = safeWebsite(e.ticketUrl);
  const price = priceText(e);
  const place = placeLine(e);

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
        <div className="sheet-h">
          <div>
            <p className="eyebrow">Event</p>
            <h2 className="etitle">{e.title}</h2>
            {(price || is21(e) || isFar(e)) && (
              <p className="etags">
                {price && <span className="tg free">{price}</span>}
                {is21(e) && <span className="tg t21">21+ · Adults only</span>}
                {isFar(e) && <span className="tg drive">Worth the drive</span>}
              </p>
            )}
          </div>
          <button type="button" className="iconbtn x" aria-label="Close event details" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        <div className="sec">
          <div className="ewhen">
            <DateChip iso={e.startsAt} tz={tz} />
            <p>
              <b>{whenLine(e, tz)}</b>
              <span>Pacific time</span>
            </p>
          </div>
          {place && (
            <p className="eplace">
              {e.venue && <b>{e.venue}</b>}
              {e.address && <span>{e.address}</span>}
            </p>
          )}
          {e.summary && <p className="edesc">{e.summary}</p>}
          {e.sources.length > 0 && <p className="fine">Listed by {e.sources.join(' · ')}</p>}
        </div>
        <div className="sec">
          <div className="eacts">
            {website && (
              <a className="btn ghost" href={website} target="_blank" rel="nofollow ugc noopener noreferrer">
                <WebIcon />
                Website
              </a>
            )}
            {tickets && tickets !== website && (
              <a className="btn ghost" href={tickets} target="_blank" rel="nofollow ugc noopener noreferrer">
                <TicketIcon />
                Tickets
              </a>
            )}
            {hasPlace(e) && (
              <a className="btn ghost" href={directionsUrl(e)} target="_blank" rel="noopener noreferrer">
                <DirIcon />
                Directions
              </a>
            )}
            <button type="button" className="btn ghost" onClick={() => downloadIcs(e)}>
              <CalIcon />
              Add to calendar
            </button>
            <a className="btn ghost" href={googleCalendarUrl(e, tz)} target="_blank" rel="noopener noreferrer">
              <CalIcon />
              Google Calendar
            </a>
            <button type="button" className="btn primary" onClick={() => void share()}>
              <ShareIcon />
              Share
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
