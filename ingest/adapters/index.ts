// Registry family -> Adapter. Families without an adapter (squarespace, rss, html) are recorded `skipped`/`no_adapter` by the runner.
import type { Adapter } from '../types';
import { adapter as tribe } from './tribe';
import { adapter as icsChambermaster } from './icsChambermaster';
import { adapter as icsCivicplus } from './icsCivicplus';
import { adapter as icsEventsmanager } from './icsEventsmanager';

export const adapters: Record<string, Adapter> = {
  [tribe.family]: tribe,
  [icsChambermaster.family]: icsChambermaster,
  [icsCivicplus.family]: icsCivicplus,
  [icsEventsmanager.family]: icsEventsmanager,
};
