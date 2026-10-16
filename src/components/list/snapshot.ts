import type { VibeEvent } from '@/lib/data/types';

/** One public source as the build snapshot stores it (DR8): the same three fields list_sources_public() returns. */
export interface SnapshotSource {
  name: string;
  homepageUrl: string;
  status: 'active' | 'link_only' | 'paused';
}

export interface Snapshot {
  builtAt: string | null;
  events: VibeEvent[];
  sources: SnapshotSource[];
}

const str = (v: unknown) => typeof v === 'string';
const STATUSES: readonly string[] = ['active', 'link_only', 'paused'];

/** Keep only well-formed rows of /data/events.json; anything else is dropped rather than trusted. */
export function parseSnapshot(raw: unknown): Snapshot {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { builtAt?: unknown; events?: unknown; sources?: unknown };
  const events = (Array.isArray(o.events) ? o.events : []).filter((e): e is VibeEvent => {
    const r = e as Partial<VibeEvent> | null;
    return !!r && str(r.id) && str(r.title) && str(r.startsAt) && Array.isArray(r.categories) && Array.isArray(r.sources);
  });
  const sources = (Array.isArray(o.sources) ? o.sources : [])
    .filter((x): x is SnapshotSource => {
      const r = x as Partial<SnapshotSource> | null;
      return !!r && str(r.name) && str(r.homepageUrl) && str(r.status) && STATUSES.includes(r.status as string);
    })
    .map((r) => ({ name: r.name, homepageUrl: r.homepageUrl, status: r.status }));
  const builtAt = str(o.builtAt) && !Number.isNaN(Date.parse(o.builtAt as string)) ? (o.builtAt as string) : null;
  return { builtAt, events, sources };
}
