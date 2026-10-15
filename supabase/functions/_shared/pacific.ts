// Wall-clock parts in the region's zone with Intl, never the host zone. Copied from TL:supabase/functions/_shared/pacific.ts
// (pacificParts only): used to decide whether a weekly fire is the 07:xx Pacific one.
export const REGION_TZ = 'America/Los_Angeles';

export interface PacificParts { date: string; hour: number; weekday: string }

export function pacificParts(now: Date): PacificParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REGION_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, weekday: get('weekday') };
}
