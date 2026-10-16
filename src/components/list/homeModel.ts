// Pure state for the home page: which counts are known, which view shows, and when the refresh notice appears.
import { buildCounts, heroCounts, type BuildCounts, type HeroCounts } from '@/lib/data/firstPaint';
import { REGION_TZ } from '@/lib/filters/predicates';
import type { ListSlug } from '@/lib/lists';
import type { ListLoad } from './listLoad';
import { showLoading } from './listLoad';
import type { SnapshotSource } from './snapshot';

export interface HomeModel {
  /** false = the numbers are unknown (empty snapshot, live not loaded): show none, never 0. */
  known: boolean;
  hero: HeroCounts | null;
  tileCounts: Record<ListSlug, number> | null;
  /** 0 = unknown: the "from N local calendars" clause is omitted. */
  activeSources: number;
  activeNames: string[];
}

export function homeModel(o: { load: ListLoad; counts: BuildCounts; liveSources: SnapshotSource[] | null; now: number }): HomeModel {
  const live = o.load.source === 'live';
  const known = live || o.counts.hero.total > 0;
  const names = o.liveSources ? o.liveSources.filter((s) => s.status === 'active').map((s) => s.name) : o.counts.sources.activeNames;
  const liveCounts = live ? buildCounts(o.load.events, [], o.now, REGION_TZ) : null;
  return {
    known,
    hero: !known ? null : live ? heroCounts(o.load.events, o.now, REGION_TZ) : o.counts.hero,
    tileCounts: !known ? null : liveCounts ? liveCounts.lists : o.counts.lists,
    activeSources: names.length,
    activeNames: names,
  };
}

export type View = 'loading' | 'error' | 'empty' | 'noresults' | 'list';

export function chooseView(o: { load: ListLoad; empty: boolean; upcoming: number; shown: number }): View {
  if (showLoading(o.load)) return 'loading';
  if (o.load.liveFailed && o.empty) return 'error';
  if (o.upcoming === 0) return 'empty';
  if (o.shown === 0) return 'noresults';
  return 'list';
}

/** The quiet "could not refresh" line: the live read failed but the build rows are on screen. */
export const refreshNotice = (load: ListLoad, empty: boolean): boolean => load.liveFailed && !empty;
