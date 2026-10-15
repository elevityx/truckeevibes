// Test helpers shared by the scripts/*.test.mjs files. Not a test file itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** No-reply identity assembled from fragments (the scanner scans this file too). */
export const NOREPLY = ['123+someone', '@users.noreply', '.github.com'].join('');
export const WEB_FLOW = ['noreply', '@github', '.com'].join('');

export function git(dir, args, env = {}) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

/** Empty temp repo with a no-reply identity configured. */
export function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tv-hist-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  git(dir, ['config', 'user.email', NOREPLY]);
  git(dir, ['config', 'user.name', 'someone']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

/**
 * Apply a step to a repo and commit it. files: { path: string | null } (null deletes);
 * links: { path: targetText }; renames: [[from, to]]. Returns the commit sha.
 */
export function commitStep(dir, { files = {}, links = {}, renames = [], message = 'step', authorEmail = NOREPLY, committerEmail = NOREPLY } = {}) {
  for (const [from, to] of renames) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    git(dir, ['mv', from, to]);
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    if (content === null) { rmSync(full, { force: true }); continue; }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const [rel, target] of Object.entries(links)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    symlinkSync(target, full);
  }
  git(dir, ['add', '-A', '-f']);
  git(dir, ['commit', '-q', '--allow-empty', '--no-verify', '-m', message], {
    GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_EMAIL: committerEmail,
  });
  return git(dir, ['rev-parse', 'HEAD']);
}
