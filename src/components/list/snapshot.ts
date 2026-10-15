import type { VibeEvent } from '@/lib/data/types';

export interface Snapshot {
  builtAt: string | null;
  events: VibeEvent[];
}

const str = (v: unknown) => typeof v === 'string';

/** Keep only well-formed rows of /data/events.json; anything else is dropped rather than trusted. */
export function parseSnapshot(raw: unknown): Snapshot {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { builtAt?: unknown; events?: unknown };
  const events = (Array.isArray(o.events) ? o.events : []).filter((e): e is VibeEvent => {
    const r = e as Partial<VibeEvent> | null;
    return !!r && str(r.id) && str(r.title) && str(r.startsAt) && Array.isArray(r.categories) && Array.isArray(r.sources);
  });
  const builtAt = str(o.builtAt) && !Number.isNaN(Date.parse(o.builtAt as string)) ? (o.builtAt as string) : null;
  return { builtAt, events };
}
