// Deterministic synthetic fixtures for the visual tests (V10: no real titles, venues or URLs, no network).
//   node scripts/fixtures/make-visual-fixture.mjs
// Writes scripts/fixtures/snapshot-visual.json and scripts/fixtures/event-pages-visual.json.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const BUILT_AT = '2026-10-15T13:04:00Z';
const ISO = (d, hhmm) => `${d}T${hhmm}:00.000Z`; // all times are UTC instants; Pacific is 7 hours behind in October

// [pacific date, start hour (24h Pacific), town, area, categories, age]
const CATS = ['arts', 'music', 'food-drink', 'nightlife', 'outdoors', 'learning', 'halloween-fall', 'sports', 'markets'];
const TOWNS = [['Truckee', 'truckee'], ['Incline Village', 'incline']];

// Counts the visual protocol needs: Today 1, This weekend 5, Next 7 days 9, Later 26 (35 events), last start Nov 11.
const DAY_PLAN = [
  '2026-10-15',
  '2026-10-17', '2026-10-17', '2026-10-18', '2026-10-18', '2026-10-18',
  '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22',
  '2026-10-23', '2026-10-24', '2026-10-24', '2026-10-25', '2026-10-25', '2026-10-25',
  '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-10-31', '2026-11-01',
  '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-07', '2026-11-08', '2026-11-08',
  '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-11',
];

const sourceNames = Array.from({ length: 14 }, (_, i) => `Example Source ${String.fromCharCode(65 + i)}`);
const LONG_TITLE = 'Example Harvest Supper with Live Music, Dancing and a Silent Auction'.padEnd(70, '!').slice(0, 70); // exactly 70 characters
const slug = (i) => `example-event-${String(i + 1).padStart(2, '0')}`;

const events = DAY_PLAN.map((date, i) => {
  const [town, area] = TOWNS[i % 3 === 0 ? 1 : 0];
  const cats = [CATS[i % CATS.length]];
  if (i % 2 === 0) cats.push('nightlife');
  if (i % 3 === 1 && !cats.includes('food-drink')) cats.push('food-drink');
  const start = 17 + (i % 4);
  const startUtc = new Date(Date.parse(`${date}T00:00:00Z`) + (start + 7) * 3600_000).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    slug: slug(i),
    title: i === 12 ? LONG_TITLE : `Example Event ${i + 1}`,
    summary: 'Synthetic fixture row.',
    startsAt: startUtc,
    endsAt: null,
    allDay: false,
    startDate: null,
    endDate: null,
    timeKnown: true,
    venue: `Example Venue ${(i % 6) + 1}`,
    address: `${i + 1} Example St, ${town}, CA 96161`,
    town,
    area,
    lat: null,
    lng: null,
    categories: [...new Set(cats)],
    priceKind: 'unknown',
    priceMin: null,
    priceMax: null,
    age: i === 3 || i === 20 ? '21_plus' : i === 9 ? '18_plus' : i === 6 ? 'all_ages' : 'all_ages',
    featured: false,
    url: `https://example.org/events/${i + 1}`,
    ticketUrl: null,
    sources: [sourceNames[i % 14]],
  };
});
// A weekly series: four Sunday occurrences with the same title and venue ("Also on").
for (const i of [5, 15, 22, 30]) Object.assign(events[i], { title: 'Example Sunday Market', venue: 'Example Plaza', town: 'Truckee', area: 'truckee' });
events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

const statuses = [...Array(4).fill('active'), ...Array(2).fill('paused'), ...Array(8).fill('link_only')];
const sources = statuses.map((status, i) => ({ name: sourceNames[i], homepageUrl: `https://www.example.org/calendars/${i + 1}/`, status }));

writeFileSync(join(DIR, 'snapshot-visual.json'), JSON.stringify({ builtAt: BUILT_AT, events, sources }, null, 1) + '\n');

const pages = events.map((e) => ({ slug: e.slug, pageState: 'upcoming' }));
writeFileSync(
  join(DIR, 'event-pages-visual.json'),
  JSON.stringify({ v: 1, pageTotal: pages.length, redirectTotal: 0, pageCapHit: false, redirectCapHit: false, pages, redirects: [] }) + '\n',
);
console.log(`visual fixture: ${events.length} events, ${sources.length} sources`);
