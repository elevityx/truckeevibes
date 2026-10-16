// AC-R1b-10: the 700-event HTML budget. Run by `npm run test:budget` after it rebuilds out/ from .build/fixture/snapshot-700.json.
// The .budget.mjs suffix keeps `npm test` from picking it up without that build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const html = readFileSync('out/index.html', 'utf8');

test('AC-R1b-10 gzip(out/index.html) <= 102,400 bytes', () => {
  const n = gzipSync(html, { level: 6 }).length;
  console.log(`index.html: ${html.length} bytes, ${n} bytes gzipped`);
  assert.ok(n <= 102_400, `gzipped index.html is ${n} bytes (budget 102,400)`);
});

test('AC-R1b-10 the embedded rows are <= 300', () => {
  // Each embedded event row carries one "startsAt" key in the page's flight data.
  const embedded = (html.match(/startsAt/g) ?? []).length;
  const rendered = (html.match(/class="drow"/g) ?? []).length;
  console.log(`embedded rows: ${embedded}, rendered rows: ${rendered}`);
  assert.ok(embedded > 0, 'no rows embedded: was the 700-event fixture used?');
  assert.ok(embedded <= 300, `${embedded} rows embedded`);
  assert.ok(rendered <= 300, `${rendered} rows rendered`);
});
