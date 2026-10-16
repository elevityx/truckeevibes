// Deterministic synthetic fixture for the HTML budget (V10: no real titles, venues or URLs, no network).
//   node scripts/fixtures/make-big-fixture.mjs --events 700 --seed 1
// Writes .build/fixture/snapshot-<n>.json and .build/fixture/event-pages-<n>.json (not committed; .build/ is git-ignored).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const N = arg('events', 700);
let seed = arg('seed', 1) >>> 0;
if (!Number.isInteger(N) || N < 1) throw new Error('--events must be a positive integer');

// mulberry32: small, deterministic.
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rand() * a.length)];

const BUILT_AT = '2026-10-15T13:04:00Z';
const DAYS = 45; // dense on purpose: more than 300 rows start inside the first-paint window
const CATS = ['arts', 'music', 'food-drink', 'nightlife', 'outdoors', 'learning', 'halloween-fall', 'sports', 'markets', 'community'];
const AREAS = [['Truckee', 'truckee'], ['Incline Village', 'incline_crystal_bay'], ['Tahoe City', 'tahoe_city_west_shore'], ['Kings Beach', 'kings_beach_north_shore']];
const A = ['Example', 'Sample', 'Mock'];
const B = ['Harvest', 'Lakeside', 'Summit', 'Evening', 'Morning', 'Trailhead', 'Community', 'Pine', 'River', 'Alpine', 'Quiet', 'Open'];
const C = ['Supper', 'Showcase', 'Workshop', 'Market', 'Concert', 'Social', 'Run', 'Tasting', 'Night', 'Class', 'Gathering', 'Jam'];
const sources = Array.from({ length: 14 }, (_, i) => `Example Source ${String.fromCharCode(65 + i)}`);
const AGES = ['unknown', 'unknown', 'unknown', 'all_ages', '21_plus', '18_plus'];

const events = Array.from({ length: N }, (_, i) => {
  const day = Math.floor(rand() * DAYS);
  const hour = 8 + Math.floor(rand() * 14); // 8 am - 9 pm Pacific
  const startUtc = new Date(Date.parse('2026-10-15T00:00:00Z') + day * 86_400_000 + (hour + 7) * 3_600_000 + Math.floor(rand() * 4) * 15 * 60_000);
  const [town, area] = pick(AREAS);
  const cats = [...new Set([pick(CATS), ...(rand() < 0.4 ? [pick(CATS)] : [])])];
  const title = `${pick(A)} ${pick(B)} ${pick(C)} ${i + 1}`;
  return {
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    slug: `example-event-${String(i + 1).padStart(3, '0')}`,
    title,
    summary: `Synthetic fixture row ${i + 1}, written to look like a one-line summary of an event.`,
    startsAt: startUtc.toISOString(),
    endsAt: rand() < 0.5 ? new Date(startUtc.getTime() + (1 + Math.floor(rand() * 3)) * 3_600_000).toISOString() : null,
    allDay: false, startDate: null, endDate: null, timeKnown: true,
    venue: `Example Venue ${1 + Math.floor(rand() * 30)} - Example Hall`,
    address: `${1 + Math.floor(rand() * 900)} Example St, ${town}, CA 96161`,
    town, area, lat: null, lng: null,
    categories: cats,
    priceKind: rand() < 0.2 ? 'free' : 'unknown', priceMin: null, priceMax: null,
    age: pick(AGES), featured: false,
    url: `https://example.org/events/${i + 1}`, ticketUrl: null,
    sources: [pick(sources)],
  };
}).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

const snapSources = sources.map((name, i) => ({ name, homepageUrl: `https://www.example.org/calendars/${i + 1}/`, status: i < 4 ? 'active' : i < 6 ? 'paused' : 'link_only' }));
const dir = join('.build', 'fixture');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `snapshot-${N}.json`), JSON.stringify({ builtAt: BUILT_AT, events, sources: snapSources }) + '\n');
const pages = events.map((e) => ({ slug: e.slug, pageState: 'upcoming' }));
writeFileSync(
  join(dir, `event-pages-${N}.json`),
  JSON.stringify({ v: 1, pageTotal: pages.length, redirectTotal: 0, pageCapHit: false, redirectCapHit: false, pages, redirects: [] }) + '\n',
);
console.log(`big fixture: ${events.length} events -> ${dir}`);
