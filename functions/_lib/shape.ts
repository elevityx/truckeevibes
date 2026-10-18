// Builds the public envelope from the RPC result, driven by events.v1.schema.json (the SSOT): only schema keys are copied,
// and any missing or mistyped required key makes the whole envelope invalid (null -> the Function treats it as a failure).
import schema from './events.v1.schema.json';
import type { Query } from './query';

type S = { [k: string]: unknown };
const ROOT = schema as unknown as S;

export interface EventRow {
  id: string; origin: 'lights' | 'vibes'; formerIds: string[]; pageUrl: string | null; title: string; description: string | null;
  summary: string | null; startsAt: string; endsAt: string | null; allDay: boolean; startDate: string | null; endDate: string | null;
  timeKnown: boolean; venue: string | null; address: string | null; town: string | null; lat: number | null; lng: number | null;
  categories: string[]; age: string; adultsOnly: boolean; url: string | null; ticketUrl: string | null;
}
export interface Envelope {
  version: 1; scope: 'vibes' | 'lights'; season: 'halloween' | 'christmas' | null; year: number | null; dataAt: string; stale: boolean;
  pageComplete: boolean; mirror: { state: 'none' | 'confirmed' | 'held'; confirmedAt: string | null; heldSince: string | null; heldCount: number };
  region: { tz: string; localBox: { minLat: number; maxLat: number; minLng: number; maxLng: number } };
  count: number; nextCursor: string | null; attribution: { name: 'TruckeeVibes'; url: 'https://truckeevibes.com/' }; events: EventRow[];
}

const INVALID = Symbol('invalid');
const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);

function resolve(s: S): S {
  if (typeof s.$ref !== 'string') return s;
  return s.$ref.replace(/^#\//, '').split('/').reduce<unknown>((o, k) => (o as S)[k], ROOT) as S;
}

// copy `v` keeping only what `s` describes; INVALID on any violation
function pick(sIn: S, v: unknown): unknown {
  const s = resolve(sIn);
  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    const t = typeOf(v);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return INVALID;
    if (t === 'number' && !Number.isFinite(v)) return INVALID;
  }
  if ('const' in s && v !== s.const) return INVALID;
  if (Array.isArray(s.enum) && !s.enum.includes(v)) return INVALID;
  if (typeof s.minimum === 'number' && typeof v === 'number' && v < s.minimum) return INVALID;
  if (Array.isArray(v)) {
    if (!s.items) return INVALID;
    const out: unknown[] = [];
    for (const x of v) {
      const p = pick(s.items as S, x);
      if (p === INVALID) return INVALID;
      out.push(p);
    }
    return out;
  }
  if (v !== null && typeof v === 'object') {
    const props = (s.properties ?? {}) as Record<string, S>;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of (s.required ?? []) as string[]) if (!Object.prototype.hasOwnProperty.call(o, k)) return INVALID;
    for (const k of Object.keys(props)) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      const p = pick(props[k], o[k]);
      if (p === INVALID) return INVALID;
      out[k] = p;
    }
    return out;
  }
  return v;
}

export function shapeEnvelope(raw: unknown, q: Query): Envelope | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const full = {
    ...r,
    version: 1,
    scope: q.scope,
    season: q.season ?? null,
    year: q.year ?? null,
    stale: false,
    pageComplete: r.nextCursor === null,
    attribution: { name: 'TruckeeVibes', url: 'https://truckeevibes.com/' },
  };
  const out = pick(ROOT, full);
  return out === INVALID ? null : (out as Envelope);
}
