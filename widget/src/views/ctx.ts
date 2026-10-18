// What every view needs from the controller.
import type { Box, Season, State, StateInfo, WidgetEvent } from '../types';

export interface ViewCtx {
  season: Season;
  year: number;
  tz: string;
  localBox: Box;
  now: number;
  state: State;
  info: StateInfo;
  onOpen(id: string): void;
}
export const seasonName = (s: Season) => (s === 'halloween' ? 'Halloween' : 'Christmas');
export type { WidgetEvent };
