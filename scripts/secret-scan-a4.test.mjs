// AC-M0-15 and AC-M0-21 (Amendments 4 and 4.1). Samples are assembled from fragments at runtime.
// Contract: index-blob scan, fail-closed reader, case-insensitive email rule, `--range` commit metadata scan
// (scanCommits) and historical-blob scan (scanRangeBlobs), `--no-files`, `range_unresolved`.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitStep, git, initRepo, makeRepo, runScript, NOREPLY, WEB_FLOW, REPO_ROOT } from './_testlib.mjs';

const SCAN = join(REPO_ROOT, 'scripts', 'secret-scan.mjs');
const x = (n) => 'x'.repeat(n);
const JWT = ['ey' + 'J' + x(12), 'ey' + 'J' + x(12), x(10)].join('.');
const KEY = ['sb', 'secret', x(20)].join('_');
const PERSONAL = 'someone@' + 'gmail' + '.com';
const PERSONAL_UP = 'someone@' + 'GMAIL' + '.COM';
const CORP = 'dev@' + 'corp.example' + '.org';
const range = (a, b) => ['--no-files', '--range', `${a}..${b}`];

/** Remove the loose object for a blob so the reader cannot find it. */
function dropObject(dir, oid) {
  rmSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
}

describe('secret-scan index scan (AC-M0-15 a-d)', () => {
  it('(a) a tracked symlink is a hit "tracked-symlink" and its target text is never printed', () => {
    const dir = makeRepo({ 'ok.txt': 'fine\n' });
    symlinkSync(KEY, join(dir, 'link'));
    git(dir, ['add', '-f', 'link']);
    const { status, out } = runScript(SCAN, dir);
    expect(status).toBe(1);
    expect(out).toMatch(/link:0 tracked-symlink/);
    expect(out).not.toContain(KEY);
  });

  it('(b) reads the index blob: a JWT staged then deleted from disk is still a hit', () => {
    const dir = makeRepo({ 'src/a.ts': `const t = '${JWT}';\n` });
    unlinkSync(join(dir, 'src', 'a.ts'));
    const { status, out } = runScript(SCAN, dir);
    expect(status).toBe(1);
    expect(out).toMatch(/src\/a\.ts:1 jwt/);
    expect(out).not.toContain(JWT);
  });

  it('(c) an index entry whose object is missing is "unreadable", never silently skipped', () => {
    const dir = makeRepo({ 'src/a.ts': `const t = '${JWT}';\n`, 'ok.txt': 'fine\n' });
    dropObject(dir, git(dir, ['rev-parse', ':src/a.ts']));
    const { status, out } = runScript(SCAN, dir);
    expect(status).toBe(1);
    expect(out).toMatch(/src\/a\.ts:0 unreadable/);
  });

  it('(d) personal-email is case-insensitive', () => {
    const { status, out } = runScript(SCAN, makeRepo({ 'a.ts': `// ${PERSONAL_UP}\n` }));
    expect(status).toBe(1);
    expect(out).toMatch(/a\.ts:1 personal-email/);
    expect(out).not.toContain(PERSONAL_UP);
  });

  it('a gitlink (submodule) entry is a hit "tracked-submodule"', () => {
    const dir = makeRepo({ 'ok.txt': 'fine\n' });
    commitStep(dir, { message: 'base' });
    const head = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`]);
    const { status, out } = runScript(SCAN, dir);
    expect(status).toBe(1);
    expect(out).toMatch(/vendor\/sub:0 tracked-submodule/);
  });

  it('an unmerged (stage != 0) entry is a hit "unmerged"', () => {
    const dir = makeRepo({ 'ok.txt': 'fine\n' });
    const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'plain\n', encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: dir,
      input: `0 ${'0'.repeat(40)}\tconflict.txt\n100644 ${oid} 2\tconflict.txt\n100644 ${oid} 3\tconflict.txt\n`,
    });
    const { status, out } = runScript(SCAN, dir);
    expect(status).toBe(1);
    expect(out).toMatch(/conflict\.txt:\d+ unmerged/);
  });

  it('EXCLUDED_FILES still applies to the index blob (package-lock.json removed from disk, key inside)', () => {
    const dir = makeRepo({ 'package-lock.json': `{"x":"${KEY}"}\n` });
    unlinkSync(join(dir, 'package-lock.json'));
    expect(runScript(SCAN, dir).status).toBe(0);
  });

  it('a binary blob (NUL in the first 8000 bytes) is skipped', () => {
    const dir = makeRepo({ 'b.bin': `\0${KEY}\n` });
    expect(runScript(SCAN, dir).status).toBe(0);
  });

  it('fails closed with exit 2 and "secret-scan: error" outside a git repo (no silent catch)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-nogit-'));
    const { status, out } = runScript(SCAN, dir);
    expect(status).toBe(2);
    expect(out).toMatch(/secret-scan: error/);
  });
});

describe('secret-scan commit metadata (AC-M0-15 e-j)', () => {
  const twoCommits = (second) => {
    const dir = initRepo();
    const base = commitStep(dir, { files: { 'a.txt': 'one\n' }, message: 'base' });
    commitStep(dir, { files: { 'b.txt': 'two\n' }, ...second });
    return { dir, base };
  };

  it('(e) personal author and committer: hits author/committer commit-identity, address never printed', () => {
    const { dir, base } = twoCommits({ message: 'x', authorEmail: PERSONAL, committerEmail: PERSONAL });
    const sha7 = git(dir, ['rev-parse', '--short=7', 'HEAD']);
    const { status, out } = runScript(SCAN, dir, range(base, 'HEAD'));
    expect(status).toBe(1);
    expect(out).toContain(`commit:${sha7}:author commit-identity`);
    expect(out).toContain(`commit:${sha7}:committer commit-identity`);
    expect(out.toLowerCase()).not.toContain(PERSONAL);
  });

  it('(f) a corporate non-no-reply address fails commit-identity', () => {
    const { dir, base } = twoCommits({ message: 'x', authorEmail: CORP, committerEmail: NOREPLY });
    const { status, out } = runScript(SCAN, dir, range(base, 'HEAD'));
    expect(status).toBe(1);
    expect(out).toMatch(/:author commit-identity/);
    expect(out).not.toContain(CORP);
  });

  it('(g) a message containing a personal address hits commit:<sha7>:message personal-email', () => {
    const { dir, base } = twoCommits({ message: `contact ${PERSONAL}` });
    const sha7 = git(dir, ['rev-parse', '--short=7', 'HEAD']);
    const { status, out } = runScript(SCAN, dir, range(base, 'HEAD'));
    expect(status).toBe(1);
    expect(out).toContain(`commit:${sha7}:message personal-email`);
    expect(out).not.toContain(PERSONAL);
  });

  it('(h) no-reply author with the web-flow committer passes', () => {
    const { dir, base } = twoCommits({ message: 'merge', authorEmail: NOREPLY, committerEmail: WEB_FLOW });
    expect(runScript(SCAN, dir, range(base, 'HEAD')).status).toBe(0);
  });

  it('(i) an unresolvable range exits 1 with range_unresolved', () => {
    const { dir } = twoCommits({ message: 'x' });
    const { status, out } = runScript(SCAN, dir, ['--no-files', '--range', 'nope..HEAD']);
    expect(status).toBe(1);
    expect(out).toContain('range_unresolved');
  });

  it('(j) no origin/main and no --range: prints "commit metadata skipped" and still scans files', () => {
    const dir = initRepo();
    commitStep(dir, { files: { 'a.ts': `const k = '${KEY}';\n` }, authorEmail: PERSONAL });
    const { status, out } = runScript(SCAN, dir);
    expect(out).toContain('commit metadata skipped');
    expect(status).toBe(1);
    expect(out).toMatch(/a\.ts:1 sb-secret/);
    expect(out).not.toMatch(/commit-identity/);
  });

  it('--no-files skips the head-index scan', () => {
    const dir = initRepo();
    const base = commitStep(dir, { files: { 'a.txt': 'x\n' } });
    commitStep(dir, { files: { 'b.txt': 'y\n' } });
    git(dir, ['rm', '-q', '--cached', 'b.txt']);
    writeFileSync(join(dir, 'c.ts'), `${KEY}\n`);
    git(dir, ['add', 'c.ts']);
    expect(runScript(SCAN, dir, range(base, 'HEAD')).status).toBe(0);
  });

  it('exports scanCommits and flags a personal committer', async () => {
    const mod = await import(SCAN);
    const { dir, base } = twoCommits({ message: 'x', committerEmail: PERSONAL });
    const hits = mod.scanCommits(dir, `${base}..HEAD`);
    expect(hits.some((h) => h.rule === 'commit-identity')).toBe(true);
  });

  it('real repo after the rewrite: --no-files --range 0dd6f71..HEAD exits 0', () => {
    let have = true;
    try { git(REPO_ROOT, ['rev-parse', '--verify', '0dd6f71^{commit}']); } catch { have = false; }
    if (!have) return;
    const { status, out } = runScript(SCAN, REPO_ROOT, range('0dd6f71', 'HEAD'));
    expect(out).toMatch(/secret-scan/);
    expect(status).toBe(0);
  });
});

describe('secret-scan historical blobs (AC-M0-21)', () => {
  const start = () => {
    const dir = initRepo();
    const base = commitStep(dir, { files: { 'README.md': 'hi\n' }, message: 'base' });
    return { dir, base };
  };

  it('add-then-delete a JWT: head scan clean, range scan hits <sha7 of A>:src/k.ts:<line> jwt without the token', () => {
    const { dir, base } = start();
    const a = commitStep(dir, { files: { 'src/k.ts': `// c\nconst t = '${JWT}';\n` }, message: 'add' });
    const b = commitStep(dir, { files: { 'src/k.ts': null }, message: 'remove' });
    expect(runScript(SCAN, dir).status).toBe(0);
    const { status, out } = runScript(SCAN, dir, range(base, b));
    expect(status).toBe(1);
    expect(out).toContain(`${a.slice(0, 7)}:src/k.ts:2 jwt`);
    expect(out).not.toContain(JWT);
  });

  it('add-then-remove a symlink is tracked-symlink', () => {
    const { dir, base } = start();
    commitStep(dir, { links: { 'ln': 'target' } });
    const b = commitStep(dir, { files: { ln: null } });
    const { status, out } = runScript(SCAN, dir, range(base, b));
    expect(status).toBe(1);
    expect(out).toMatch(/:ln:0 tracked-symlink/);
  });

  it('a personal address added in A and edited out in B is reported on A\'s blob', () => {
    const { dir, base } = start();
    const a = commitStep(dir, { files: { 'n.txt': `mail ${PERSONAL}\n` } });
    const b = commitStep(dir, { files: { 'n.txt': 'mail removed\n' } });
    const { status, out } = runScript(SCAN, dir, range(base, b));
    expect(status).toBe(1);
    expect(out).toContain(`${a.slice(0, 7)}:n.txt:1 personal-email`);
    expect(out).not.toContain(PERSONAL);
  });

  it('an added-then-deleted .env.local is tracked-env', () => {
    const { dir, base } = start();
    commitStep(dir, { files: { '.env.local': 'FOO=bar\n' } });
    const b = commitStep(dir, { files: { '.env.local': null } });
    const { status, out } = runScript(SCAN, dir, range(base, b));
    expect(status).toBe(1);
    expect(out).toMatch(/:\.env\.local:1 tracked-env/);
  });

  it('a merge commit whose second parent added the secret is caught', () => {
    const { dir, base } = start();
    git(dir, ['checkout', '-q', '-b', 'side']);
    commitStep(dir, { files: { 'side.ts': `const k = '${KEY}';\n` } });
    git(dir, ['checkout', '-q', 'main']);
    commitStep(dir, { files: { 'main.txt': 'm\n' } });
    git(dir, ['merge', '--no-ff', '-q', '-m', 'merge', 'side'], { GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_EMAIL: NOREPLY });
    commitStep(dir, { files: { 'side.ts': null } }); // head is clean; only history holds the secret
    const { status, out } = runScript(SCAN, dir, range(base, 'HEAD'));
    expect(status).toBe(1);
    expect(out).toMatch(/side\.ts:1 sb-secret/);
  });

  it('a rename into the range is seen as an add (--no-renames)', () => {
    const { dir } = start();
    const a = commitStep(dir, { files: { 'a.ts': `const k = '${KEY}';\n` } });
    commitStep(dir, { renames: [['a.ts', 'moved/b.ts']] });
    const c = commitStep(dir, { files: { 'moved/b.ts': null } }); // head is clean
    const { status, out } = runScript(SCAN, dir, range(a, c));
    expect(status).toBe(1);
    expect(out).toMatch(/moved\/b\.ts:1 sb-secret/);
  });

  it('the same blob in two commits is reported once', () => {
    const { dir, base } = start();
    commitStep(dir, { files: { 'one.ts': `const k = '${KEY}';\n` } });
    const b = commitStep(dir, { files: { 'two.ts': `const k = '${KEY}';\n` } });
    const { out } = runScript(SCAN, dir, range(base, b));
    expect(out.split('\n').filter((l) => /sb-secret/.test(l))).toHaveLength(1);
  });

  it('a range blob whose object is missing is "unreadable" (exit 1)', () => {
    const { dir, base } = start();
    const a = commitStep(dir, { files: { 'src/k.ts': `const t = '${JWT}';\n` } });
    const oid = git(dir, ['rev-parse', `${a}:src/k.ts`]);
    const b = commitStep(dir, { files: { 'src/k.ts': null } });
    dropObject(dir, oid);
    const { status, out } = runScript(SCAN, dir, range(base, b));
    expect(status).toBe(1);
    expect(out).toMatch(/src\/k\.ts:0 unreadable/);
  });

  it('EXCLUDED_FILES applies to range blobs (package-lock.json with a key)', () => {
    const { dir, base } = start();
    const a = commitStep(dir, { files: { 'package-lock.json': `{"x":"${KEY}"}\n` } });
    expect(runScript(SCAN, dir, range(base, a)).status).toBe(0);
  });

  it('a clean range exits 0', () => {
    const { dir, base } = start();
    const a = commitStep(dir, { files: { 'ok.ts': 'export {};\n' } });
    expect(runScript(SCAN, dir, range(base, a)).status).toBe(0);
  });

  it('exports scanRangeBlobs returning hits for historical blobs', async () => {
    const mod = await import(SCAN);
    const { dir, base } = start();
    commitStep(dir, { files: { 'k.ts': `${KEY}\n` } });
    const b = commitStep(dir, { files: { 'k.ts': null } });
    const hits = mod.scanRangeBlobs(dir, `${base}..${b}`);
    expect(hits.map((h) => h.rule)).toContain('sb-secret');
  });
});
