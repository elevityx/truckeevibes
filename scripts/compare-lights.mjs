// C7 comparator (Spec_Vibes_Widget W3.3, SD7): Lights' public event list vs the TruckeeVibes API (scope=lights), hourly.
// Usage: node scripts/compare-lights.mjs   (env LIGHTS_REST_URL, LIGHTS_PUBLISHABLE_KEY; VIBES_API_URL defaults to truckeevibes.com)
// A run passes only when, on the final read: the Lights read is exact and pair-consistent, the API is drained (<= 4 pages, every
// page version 1, stale false, one mirror object), mirror.state is confirmed and fresh, and the id sets and fields are identical.
// A non-pass first read is re-read once after 6 minutes (cache lag). Exit 0 pass, 1 mismatch, 2 incomplete/transport, 3 held,
// 4 stale or no mirror. Prints ids and counts only, never titles. Holds no secret (the publishable key is public).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RECHECK_MS = 360_000;
const MAX_PAGES = 4;
const CONFIRMED_MAX_MS = 35 * 60_000;
const DATA_MAX_MS = 10 * 60_000;
const SELECT = 'id,region_id,season,year,title,description,venue,address,lat,lng,starts_at,ends_at,url,adults_only';
const FIELDS = ['title', 'description', 'venue', 'address', 'lat', 'lng', 'startsAt', 'endsAt', 'url', 'adultsOnly'];
const EXIT = { pass: 0, mismatch: 1, transport: 2, held: 3, stale_mirror: 4 };

class Incomplete extends Error {}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** An instant as ISO seconds with Z; null stays null. */
const instant = (v) => {
  if (v === null || v === undefined) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : `invalid:${v}`;
};

async function getJson(fetchFn, url, init) {
  let res;
  try {
    res = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Incomplete('fetch');
  }
  if (res.status !== 200) throw new Incomplete(`http_${res.status}`);
  try {
    return { body: await res.json(), res };
  } catch {
    throw new Incomplete('parse');
  }
}

async function readLights(env, fetchFn) {
  const base = new URL(env.LIGHTS_REST_URL).origin;
  const headers = { apikey: env.LIGHTS_PUBLISHABLE_KEY, authorization: `Bearer ${env.LIGHTS_PUBLISHABLE_KEY}`, accept: 'application/json' };
  const ctx = async () => {
    const { body } = await getJson(fetchFn, `${base}/rest/v1/rpc/get_region_context`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ p_slug: 'truckee' }),
    });
    if (!isObj(body) || !isObj(body.region) || typeof body.region.id !== 'string' || !['halloween', 'christmas'].includes(body.season)
        || !Number.isInteger(body.year) || !('events' in body)) throw new Incomplete('context');
    return { regionId: body.region.id, season: body.season, year: body.year };
  };
  const c1 = await ctx();
  const q = new URLSearchParams({ select: SELECT, region_id: `eq.${c1.regionId}`, season: `eq.${c1.season}`, year: `eq.${c1.year}`,
    order: 'starts_at,id', limit: '1000' });
  const { body: rows, res } = await getJson(fetchFn, `${base}/rest/v1/events?${q}`, { method: 'GET', headers: { ...headers, prefer: 'count=exact' } });
  const m = /^(?:\d+-\d+|\*)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  if (!Array.isArray(rows) || !m || Number(m[1]) !== rows.length || rows.length >= 1000) throw new Incomplete('partial');
  if (rows.some((r) => !isObj(r) || r.region_id !== c1.regionId || r.season !== c1.season || r.year !== c1.year)) throw new Incomplete('pair_mismatch');
  const c2 = await ctx();
  if (c2.regionId !== c1.regionId || c2.season !== c1.season || c2.year !== c1.year) throw new Incomplete('pair_changed');
  return { season: c1.season, year: c1.year, rows };
}

async function readApi(env, fetchFn, season, year) {
  const base = (env.VIBES_API_URL || 'https://truckeevibes.com').replace(/\/+$/, '');
  const events = [];
  let cursor = null;
  let mirror;
  let dataAt = null;
  let pages = 0;
  for (;;) {
    if (pages >= MAX_PAGES) throw Object.assign(new Incomplete('not_drained'), { pages });
    const q = new URLSearchParams({ scope: 'lights', season, year: String(year) });
    if (cursor) q.set('cursor', cursor);
    const { body } = await getJson(fetchFn, `${base}/api/v1/events?${q}`, { method: 'GET', headers: { accept: 'application/json' } });
    pages++;
    if (!isObj(body) || body.version !== 1 || body.stale !== false || !Array.isArray(body.events) || !isObj(body.mirror)) {
      throw Object.assign(new Incomplete('page'), { pages });
    }
    const mj = JSON.stringify(body.mirror);
    if (mirror !== undefined && mj !== mirror) throw Object.assign(new Incomplete('mirror_changed'), { pages });
    mirror = mj;
    if (dataAt === null || Date.parse(body.dataAt) < Date.parse(dataAt)) dataAt = body.dataAt;   // the oldest page counts
    events.push(...body.events);
    if (body.nextCursor === null || body.nextCursor === undefined) break;
    cursor = String(body.nextCursor);
  }
  return { events, mirror: JSON.parse(mirror), dataAt, pages };
}

