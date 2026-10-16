// R4a parity checks: the notice cases SSOT is mirrored in pgTAP 21, and the SQL reason-code list matches the TS twin once R4b adds it.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const CASES = JSON.parse(readFileSync(join(REPO_ROOT, 'ingest', 'core', 'notices.cases.json'), 'utf8'));
const PGTAP = readFileSync(join(REPO_ROOT, 'supabase', 'tests', '21_tags_notices.test.sql'), 'utf8');
const MIG_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const MIG = readFileSync(join(MIG_DIR, readdirSync(MIG_DIR).find((f) => f.endsWith('_tags_notices.sql'))), 'utf8');

describe('notices.cases.json is the SSOT for the notice parity table', () => {
  it('has 26 rows (8 notices), with a sibling column and unique title+sibling pairs', () => {
    expect(CASES.length).toBe(26);
    expect(CASES.filter((c) => c.notice).length).toBe(8);
    expect(new Set(CASES.map((c) => `${c.title}|${c.sibling}`)).size).toBe(26);
    for (const c of CASES) { expect(typeof c.notice).toBe('boolean'); expect(typeof c.sibling).toBe('string'); }
    expect(CASES.filter((c) => c.sibling).map((c) => c.title).sort()).toEqual(['NO Country Fridays Tonight', 'No Trivia Today']);
  });
  it('every row appears in 21_tags_notices.test.sql as (\'<title>\', \'<sibling>\', <bool>)', () => {
    for (const c of CASES) expect(PGTAP, c.title).toContain(`('${c.title.replace(/'/g, "''")}', '${c.sibling.replace(/'/g, "''")}', ${c.notice})`);
  });
});

describe('reason-code vocabulary', () => {
  const sqlCodes = [...(/array\[([\s\S]*?)\]::text\[\]/.exec(MIG.split('create function private.valid_reason_code')[1])[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  it('the SQL list has the 22 distinct codes, all matching the shape check', () => {
    expect(sqlCodes.length).toBe(22);
    expect(new Set(sqlCodes).size).toBe(22);
    for (const c of sqlCodes) expect(c).toMatch(/^[a-z0-9_:]{1,40}$/);
  });
  it('the pgTAP list equals the SQL list, in order', () => {
    const block = /unnest\(array\[([\s\S]*?)\]\) with ordinality/.exec(PGTAP)[1];
    expect([...block.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(sqlCodes);
  });
  // REASON_CODES (ingest/core/reasonCodes.ts) is created by R4b; the twin comparison activates the moment that file exists.
  const ts = join(REPO_ROOT, 'ingest', 'core', 'reasonCodes.ts');
  it.skipIf(!existsSync(ts))('REASON_CODES equals the SQL list, in order', () => {
    const src = readFileSync(ts, 'utf8');
    const arr = /REASON_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src)[1];
    expect([...arr.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(sqlCodes);
  });
});
