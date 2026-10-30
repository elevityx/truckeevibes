// Shared ingest types (spec S1.8). The adapters turn bytes into `SourceEvent`s; the runner submits them under a grant.
import type { PoliteFetch } from './core/politeFetch';
import type { ReasonCode } from './core/reasonCodes';

export type RunStatus = 'ok' | 'not_modified' | 'robots_blocked' | 'http_error' | 'parse_error' | 'skipped';
export type PriceKind = 'free' | 'paid' | 'donation' | 'unknown';
export type AgeKind = 'all_ages' | 'family' | '18_plus' | '21_plus' | 'unknown';

/** Plan 3.2, plus `seriesUid` and the classifier output the database re-validates. Never carries description text. */
export interface SourceEvent {
  externalKey: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  timeKnown: boolean;
  tz: string;
  venueName?: string;
  address?: string;
  town?: string;
  lat?: number;
  lng?: number;
  url?: string;
  ticketUrl?: string;
  priceText?: string;
  ageText?: string;
  categoriesHint: string[];
  cancelled?: boolean;
  rawSummaryLength: number;
  seriesUid?: string;
  priceKind?: PriceKind;
  priceMin?: number;
  priceMax?: number;
  age?: AgeKind;
  /** Classifier reason codes (closed list, <= 16). Stored by the database next to the facts; never part of the facts hash. */
  tagReasons?: ReasonCode[];
}

/** One entry of `due_sources`: a single-use grant for one due source (mirrors supabase/functions/_shared/db.ts). */
export interface GrantOut {
  grant: string;
  run_id: string;
  source: {
    slug: string; family: string; config: Record<string, unknown>; allowed_hosts: string[]; allowed_methods: string[];
    page_cap: number; etag: string | null; last_modified: string | null; content_hash: string | null;
    ingest_disposition: string; terms_recheck_at: string | null;
  };
}

/** `p_run` as the runner sends it (snake_case; counters are computed by the database, never sent). */
export interface RunMeta {
  status: RunStatus;
  started_at: string;
  duration_ms?: number;
  http_status?: number;
  etag?: string;
  last_modified?: string;
  content_hash?: string;
  parser_version?: string;
  error_code?: string;
  error_detail?: string;
  robots?: { hash?: string; ai_bots_blocked?: boolean };
}

export interface AdapterCtx { source: GrantOut['source']; fetch: PoliteFetch; now: Date }

export interface AdapterResult {
  items: SourceEvent[];
  status: RunStatus;
  httpStatus?: number;
  etag?: string;
  lastModified?: string;
  contentHash?: string;
  errorCode?: string;
  robots?: { hash: string; aiBotsBlocked: boolean };
  /** Items removed by `config.filter` (Tribe); logged, never submitted. */
  filtered?: number;
  /** `filtered` split by drop reason (Tahoe Donner); counts only. */
  filteredBy?: Record<string, number>;
}

export interface Adapter {
  family: string;
  version: string;
  fetch(ctx: AdapterCtx): Promise<AdapterResult>;
}
