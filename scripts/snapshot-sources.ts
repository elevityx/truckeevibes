// Last-known sources: used by build-snapshot when the live list_sources_public read fails, so About never says "0 calendars"
// just because one build-time call failed.
export interface SnapshotSource {
  name: string;
  homepageUrl: string;
  status: 'active' | 'link_only' | 'paused';
}

const STATUSES: readonly string[] = ['active', 'link_only', 'paused'];

/** The well-formed `sources` of a previously written snapshot file (its text), or [] when there is none. */
export function lastKnownSources(previousFileText: string | null): SnapshotSource[] {
  if (!previousFileText) return [];
  try {
    const o = JSON.parse(previousFileText) as { sources?: unknown };
    const list = Array.isArray(o.sources) ? o.sources : [];
    return list
      .filter((x): x is SnapshotSource => {
        const r = x as Partial<SnapshotSource> | null;
        return !!r && typeof r.name === 'string' && typeof r.homepageUrl === 'string' && typeof r.status === 'string' && STATUSES.includes(r.status);
      })
      .map((r) => ({ name: r.name, homepageUrl: r.homepageUrl, status: r.status }));
  } catch {
    return [];
  }
}
