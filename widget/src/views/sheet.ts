// Lights EventSheet.tsx inside Sheet.tsx: scrim + dialog panel (bottom sheet below 760 px, 400 px right panel at 760 px and up).
import { el, on } from '../dom';
import { calIcon, dirIcon, shareIcon, webIcon, xIcon } from '../icons';
import { directionsUrl, googleCalendarUrl, safePageUrl, safeWebsite, worthTheDrive } from '../links';
import { whenLong } from '../time';
import type { Box, Season, WidgetEvent } from '../types';
import { credit } from './credit';
import { seasonName } from './ctx';
import { dateChipEl } from './row';

export interface SheetCtx { season: Season; year: number; tz: string; localBox: Box; onClose(): void; onShare(e: WidgetEvent): void }

/** [scrim, panel] for one event. Every data string is text; links come only from the safe builders. */
export function renderSheet(e: WidgetEvent, ctx: SheetCtx): [HTMLElement, HTMLElement] {
  const far = worthTheDrive(ctx.localBox, e);
  const website = safeWebsite(e.url);
  const page = e.origin === 'vibes' ? safePageUrl(e.pageUrl) : null;
  const scrim = el('div', { class: 'tv-scrim', 'aria-hidden': 'true' });
  on(scrim, 'click', () => ctx.onClose());
  const close = el('button', { type: 'button', class: 'iconbtn x', 'aria-label': 'Close event details' }, xIcon());
  on(close, 'click', () => ctx.onClose());
  const share = el('button', { type: 'button', class: 'btn primary' }, shareIcon(), 'Share');
  on(share, 'click', () => ctx.onShare(e));
  const panel = el('aside', { class: 'tv-panel', role: 'dialog', 'aria-label': 'Event details' },
    el('div', { class: 'sheet-in esheet' },
      el('div', { class: 'sheet-h' },
        el('div', {},
          el('p', { class: 'eyebrow' }, `Event · ${seasonName(ctx.season)} ${ctx.year}`),
          el('h2', { class: 'etitle' }, e.title),
          (e.adultsOnly || far) && el('p', { class: 'etags' },
            e.adultsOnly && el('span', { class: 't21 big' }, '21+ · Adults only'),
            far && el('span', { class: 'tdrive big' }, 'Worth the drive'))),
        close),
      el('div', { class: 'sec' },
        el('div', { class: 'ewhen' },
          dateChipEl(e.startsAt, ctx.tz),
          el('p', {}, el('b', {}, whenLong(e, ctx.tz)), el('span', {}, 'Pacific time'))),
        el('p', { class: 'eplace' }, e.venue && el('b', {}, e.venue), el('span', {}, e.address)),
        el('p', { class: 'edesc' }, e.description)),
      el('div', { class: 'sec' },
        el('div', { class: 'eacts' },
          website && el('a', { class: 'btn ghost', href: website, target: '_blank', rel: 'nofollow ugc noopener noreferrer' }, webIcon(), 'Website'),
          el('a', { class: 'btn ghost', href: directionsUrl(e), target: '_blank', rel: 'noopener noreferrer' }, dirIcon(), 'Directions'),
          el('a', { class: 'btn ghost', href: googleCalendarUrl(e, ctx.tz), target: '_blank', rel: 'noopener noreferrer' }, calIcon(), 'Add to calendar'),
          page && el('a', { class: 'btn ghost', href: page, target: '_blank', rel: 'noopener' }, 'More on TruckeeVibes'),
          share),
        el('p', { class: 'fine' }, 'Add to calendar opens Google Calendar.'),
        credit())));
  return [scrim, panel];
}
