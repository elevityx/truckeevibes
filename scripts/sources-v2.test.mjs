// Spec_Sources_V2 §11 static checks. AC-SV2-36 (the dispatch token is named only where allowed; no build step dumps the environment),
// AC-SV2-27 static half (the admin Functions send no CORS header) and AC-SV2-35 static half (the console wires the Jobs tab).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const p = (...s) => join(REPO_ROOT, ...s);
const read = (rel) => readFileSync(p(rel), 'utf8');
const TOKEN = 'GITHUB_DISPATCH_TOKEN';
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz)$/i;
const tracked = () => execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

// The only places the token's name may appear (§11 check 1).
const ALLOWED = [
  /^AGENTS\.md$/,
  /^functions\/_lib\/types\.ts$/,
  /^functions\/api\/admin\/dispatch\.ts$/,
  /^functions\/api\/admin\/dispatch-status\.ts$/,
  /^functions\/api\/admin\/[^/]+\.test\.ts$/,
  /^src\/components\/admin\/runNow\.ts$/,
  /^src\/components\/admin\/runNow\.test\.ts$/,
  /^scripts\/sources-v2\.test\.mjs$/,
];
// Files that must name it once implemented (so this check cannot pass on a tree without the feature).
const REQUIRED = [
  'AGENTS.md', 'functions/_lib/types.ts', 'functions/api/admin/dispatch.ts', 'functions/api/admin/dispatch-status.ts',
  'src/components/admin/runNow.ts',
];

describe('Sources V2 static checks (Spec_Sources_V2 §11)', () => {
  it('1. GITHUB_DISPATCH_TOKEN appears only in the allowed files, and in each required one (AC-SV2-36)', () => {
    const hits = tracked().filter((f) => !BINARY.test(f) && existsSync(p(f)) && read(f).includes(TOKEN));
    const stray = hits.filter((f) => !ALLOWED.some((re) => re.test(f)));
    expect(stray, 'token named outside the §11 allowlist').toEqual([]);
    for (const f of hits) expect(f).not.toMatch(/^(\.github|ingest|supabase|src\/lib)\//);
    for (const f of REQUIRED) {
      expect(existsSync(p(f)), `${f} exists`).toBe(true);
      expect(read(f).includes(TOKEN), `${f} names ${TOKEN}`).toBe(true);
    }
    // runNow.ts names it only in the setup note text.
    const rn = read('src/components/admin/runNow.ts').split('\n').filter((l) => l.includes(TOKEN));
    for (const l of rn) expect(l).toMatch(/SETUP_NOTE|Run now needs setup|GitHub token \(GITHUB_DISPATCH_TOKEN\)/);
  });

  it('2. no build-path file dumps process.env (AC-SV2-36, plan §6)', () => {
    const DUMP = /JSON\.stringify\(\s*process\.env|Object\.(entries|keys|values)\(\s*process\.env|console\.\w+\(\s*process\.env/;
    const files = tracked().filter((f) =>
      (f.startsWith('src/') && /\.(ts|tsx|js|jsx|mjs)$/.test(f) && !/\.test\.(ts|tsx|mjs)$/.test(f))
      || ['next.config.ts', 'scripts/build-snapshot.ts', 'scripts/snapshot-sources.ts'].includes(f));
    expect(files).toContain('next.config.ts');
    expect(files).toContain('scripts/build-snapshot.ts');
    expect(files).toContain('scripts/snapshot-sources.ts');
    expect(files.filter((f) => existsSync(p(f)) && DUMP.test(read(f)))).toEqual([]);
  });

  it('3. the admin Functions exist and send no access-control-* header (AC-SV2-27)', () => {
    const dir = 'functions/api/admin';
    for (const f of ['dispatch.ts', 'dispatch-status.ts']) expect(existsSync(p(dir, f)), `${dir}/${f} exists`).toBe(true);
    const src = readdirSync(p(dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const f of src) expect(read(`${dir}/${f}`).toLowerCase(), f).not.toContain('access-control-');
  });

  it('4. Console.tsx wires the Jobs tab (AC-SV2-35, static half)', () => {
    const c = read('src/components/admin/Console.tsx');
    expect(c).toContain('id="tab-jobs"');
    expect(c).toContain('aria-controls="pane-jobs"');
    expect(c).toContain('<JobsTab');
  });
});
