// AC-M1-75 (a): the exported out/index.html must already contain the build snapshot's rows (no client fetch needed for first paint).
// Run via `npm run test:static`, which builds with scripts/fixtures/snapshot-static.json as public/data/events.json.
import { readFileSync } from 'node:fs';

const html = readFileSync('out/index.html', 'utf8');
let bad = 0;
if (!html.includes('SNAPSHOT-STATIC-SENTINEL')) {
  console.error('check-static-snapshot: out/index.html does not contain SNAPSHOT-STATIC-SENTINEL (the snapshot is not the first paint)');
  bad++;
}
if (html.includes('Loading events…')) {
  console.error('check-static-snapshot: out/index.html contains "Loading events…"');
  bad++;
}
if (bad) process.exit(1);
console.log('check-static-snapshot: ok');
