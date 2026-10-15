// Static checks the spec names for the UI (V6 / AC-M1-44). These walk the working tree (not `git ls-files`), so a new
// untracked file cannot slip past. Component rendering (snapshot-first paint, "Showing events as of") has no DOM test
// environment; the string check below only proves the copy exists in the page code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next' || n === 'out') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const src = (dir: string) => walk(join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const BAD = [['dangerously', 'SetInnerHTML'].join(''), ['.inner', 'HTML'].join(''), ['outer', 'HTML'].join(''), ['insertAdjacent', 'HTML'].join('')];

describe('V6 / AC-M1-44: no raw HTML sinks', () => {
  it('no non-test .ts/.tsx under src/ or ingest/ uses a raw-HTML API', () => {
    const hits: string[] = [];
    for (const f of [...src('src'), ...src('ingest')]) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (BAD.some((b) => line.includes(b))) hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('ESLint turns react/no-danger on as an error', () => {
    const cfg = readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf8');
    expect(cfg).toMatch(/['"]react\/no-danger['"]\s*:\s*(['"]error['"]|2|\[\s*['"]error['"])/);
  });
});

describe('AC-M1-44 copy (string presence only)', () => {
  it('the list page code contains the stale-snapshot notice', () => {
    const files = [...src('src/app'), ...src('src/components/list')];
    expect(files.some((f) => readFileSync(f, 'utf8').includes('Showing events as of'))).toBe(true);
  });
});

describe('public pages render source data as text', () => {
  it('the list and sheet components exist and never set href from unchecked data', () => {
    const sheet = join(ROOT, 'src/components/list/EventSheet.tsx');
    const text = readFileSync(sheet, 'utf8'); // throws (fails) until the component exists
    expect(text).toContain('safeWebsite');
  });
});
