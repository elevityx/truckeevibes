// One exact Lights snapshot of the current (region, season, year) pair (spec W3.3): context, the exact-count events read, context
// again. Any doubt (a partial list, a row of another pair, the pair changing mid-read) is a failure code, never a short snapshot.
import { FetchError } from '../core/politeFetch';
import type { LightsClient } from './lightsClient';

export type Season = 'halloween' | 'christmas';
export interface LightsPair { region: 'truckee'; season: Season; year: number }
/** A public Lights event row, as GET /rest/v1/events returns it (the columns Lights grants to anon). */
export interface LightsRow {
  id: string; region_id: string; season: string; year: number; title: string; description: string; venue: string | null;
  address: string; lat: number; lng: number; starts_at: string; ends_at: string | null; url: string | null; adults_only: boolean;
}
export type SnapshotResult =
  | { ok: true; pair: LightsPair; rows: LightsRow[] }
  | { ok: false; code: string; pair?: LightsPair };

export const EVENTS_SELECT = 'id,region_id,season,year,title,description,venue,address,lat,lng,starts_at,ends_at,url,adults_only';
const LIMIT = 1000;

interface Ctx { regionId: string; pair: LightsPair }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseCtx(v: unknown): Ctx | 'no_events' | 'bad_context' {
  if (!isObj(v) || !('events' in v)) return 'no_events';
  const r = v.region;
  if (!isObj(r) || typeof r.id !== 'string' || r.slug !== 'truckee') return 'bad_context';
  if (v.season !== 'halloween' && v.season !== 'christmas') return 'bad_context';
  if (typeof v.year !== 'number' || !Number.isInteger(v.year)) return 'bad_context';
  return { regionId: r.id, pair: { region: 'truckee', season: v.season, year: v.year } };
}

const codeOf = (e: unknown) => {
  if (e instanceof FetchError) return e.code;
  const m = e instanceof Error ? e.message : '';
  return /^[a-z0-9_]{1,40}$/.test(m) ? m : 'unknown';
};

export async function readLightsSnapshot(client: LightsClient): Promise<SnapshotResult> {
  let ctx1: Ctx | undefined;
  try {
    const c1 = parseCtx(await client.rpc('get_region_context', { p_slug: 'truckee' }));
    if (typeof c1 === 'string') return { ok: false, code: c1 };
    ctx1 = c1;
    const q = new URLSearchParams({
      select: EVENTS_SELECT, region_id: `eq.${c1.regionId}`, season: `eq.${c1.pair.season}`, year: `eq.${c1.pair.year}`,
      order: 'starts_at,id', limit: String(LIMIT),
    });
    const { rows, total } = await client.selectEvents(q);
    if (total === null || rows.length >= LIMIT || total !== rows.length) return { ok: false, code: 'partial', pair: c1.pair };
    for (const r of rows) {
      if (!isObj(r) || r.region_id !== c1.regionId || r.season !== c1.pair.season || r.year !== c1.pair.year) {
        return { ok: false, code: 'pair_mismatch', pair: c1.pair };
      }
    }
    const c2 = parseCtx(await client.rpc('get_region_context', { p_slug: 'truckee' }));
    if (typeof c2 === 'string' || c2.regionId !== c1.regionId || c2.pair.season !== c1.pair.season || c2.pair.year !== c1.pair.year) {
      return { ok: false, code: 'pair_changed', pair: c1.pair };
    }
    return { ok: true, pair: c1.pair, rows: rows as LightsRow[] };
  } catch (e) {
    return ctx1 ? { ok: false, code: codeOf(e), pair: ctx1.pair } : { ok: false, code: codeOf(e) };
  }
}
