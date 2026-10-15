// Build-time snapshot for the list's first paint (spec S1.11). Writes public/data/events.json as {builtAt, events}.
// With NEXT_PUBLIC_SUPABASE_URL and the publishable key set, it calls list_events with the public key (the same call a
// visitor's browser makes). Without env, or if the call fails, it writes {builtAt, events: []} so `next build` never breaks.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mapEvent, type EventRow } from '../src/lib/data/mapEvent';

const OUT = 'public/data/events.json';
const CAP = 2000;

async function rows(url: string, key: string, days: number): Promise<EventRow[]> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/list_events`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_days: days }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`list_events HTTP ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as EventRow[]) : [];
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
  const builtAt = new Date().toISOString();
  let events: ReturnType<typeof mapEvent>[] = [];
  let note = 'no env, wrote an empty snapshot';
  if (url && key) {
    try {
      let r = await rows(url, key, 120);
      if (r.length >= CAP) {
        console.warn(`snapshot: list_events hit the ${CAP}-row cap for 120 days; retrying with 60`);
        r = await rows(url, key, 60);
      }
      events = r.map(mapEvent);
      note = `${events.length} events`;
    } catch (e) {
      note = `list_events failed (${e instanceof Error ? e.message : 'error'}), wrote an empty snapshot`;
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ builtAt, events }) + '\n');
  console.log(`snapshot: ${note} -> ${OUT}`);
}

void main();
