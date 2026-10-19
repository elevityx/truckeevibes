// Pure helpers of the admin Lights tab (spec W3.4). The accept payload is exactly the set on screen: the database refuses any other.
import { DataError, toDataError, userMessage } from '@/lib/data';
import { STALE_SET, type LightsEventRow, type LightsHold, type LightsSeason } from '@/lib/data/adminLights';

export const STALE_SET_MESSAGE = 'The held set changed. Reload.';

export interface AcceptPayload { region: string; season: LightsSeason; year: number; ids: string[] }

/** The ids exactly as displayed, in display order (the RPC compares the sorted set). */
export function acceptPayload(h: LightsHold): AcceptPayload {
  return { region: h.region, season: h.season, year: h.year, ids: h.removalSet.map((r) => r.id) };
}

export function holdSummary(h: LightsHold): { count: number; observations: number; titles: string[] } {
  return { count: h.removalSet.length, observations: h.observations, titles: h.removalSet.map((r) => r.title ?? r.id) };
}

export function acceptErrorMessage(e: unknown): string {
  if (e instanceof DataError) return e.detail === STALE_SET ? STALE_SET_MESSAGE : userMessage(e);
  if (e && typeof e === 'object' && (e as { message?: unknown }).message === STALE_SET) return STALE_SET_MESSAGE;
  return userMessage(toDataError(e));
}

/** "Show on Lights anyway" is offered only where a Lights removal vetoes the event. */
export function canShowAnyway(r: LightsEventRow): boolean {
  return r.vetoed === true;
}

/** The pair a date falls in (Pacific windows: Halloween Sep 15 - Nov 1, Christmas Nov 15 - Jan 6); between seasons, the next one. */
export function currentPair(now: Date): { season: LightsSeason; year: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const y = get('year');
  const m = get('month');
  const d = get('day');
  if (m === 1 && d <= 6) return { season: 'christmas', year: y - 1 };
  if (m === 12 || (m === 11 && d >= 2)) return { season: 'christmas', year: y };
  return { season: 'halloween', year: y };
}
