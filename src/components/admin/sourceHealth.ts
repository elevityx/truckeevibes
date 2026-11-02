import type { SourceHealthRow } from '@/lib/data/adminQueue';

/** green / amber / red for an enabled source; "off" for a disabled one (it is not being read, so nothing is wrong); "oncommand" for
 *  a quiet enabled manual-only source (Sources V2: it is read only when the owner asks, so quiet is not a fault). */
export type Health = 'red' | 'amber' | 'green' | 'off' | 'oncommand';

const H = 3_600_000;
const BAD_STATUSES = ['anomaly', 'parse_error', 'http_error'];

/** Hours between runs from a cadence like "24h"; unknown text counts as 24. */
function cadenceHours(c: string): number {
  const n = /^(\d+)h$/.exec(c);
  return n ? Number(n[1]) : 24;
}

/** Why a source is red, or null. Staleness = max(48 h, cadence + 12 h) (A3). Never succeeded counts as stale. */
export function redReason(s: SourceHealthRow, now: Date): string | null {
  if (s.consecutiveFailures >= 2) return `${s.consecutiveFailures} failed runs in a row`;
  const last = s.lastRuns[0];
  if (last && BAD_STATUSES.includes(last.status)) return `last run: ${last.status}`;
  if (s.manualOnly) return null; // read on command: never red for "never read" or staleness
  if (s.lastSuccessAt === null) return 'never read successfully';
  const limit = Math.max(48, cadenceHours(s.cadence) + 12) * H;
  if (now.getTime() - Date.parse(s.lastSuccessAt) > limit) return 'no recent successful read';
  return null;
}

export function amberReason(s: SourceHealthRow, now: Date): string | null {
  if (s.termsRecheckAt !== null && Date.parse(s.termsRecheckAt) <= now.getTime() + 14 * 24 * H) return 'terms re-check due within 14 days';
  if (s.openCards7d >= 5) return `${s.openCards7d} open cards this week`;
  return null;
}

export function sourceHealth(s: SourceHealthRow, now: Date): Health {
  if (!s.enabled) return 'off';
  if (redReason(s, now)) return 'red';
  if (amberReason(s, now)) return 'amber';
  return s.manualOnly ? 'oncommand' : 'green';
}

/** Why a source is off, when the last run says so. */
export function offReason(s: SourceHealthRow): string | null {
  return s.lastRuns[0]?.errorCode === 'site_block' ? 'blocked by the site' : null;
}
