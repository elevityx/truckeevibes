// S0.2 / V10. Contract: `node scripts/check-fixtures.mjs` in cwd checks ingest/fixtures/**:
// each file <= 64 KB, total <= 2 MB, no .jpg/.png/.gif/.webp. Exit 1 on violation.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeRepo, runScript, REPO_ROOT } from './_testlib.mjs';

const CHECK = join(REPO_ROOT, 'scripts', 'check-fixtures.mjs');
const run = (files) => runScript(CHECK, makeRepo(files));
const kb = (n) => 'a'.repeat(n * 1024);

describe('check-fixtures (V10)', () => {
  it('passes small synthetic fixtures', () => expect(run({ 'ingest/fixtures/a.ics': kb(10) }).status).toBe(0));
  it('passes a file of exactly 64 KB', () => expect(run({ 'ingest/fixtures/a.ics': kb(64) }).status).toBe(0));
  it('fails a file over 64 KB', () => expect(run({ 'ingest/fixtures/a.ics': kb(65) }).status).toBe(1));
  it('fails when the total exceeds 2 MB', () => {
    const files = {};
    for (let i = 0; i < 33; i++) files[`ingest/fixtures/f${i}.json`] = kb(64);
    expect(run(files).status).toBe(1);
  });
  for (const ext of ['jpg', 'png', 'gif', 'webp']) {
    it(`fails a .${ext} file`, () => expect(run({ [`ingest/fixtures/pic.${ext}`]: 'x' }).status).toBe(1));
  }
  it('passes the real repository', () => expect(runScript(CHECK, REPO_ROOT).status).toBe(0));
});
