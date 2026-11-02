// Read requests for manual-only sources (Spec_Sources_V2 §7): the pure helpers behind `manual-read.sh requests` / `requested`.
// No I/O here; manualDb.ts imports from this file (never the other way round).

export const SLUG_RE = /^[a-z0-9-]{2,60}$/;

export interface PendingRequest { slug: string; requestedAt: string; nextDueAt: string | null }

export const REQUESTS_SQL = `select slug, read_requested_at as requested_at, next_due_at from public.sources
 where enabled and manual_only and read_requested_at > now() - interval '7 days' order by slug`;

// RFC 3339 (a "T" or the space Postgres prints between date and time; a short "+00" offset is widened to "+00:00").
const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/;
function iso(v: unknown): string | null {
  const m = typeof v === 'string' ? ISO_RE.exec(v) : null;
  if (!m) return null;
  const off = m[3] === 'Z' ? 'Z' : m[3].length === 3 ? `${m[3]}:00` : m[3].includes(':') ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const out = `${m[1]}T${m[2]}${off}`;
  return Number.isFinite(Date.parse(out)) ? out : null;
}

/** Drops rows whose slug fails SLUG_RE or whose times are not ISO strings (next_due_at may be null). */
export function parseRequests(rows: unknown[]): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const { slug, requested_at: at, next_due_at: next } = r as Record<string, unknown>;
    const requestedAt = iso(at);
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || !requestedAt) continue;
    const nextDueAt = next === null || next === undefined ? null : iso(next);
    if (next !== null && next !== undefined && !nextDueAt) continue;
    out.push({ slug, requestedAt, nextDueAt });
  }
  return out;
}

const PT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** One line per row: "<slug> · requested <time> PT · readable now|after <time> PT"; [] -> ["no pending read requests"]. */
export function formatRequests(rows: PendingRequest[], now: number): string[] {
  if (rows.length === 0) return ['no pending read requests'];
  return rows.map((r) => {
    const next = r.nextDueAt ? Date.parse(r.nextDueAt) : NaN;
    const when = Number.isFinite(next) && next > now ? `readable after ${PT.format(new Date(next))} PT` : 'readable now';
    return `${r.slug} · requested ${PT.format(new Date(r.requestedAt))} PT · ${when}`;
  });
}

export type GrantRefusal = 'gate' | 'withdrawn';

/** The database's own refusals; anything else is a real failure (null). */
export function grantRefusal(msg: string): GrantRefusal | null {
  if (/manual_request_withdrawn/.test(msg)) return 'withdrawn';
  if (/manual_grant_refused/.test(msg)) return 'gate';
  return null;
}

export function grantSql(slug: string, requested: boolean): string {
  if (!SLUG_RE.test(slug)) throw new Error('slug');
  return `select public.${requested ? 'svc_manual_grant_requested' : 'svc_manual_grant'}('${slug}') as g`;
}
