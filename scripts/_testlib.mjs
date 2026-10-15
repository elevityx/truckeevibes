// Test helpers shared by the scripts/*.test.mjs files. Not a test file itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Create a temp git repo from { relativePath: content } and `git add` every file. */
export function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tv-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync('git', ['add', '-A', '-f'], { cwd: dir });
  return dir;
}

/**
 * Run a node script against cwd; returns { status, out }.
 * A missing script or an uncaught crash (stack trace) reports status 'missing' / 'crash', never 1,
 * so "must fail with exit 1" assertions cannot pass for the wrong reason.
 */
export function runScript(script, cwd, args = []) {
  if (!existsSync(script)) return { status: 'missing', out: `script not found: ${script}` };
  const r = spawnSync('node', [script, ...args], { cwd, encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status === 1 && /\n\s+at .*\(.*:\d+:\d+\)/.test(out)) return { status: 'crash', out };
  return { status: r.status, out };
}

export const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
