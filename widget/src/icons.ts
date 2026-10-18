// Lights' icons as SVG elements: EventIcons.tsx (ChevIcon, WebIcon, CalIcon), shell/Icons.tsx (XIcon, DirIcon, ShareIcon), EventGlyph.tsx.
import { svg } from './dom';
import type { Season } from './types';

const icon = (w: number, ...kids: SVGElement[]) =>
  svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }, ...kids);
const p = (d: string) => svg('path', { d });

export const chevIcon = () => icon(2, p('M9 6l6 6-6 6'));
export const webIcon = () => icon(2, svg('circle', { cx: 12, cy: 12, r: 9 }), p('M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18'));
export const calIcon = () => icon(2, svg('rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }), p('M3 10h18M8 3v4M16 3v4M12 13v5M9.5 15.5h5'));
export const xIcon = () => icon(2.4, p('M6 6l12 12M18 6L6 18'));
export const dirIcon = () => icon(2.2, p('M12 2l10 10-10 10L2 12z'), p('M9 14v-3h5M12 8.5L14.5 11 12 13.5'));
export const shareIcon = () => icon(2.2, p('M8 12h-2v8h12v-8h-2M12 3v12M8 7l4-4 4 4'));

/** Event glyph: a lantern for Halloween, a star for Christmas (EventGlyph.tsx). */
export function glyph(season: Season): SVGElement {
  const root = (...kids: SVGElement[]) => svg('svg', { viewBox: '0 0 40 40', 'aria-hidden': 'true', focusable: 'false' }, ...kids);
  if (season === 'christmas') {
    return root(
      svg('path', { d: 'M20 4l4.6 9.9 10.8 1.3-8 7.4 2.1 10.7L20 28l-9.5 5.3 2.1-10.7-8-7.4 10.8-1.3z', fill: '#F2C14E', stroke: '#a87a12', 'stroke-width': 1 }),
      svg('path', { d: 'M20 10l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z', fill: '#FFE9A8' }),
    );
  }
  return root(
    svg('path', { d: 'M14 10a6 6 0 0 1 12 0', stroke: '#B8A9CF', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }),
    svg('rect', { x: 12.5, y: 9.5, width: 15, height: 4, rx: 1.2, fill: '#4a2f6e', stroke: '#B8A9CF', 'stroke-width': 0.8 }),
    svg('path', { d: 'M12.5 13.5h15l-1.8 18h-11.4z', fill: '#2a1638', stroke: '#B8A9CF', 'stroke-width': 0.8 }),
    svg('path', { d: 'M15.2 15.5h9.6l-1.3 13.5h-7z', fill: '#FFB347' }),
    svg('path', { d: 'M20 18.5c2.4 2.6 2.6 5 0 7.6-2.6-2.6-2.4-5 0-7.6z', fill: '#FFF2C4' }),
    svg('path', { d: 'M20 15.5v13.5', stroke: '#4a2f6e', 'stroke-width': 1 }),
    svg('rect', { x: 11.5, y: 31.5, width: 17, height: 3.2, rx: 1, fill: '#4a2f6e', stroke: '#B8A9CF', 'stroke-width': 0.8 }),
  );
}
