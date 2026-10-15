import { getSupabase } from '@/lib/supabase/client';
import { toDataError } from './errors';
import type { AdminSource, PublicSource, PublicSourceStatus, SourceClass, SourceTrust } from './types';

const STATUSES: readonly string[] = ['active', 'link_only', 'paused'];

/** Public list of sources: name, homepage, status. No other column is reachable. */
export async function listSourcesPublic(): Promise<PublicSource[]> {
  try {
    const { data, error } = await getSupabase().rpc('list_sources_public');
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as Array<{ name: string; homepage_url: string; status: string }>;
    return rows.map((r) => ({
      name: String(r.name),
      homepageUrl: String(r.homepage_url),
      status: (STATUSES.includes(r.status) ? r.status : 'paused') as PublicSourceStatus,
    }));
  } catch (e) {
    throw toDataError(e);
  }
}

interface AdminSourceRow {
  slug: string; name: string; homepage_url: string; family: string; class: SourceClass; trust: SourceTrust;
  enabled: boolean; opt_out: boolean; ingest_disposition: string; terms_recheck_at: string | null;
}

export async function adminListSources(): Promise<AdminSource[]> {
  try {
    const { data, error } = await getSupabase().rpc('admin_list_sources');
    if (error) throw error;
    const rows = (Array.isArray(data) ? data : []) as AdminSourceRow[];
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      homepageUrl: r.homepage_url,
      family: r.family,
      class: r.class,
      trust: r.trust,
      enabled: r.enabled,
      optOut: r.opt_out,
      ingestDisposition: r.ingest_disposition,
      termsRecheckAt: r.terms_recheck_at,
    }));
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminSetSourceEnabled(slug: string, enabled: boolean): Promise<void> {
  try {
    const { error } = await getSupabase().rpc('admin_set_source_enabled', { p_slug: slug, p_enabled: enabled });
    if (error) throw error;
  } catch (e) {
    throw toDataError(e);
  }
}

export async function adminSetSourceTrust(slug: string, trust: SourceTrust): Promise<void> {
  try {
    const { error } = await getSupabase().rpc('admin_set_source_trust', { p_slug: slug, p_trust: trust });
    if (error) throw error;
  } catch (e) {
    throw toDataError(e);
  }
}