/** One comparison pass. Returns { result, line, extra? } without exiting. */
async function pass(deps) {
  const { env, fetch: fetchFn, now } = deps;
  let lights;
  let api;
  let pages = 0;
  try {
    lights = await readLights(env, fetchFn);
    api = await readApi(env, fetchFn, lights.season, lights.year);
    pages = api.pages;
  } catch (e) {
    if (!(e instanceof Incomplete)) throw e;
    pages = e.pages ?? 0;
    const pair = lights ? `${lights.season}-${lights.year}` : 'unknown';
    return { result: 'transport', line: `compare: pair=${pair} lights=${lights ? lights.rows.length : 0} api_lights=0 missing= extra= field_diff= `
      + `vibes_added=0 vibes_added_ids= mirror=unknown confirmed_age_min=- pages=${pages} result=transport` };
  }
  const apiLights = new Map(api.events.filter((x) => x.origin === 'lights').map((x) => [x.id, x]));
  const vibes = api.events.filter((x) => x.origin === 'vibes').map((x) => x.id).sort();
  const lightsIds = new Map(lights.rows.map((r) => [r.id, r]));
  const missing = [...lightsIds.keys()].filter((id) => !apiLights.has(id)).sort();
  const extra = [...apiLights.keys()].filter((id) => !lightsIds.has(id)).sort();
  const diffs = [];
  for (const [id, r] of [...lightsIds].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const a = apiLights.get(id);
    if (!a) continue;
    const want = { title: r.title, description: r.description, venue: r.venue, address: r.address, lat: r.lat, lng: r.lng,
      startsAt: instant(r.starts_at), endsAt: instant(r.ends_at), url: r.url, adultsOnly: r.adults_only };
    const have = { ...Object.fromEntries(FIELDS.map((f) => [f, a[f]])), startsAt: instant(a.startsAt), endsAt: instant(a.endsAt) };
    for (const f of FIELDS) if (!Object.is(want[f] ?? null, have[f] ?? null)) diffs.push(`${id}:${f}`);
  }
  const m = api.mirror;
  const t = now();
  const confirmedAge = m.confirmedAt ? t - Date.parse(m.confirmedAt) : null;
  let result;
  let extraLine;
  if (m.state === 'held') {
    result = 'held';
    extraLine = `compare: held count=${Number(m.heldCount) || 0} since=${instant(m.heldSince) ?? '-'}`;
  } else if (m.state !== 'confirmed' || confirmedAge === null || !(confirmedAge <= CONFIRMED_MAX_MS) || !(t - Date.parse(api.dataAt) <= DATA_MAX_MS)) {
    result = 'stale_mirror';
  } else if (missing.length || extra.length || diffs.length) {
    result = 'mismatch';
  } else {
    result = 'pass';
  }
  const line = `compare: pair=${lights.season}-${lights.year} lights=${lights.rows.length} api_lights=${apiLights.size} missing=${missing.join(',')} `
    + `extra=${extra.join(',')} field_diff=${diffs.join(',')} vibes_added=${vibes.length} vibes_added_ids=${vibes.join(',')} `
    + `mirror=${/^[a-z]{1,20}$/.test(m.state) ? m.state : 'unknown'} confirmed_age_min=${confirmedAge === null ? '-' : Math.floor(confirmedAge / 60_000)} `
    + `pages=${pages} result=${result}`;
  return { result, line, extra: extraLine };
}

export async function compareLights(deps) {
  const log = deps.log ?? ((l) => console.log(l));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const d = { ...deps, now: deps.now ?? Date.now, fetch: deps.fetch ?? globalThis.fetch };
  if (!d.env?.LIGHTS_REST_URL || !d.env?.LIGHTS_PUBLISHABLE_KEY) {
    log('compare: LIGHTS_REST_URL and LIGHTS_PUBLISHABLE_KEY are required');
    return EXIT.transport;
  }
  let r = await pass(d);
  if (r.result !== 'pass') {
    log(`${r.line} recheck_in_s=${RECHECK_MS / 1000}`.replace(/^compare: pair=/, 'compare: first pair='));
    await sleep(RECHECK_MS);
    r = await pass(d);
  }
  if (r.extra) log(r.extra);
  log(r.line);
  return EXIT[r.result];
}

const entry = process.argv[1];
if (entry) {
  let self = false;
  try { self = import.meta.url === pathToFileURL(realpathSync(entry)).href; } catch { self = false; }
  if (self) compareLights({ env: process.env }).then((code) => process.exit(code), () => process.exit(2));
}
