// Service-role data access. The ONLY place the Edge Functions touch the database: the `svc_*` routines in `public`
// (migrations 20261020000200_ingest_rpcs.sql and 20261020000400_jobs.sql), granted to service_role alone.
// The client is built from function env, server-side only. Row shapes mirror those migrations; if a signature there
// changes, this is the one file to edit. Modeled on TL:supabase/functions/_shared/db.ts.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { secretKey } from './http.ts';

/** One entry of `svc_issue_run_grants()`: a single-use grant for one due source. */
export interface GrantOut {
  grant: string;
  run_id: string;
  source: {
    slug: string; family: string; config: Record<string, unknown>; allowed_hosts: string[]; allowed_methods: string[];
    page_cap: number; etag: string | null; last_modified: string | null; content_hash: string | null;
    ingest_disposition: string; terms_recheck_at: string | null;
  };
}
/** The run metadata the runner sends with a batch (`p_run`); the database reads only the documented keys. */
export type RunMeta = Record<string, unknown>
export interface GeocodeRequest { venue_id: string; query: string }
/** `svc_ingest_batch` result. `reasons` is present for an anomaly run. */
export interface BatchOut {
  run_id: string; status: string; new?: number; changed?: number; gone?: number; reasons?: string[]; geocode?: GeocodeRequest[];
  [key: string]: unknown;
}
export interface ClusterOut { processed: number; remaining: number; public_changed: boolean; busy?: boolean }

export interface IngestDb {
  /** `svc_ingest_nonce`: true when the nonce was fresh, false for a replay. A non-boolean reply is an error. */
  nonce(n: string): Promise<boolean>;
  grants(): Promise<GrantOut[]>;
  batch(grant: string, run: RunMeta, items: unknown[]): Promise<BatchOut>;
  setGeocode(venueId: string, lat: number | null, lng: number | null, geocoder: 'nominatim'): Promise<void>;
  cluster(limit: number): Promise<ClusterOut>;
}

/** `svc_weekly_report()`: numbers and source names only. Every key is optional so a consumer never trusts the shape. */
export type WeeklyReport = Partial<WeeklyReportFull>;
export interface WeeklyReportFull {
  queue_open: number; oldest_card_age_hours: number;
  cards_created_by_source_7d: { source: string; n: number }[];
  review_minutes_7d: number; decisions_7d: number; published_7d: number; auto_published_share_7d: number;
  broken_sources: { source: string; status: string | null; consecutive_failures: number; last_success_at: string | null }[];
  held_runs_pending: number; link_only_by_budget_7d: number;
  uncarded_pending: { source: string; n: number }[];
  rejected_out_of_region_7d: number;
  published_by_rule_7d: { publish: number; strict_auto: number };
  terms_recheck_due: { source: string; terms_recheck_at: string }[];
  geocode_month: { units: number; cap: number };
  heartbeat_hours: number | null;
}
export interface WeeklyDb { weeklyReport(): Promise<WeeklyReport> }

export class RpcError extends Error {
  constructor(message: string, readonly code: string | null = null) { super(message); }
}

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  // Never include the provider message: it can carry row data. The SQLSTATE alone is safe.
  if (error) throw new RpcError(`rpc ${fn} failed`, typeof error.code === 'string' ? error.code : null);
  return data as T;
}

export function ingestDb(sb: SupabaseClient): IngestDb {
  return {
    async nonce(n) {
      const r = await rpc<unknown>(sb, 'svc_ingest_nonce', { p_nonce: n });
      if (typeof r !== 'boolean') throw new RpcError('svc_ingest_nonce unexpected');
      return r;
    },
    async grants() {
      const r = await rpc<{ grants?: GrantOut[] } | null>(sb, 'svc_issue_run_grants', {});
      return Array.isArray(r?.grants) ? r.grants : [];
    },
    async batch(grant, run, items) {
      const r = await rpc<BatchOut | null>(sb, 'svc_ingest_batch', { p_grant: grant, p_run: run, p_items: items });
      if (!r || typeof r !== 'object') throw new RpcError('svc_ingest_batch empty');
      return r;
    },
    async setGeocode(venueId, lat, lng, geocoder) {
      await rpc<null>(sb, 'svc_set_venue_geocode', { p_venue_id: venueId, p_lat: lat, p_lng: lng, p_geocoder: geocoder });
    },
    async cluster(limit) {
      const r = await rpc<ClusterOut | null>(sb, 'svc_cluster_and_publish', { p_limit: limit });
      if (!r || typeof r !== 'object') throw new RpcError('svc_cluster_and_publish empty');
      return r;
    },
  };
}

export function weeklyDb(sb: SupabaseClient): WeeklyDb {
  return {
    async weeklyReport() {
      const r = await rpc<WeeklyReport | null>(sb, 'svc_weekly_report', {});
      if (!r || typeof r !== 'object') throw new RpcError('svc_weekly_report empty');
      return r;
    },
  };
}

export function serviceClient(url: string): SupabaseClient | null {
  const key = secretKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
