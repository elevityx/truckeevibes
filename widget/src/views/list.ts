// Lights EventsList.tsx EventsView body, without ListControls and the land acknowledgement (both stay in the host page).
import { el } from '../dom';
import { groupEvents } from '../time';
import { credit } from './credit';
import { seasonName, type ViewCtx, type WidgetEvent } from './ctx';
import { emptyEvents, eventItem } from './row';
import { renderNote } from './states';

export function renderList(events: readonly WidgetEvent[], ctx: ViewCtx, onAdd?: () => void): HTMLElement | null {
  if (ctx.state === 'loading') return null;
  const g = groupEvents(events, ctx.now, ctx.tz);
  const groups: [string, WidgetEvent[]][] = [['Today', g.today], ['This week', g.week], ['Later', g.later]];
  const total = g.today.length + g.week.length + g.later.length;
  return el('div', { class: 'tv-list' },
    el('div', { class: 'list-head' },
      el('h2', { class: 'disp' }, 'Upcoming events'),
      el('p', {}, `${seasonName(ctx.season)} ${ctx.year} · Pacific time`)),
    renderNote(ctx.state, ctx.info),
    total === 0 && ctx.state !== 'failed' && emptyEvents(ctx.season, onAdd),
    ...groups.map(([label, items]) =>
      items.length > 0 &&
      el('section', { class: 'grp', 'aria-label': label },
        el('h3', {}, `${label} `, el('span', { class: 'gn' }, String(items.length))),
        el('ul', {}, ...items.map((e) => eventItem(e, ctx))))),
    credit());
}
