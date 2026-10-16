// Build/server only: reads the snapshot that scripts/build-snapshot.ts wrote. Never import this from a client component.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnapshot, type Snapshot } from '@/components/list/snapshot';
import type { VibeEvent } from './types';

export const SNAPSHOT_PATH = 'public/data/events.json';

const KEYS: (keyof VibeEvent)[] = [
  'id', 'slug', 'title', 'summary', 'startsAt', 'endsAt', 'allDay', 'startDate', 'endDate', 'timeKnown', 'venue', 'address', 'town',
  'area', 'lat', 'lng', 'categories', 'priceKind', 'priceMin', 'priceMax', 'age', 'featured', 'url', 'ticketUrl', 'sources',
];

/** Copy exactly the VibeEvent keys, so nothing else in the file can reach the page. */
function pickVibeEvent(e: VibeEvent): VibeEvent {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) out[k] = e[k];
  return out as unknown as VibeEvent;
}

/** The build snapshot, parsed and field-whitelisted; missing, unreadable or invalid JSON gives the empty snapshot. Never throws. */
export function readBuildSnapshot(path: string = join(process.cwd(), SNAPSHOT_PATH)): Snapshot {
  try {
    const s = parseSnapshot(JSON.parse(readFileSync(path, 'utf8')));
    return { builtAt: s.builtAt, events: s.events.map(pickVibeEvent), sources: s.sources };
  } catch {
    return { builtAt: null, events: [], sources: [] };
  }
}
