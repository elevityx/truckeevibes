// Registry family -> Adapter. Families without an adapter (squarespace, rss, html) are recorded `skipped`/`no_adapter` by the runner.
import type { Adapter } from '../types';
import { adapter as tribe } from './tribe';
import { adapter as icsChambermaster } from './icsChambermaster';
import { adapter as icsCivicplus } from './icsCivicplus';
import { adapter as icsEventsmanager } from './icsEventsmanager';
import { adapter as htmlFinalsite } from './htmlFinalsite';
import { adapter as htmlTahoeDonner } from './htmlTahoeDonner';
import { adapter as wprestCrystalBay } from './wprestCrystalBay';
import { adapter as curatedDates } from './curatedDates';
import { adapter as rssLibcal } from './rssLibcal';

export const adapters: Record<string, Adapter> = {
  [tribe.family]: tribe,
  [icsChambermaster.family]: icsChambermaster,
  [icsCivicplus.family]: icsCivicplus,
  [icsEventsmanager.family]: icsEventsmanager,
  [htmlFinalsite.family]: htmlFinalsite,
  [htmlTahoeDonner.family]: htmlTahoeDonner,
  [wprestCrystalBay.family]: wprestCrystalBay,
  [curatedDates.family]: curatedDates,
  [rssLibcal.family]: rssLibcal,
};
