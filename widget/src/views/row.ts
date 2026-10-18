// Lights EventsList.tsx EventRow (:17-46) and DateChip.tsx, as DOM.
import { el, on } from '../dom';
import { chevIcon, glyph } from '../icons';
import { townOf, worthTheDrive } from '../links';
import { dateChip, whenLong, whenShort } from '../time';
import type { Season } from '../types';
import type { ViewCtx, WidgetEvent } from './ctx';

/** OCT / 30 / Fri, in the region's zone. Decorative: rows and sheets say the date in words too. */
export function dateChipEl(iso: string, tz: string): HTMLElement {
  const c = dateChip(iso, tz);
  return el('span', { class: 'dchip', 'aria-hidden': 'true' },
    el('span', { class: 'mo' }, c.month), el('span', { class: 'dd' }, String(c.day)), el('span', { class: 'wd' }, c.weekday));
}

export function eventRow(e: WidgetEvent, ctx: ViewCtx): HTMLElement {
  const town = townOf(e.address);
  const far = worthTheDrive(ctx.localBox, e);
  const label = `${e.title}, ${whenLong(e, ctx.tz)}${town ? `, ${town}` : ''}${e.adultsOnly ? ', adults only, 21 and over' : ''}${far ? ', worth the drive' : ''}`;
  const b = el('button', { type: 'button', class: 'erow', 'aria-label': label, 'data-id': e.id },
    dateChipEl(e.startsAt, ctx.tz),
    el('span', { class: 'info', 'aria-hidden': 'true' },
      el('strong', {}, e.title),
      el('span', { class: 'meta' },
        el('span', {}, `${whenShort(e, ctx.tz)}${town ? ` · ${town}` : ''}`),
        e.adultsOnly && el('span', { class: 't21' }, '21+'),
        far && el('span', { class: 'tdrive' }, 'Worth the drive'))),
    el('span', { class: 'chev', 'aria-hidden': 'true' }, chevIcon()));
  on(b, 'click', () => ctx.onOpen(e.id));
  return b;
}

export const eventItem = (e: WidgetEvent, ctx: ViewCtx) => el('li', {}, eventRow(e, ctx));

/** EmptyEvents: the season glyph, the invite and (while submissions are open) the Add button. */
export function emptyEvents(season: Season, onAdd?: () => void): HTMLElement {
  const btn = onAdd ? el('button', { type: 'button', class: 'btn primary' }, 'Add an event') : null;
  if (btn && onAdd) on(btn, 'click', () => onAdd());
  return el('div', { class: 'eempty' }, glyph(season), el('p', {}, 'No events yet — know one? Add it.'), btn);
}
