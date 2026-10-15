// S0.2 / V6. Contract: `node scripts/check-no-html.mjs` in cwd fails (exit 1) when any tracked
// .ts/.tsx under src/ or ingest/ contains dangerouslySetInnerHTML or .innerHTML.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeRepo, runScript, REPO_ROOT } from './_testlib.mjs';

const CHECK = join(REPO_ROOT, 'scripts', 'check-no-html.mjs');
const run = (files) => runScript(CHECK, makeRepo(files));
const bad1 = 'dangerously' + 'SetInnerHTML';
const bad2 = '.inner' + 'HTML';

describe('check-no-html (V6)', () => {
  it('passes clean sources', () => expect(run({ 'src/a.tsx': 'export const A = () => null;\n' }).status).toBe(0));
  it('fails dangerouslySetInnerHTML in src/', () =>
    expect(run({ 'src/a.tsx': `const p = { ${bad1}: { __html: 'x' } };\n` }).status).toBe(1));
  it('fails .innerHTML in ingest/', () =>
    expect(run({ 'ingest/a.ts': `el${bad2} = 'x';\n` }).status).toBe(1));
  it('ignores files outside src/ and ingest/', () =>
    expect(run({ 'scripts/a.ts': `el${bad2} = 'x';\n` }).status).toBe(0));
  it('passes the real repository', () => expect(runScript(CHECK, REPO_ROOT).status).toBe(0));
});
