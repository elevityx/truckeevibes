export type DataErrorCode =
  | 'not_signed_in' | 'forbidden' | 'not_found' | 'invalid_input' | 'exists' | 'rate_limited'
  | 'source_not_permitted' | 'captcha_failed' | 'auth_failed' | 'network' | 'not_pending' | 'stale' | 'unknown';

export class DataError extends Error {
  constructor(
    public code: DataErrorCode,
    public detail?: string,
  ) {
    super(code);
  }
}

export type SourceClass = 'organizer' | 'municipal' | 'venue' | 'dmo' | 'aggregator' | 'community' | 'llm';
export type SourceTrust = 'auto' | 'review' | 'link_only';
export type PublicSourceStatus = 'active' | 'link_only' | 'paused';

/** One row of list_sources_public(). */
export interface PublicSource {
  name: string;
  homepageUrl: string;
  status: PublicSourceStatus;
}

/** One row of admin_list_sources() (the columns the console shows). */
export interface AdminSource {
  slug: string;
  name: string;
  homepageUrl: string;
  family: string;
  class: SourceClass;
  trust: SourceTrust;
  enabled: boolean;
  optOut: boolean;
  ingestDisposition: string;
  termsRecheckAt: string | null;
}

/** An area slug (public.areas.slug). The seven seeded slugs are listed in lib/filters/state.ts (AREAS); the type stays open. */
export type Area = string;

/** The When filter: a named window or one Pacific calendar day. */
export type When = 'today' | 'tonight' | 'tomorrow' | 'weekend' | '7d' | { date: string };

export type PriceKind = 'free' | 'paid' | 'donation' | 'unknown';

/** One row of list_events(), camelCased. Only these columns are ever exposed to the page. */
export interface VibeEvent {
  id: string;
  slug: string;
  title: string;
  summary: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  /** All-day events: first day, and the day after the last (exclusive), as YYYY-MM-DD. */
  startDate: string | null;
  endDate: string | null;
  timeKnown: boolean;
  venue: string | null;
  address: string | null;
  town: string | null;
  area: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  priceKind: PriceKind;
  priceMin: number | null;
  priceMax: number | null;
  age: string;
  featured: boolean;
  url: string | null;
  ticketUrl: string | null;
  sources: string[];
}
