// Parity checks: the notice cases SSOT is mirrored in pgTAP 21 (rows without offsets) and pgTAP 23 (rows with offsets), and the SQL
// reason-code list matches the TS twin `ingest/core/reasonCodes.ts`. Loud: a missing twin fails, it never skips.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const CASES = JSON.parse(readFileSync(join(REPO_ROOT, 'ingest', 'core', 'notices.cases.json'), 'utf8'));
const PGTAP = readFileSync(join(REPO_ROOT, 'supabase', 'tests', '21_tags_notices.test.sql'), 'utf8');
const MIG_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const MIG = readFileSync(join(MIG_DIR, readdirSync(MIG_DIR).find((f) => f.endsWith('_tags_notices.sql'))), 'utf8');

const sq = (v) => String(v).replace(/'/g, "''");
const key = (c) => `${c.title}|${c.sibling}|${c.offsets ? c.offsets.join(',') : ''}`;
const WITH = CASES.filter((c) => c.offsets);
const WITHOUT = CASES.filter((c) => !c.offsets);
// pgTAP 23 (R4c, `23_notice_series.test.sql`) lists the rows with offsets as ('<title>', '<sibling>', '{<o1>,<o2>}', <bool>).
const SERIES = join(REPO_ROOT, 'supabase', 'tests', '23_notice_series.test.sql');

describe('notices.cases.json is the SSOT for the notice parity table', () => {
  it('has 31 rows (10 notices), a sibling column, optional offsets, and unique title|sibling|offsets keys', () => {
    expect(CASES.length).toBe(31);
    expect(CASES.filter((c) => c.notice).length).toBe(10);
    expect(new Set(CASES.map(key)).size).toBe(31);
    for (const c of CASES) {
      expect(typeof c.notice).toBe('boolean');
      expect(typeof c.sibling).toBe('string');
      if (c.offsets) { expect(c.sibling).not.toBe(''); expect(c.offsets.length).toBeGreaterThan(0); for (const o of c.offsets) expect(Number.isInteger(o)).toBe(true); }
    }
    expect(WITH.length).toBe(5);
    expect(CASES.filter((c) => c.sibling).length).toBe(7);
    expect([...new Set(CASES.filter((c) => c.sibling).map((c) => c.title))].sort()).toEqual(['NO Country Fridays Tonight', 'No Trivia Today']);
  });
  it('every row without offsets appears in 21_tags_notices.test.sql as (\'<title>\', \'<sibling>\', <bool>)', () => {
    for (const c of WITHOUT) expect(PGTAP, c.title).toContain(`('${sq(c.title)}', '${sq(c.sibling)}', ${c.notice})`);
  });
  // Unconditional (R4b-2 addendum to AC-R4c-08): a missing 23_notice_series.test.sql makes readFileSync throw, so this fails, never skips.
  it('every row with offsets appears in 23_notice_series.test.sql as (\'<title>\', \'<sibling>\', \'{<o1>,<o2>}\', <bool>)', () => {
    expect(WITH.length).toBe(5);
    const sql = readFileSync(SERIES, 'utf8');
    for (const c of WITH) expect(sql, key(c)).toContain(`('${sq(c.title)}', '${sq(c.sibling)}', '{${c.offsets.join(',')}}', ${c.notice})`);
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
  // Loud (R4a-1 P2-3): a missing ingest/core/reasonCodes.ts makes this fail (readFileSync throws), never skip.
  const ts = join(REPO_ROOT, 'ingest', 'core', 'reasonCodes.ts');
  it('REASON_CODES equals the SQL list, in order', () => {
    const src = readFileSync(ts, 'utf8');
    const arr = /REASON_CODES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src)[1];
    expect([...arr.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(sqlCodes);
  });
});
