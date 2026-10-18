// Lights EventsList.tsx UpcomingEvents (:123-149): the Both view's next 3 events and a link to all of them.
import { el, on } from '../dom';
import { groupEvents } from '../time';
import { credit } from './credit';
import type { ViewCtx, WidgetEvent } from './ctx';
import { emptyEvents, eventItem } from './row';
import { renderNote } from './states';

export function renderUpcoming(events: readonly WidgetEvent[], ctx: ViewCtx, o: { onAdd?(): void; onSeeAll(): void }): HTMLElement | null {
  if (ctx.state === 'loading') return null;
  const g = groupEvents(events, ctx.now, ctx.tz);
  const all = [...g.today, ...g.week, ...g.later];
  let side: HTMLElement | null = null;
  if (all.length > 3) {
    side = el('button', { type: 'button', class: 'linkbtn' }, 'See all events');
    on(side, 'click', () => o.onSeeAll());
  } else if (all.length > 0) side = el('p', {}, `Next ${all.length}`);
  return el('section', { class: 'upcoming', 'aria-label': 'Upcoming events' },
    el('div', { class: 'list-head' }, el('h2', { class: 'disp' }, 'Upcoming events'), side),
    renderNote(ctx.state, ctx.info),
    all.length === 0
      ? ctx.state !== 'failed' && emptyEvents(ctx.season, o.onAdd ? () => o.onAdd?.() : undefined)
      : el('ul', { class: 'erows' }, ...all.slice(0, 3).map((e) => eventItem(e, ctx))),
    credit());
}
