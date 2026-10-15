export type DataErrorCode =
  | 'not_signed_in' | 'forbidden' | 'not_found' | 'invalid_input' | 'exists' | 'rate_limited'
  | 'source_not_permitted' | 'captcha_failed' | 'auth_failed' | 'network' | 'unknown';

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
