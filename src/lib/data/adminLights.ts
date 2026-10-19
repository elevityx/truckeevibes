import { getSupabase } from '@/lib/supabase/client';
import { toDataError } from './errors';
import { DataError } from './types';

// The admin Lights tab (spec W3.4, SD5): held mirror removals and the per-event Lights controls. The database enforces the
// admin gate (aal2, password + totp) on every RPC; nothing here is a security boundary.

export type LightsSeason = 'halloween' | 'christmas';
export type LightsInclude = 'auto' | 'yes' | 'no';
export interface LightsHeldRow { id: string; title: string | null; startsAt: string | null }
export interface LightsHold {
  region: string; season: LightsSeason; year: number; removalSet: LightsHeldRow[]; observations: number; firstObsAt: string; lastObsAt: string;
}
export interface LightsRun {
  status: 'ok' | 'held' | 'aborted'; abortCode: string | null; seen: number; added: number; changed: number; removed: number;
  held: number; invalid: number; finishedAt: string;
}
export interface LightsPairRuns { region: string; season: LightsSeason; year: number; runs: LightsRun[] }
export interface LightsMirrorStatus { holds: LightsHold[]; runs: LightsPairRuns[] }
export interface LightsEventRow {
  id: string; title: string; startsAt: string; lightsInclude: LightsInclude; shown: boolean; coveredLive: boolean; vetoed: boolean;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- PostgREST jsonb, mapped field by field below
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The held set changed since it was shown (admin_accept_lights_removals raises stale_set). */
export const STALE_SET = 'stale_set';

async function call(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = args === undefined ? await getSupabase().rpc(fn) : await getSupabase().rpc(fn, args);
    if (error) throw error;
    return data;
  } catch (e) {
    if (e && typeof e === 'object' && (e as { message?: unknown }).message === STALE_SET) throw new DataError('stale', STALE_SET);
    throw toDataError(e);
  }
}

function mapHold(h: Raw): LightsHold {
  return {
    region: h.region, season: h.season, year: num(h.year), observations: num(h.observations), firstObsAt: h.firstObsAt, lastObsAt: h.lastObsAt,
    removalSet: arr<Raw>(h.removalSet).map((r) => ({ id: r.id, title: r.title ?? null, startsAt: r.startsAt ?? null })),
  };
}
function mapRun(r: Raw): LightsRun {
  return {
    status: r.status, abortCode: r.abortCode ?? null, seen: num(r.seen), added: num(r.added), changed: num(r.changed), removed: num(r.removed),
    held: num(r.held), invalid: num(r.invalid), finishedAt: r.finishedAt,
  };
}

export async function adminLightsMirrorStatus(): Promise<LightsMirrorStatus> {
  const d = ((await call('admin_lights_mirror_status')) ?? {}) as Raw;
  return {
    holds: arr<Raw>(d.holds).map(mapHold),
    runs: arr<Raw>(d.runs).map((p) => ({ region: p.region, season: p.season, year: num(p.year), runs: arr<Raw>(p.runs).map(mapRun) })),
  };
}

/** Accepts exactly the shown set; a changed hold fails with DataError('stale', 'stale_set'). */
export async function adminAcceptLightsRemovals(region: string, season: LightsSeason, year: number, ids: string[]): Promise<void> {
  await call('admin_accept_lights_removals', { p_region: region, p_season: season, p_year: year, p_ids: ids });
}

export async function adminSetLightsInclude(event: string, value: LightsInclude): Promise<void> {
  await call('admin_set_lights_include', { p_event: event, p_value: value });
}

/** "Show on Lights anyway": an override newer than the Lights removal, plus include = yes. */
export async function adminSetLightsOverride(event: string): Promise<void> {
  await call('admin_set_lights_override', { p_event: event });
}

export async function adminLightsEvents(season: LightsSeason, year: number): Promise<LightsEventRow[]> {
  return arr<Raw>(await call('admin_lights_events', { p_season: season, p_year: year })).map((r) => ({
    id: r.id, title: r.title, startsAt: r.startsAt, lightsInclude: r.lightsInclude, shown: r.shown === true,
    coveredLive: r.coveredLive === true, vetoed: r.vetoed === true,
  }));
}
