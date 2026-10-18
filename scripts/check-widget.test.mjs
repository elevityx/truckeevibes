// AC-W2-10 / AC-W2-11: each check-widget rule fails on a doctored manifest or file; the build is reproducible.
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { commitStep, initRepo, REPO_ROOT, runScript } from './_testlib.mjs';

const CHECK = join(REPO_ROOT, 'scripts', 'check-widget.mjs');
const VERSION = /WIDGET_VERSION = '([^']+)'/.exec(readFileSync(join(REPO_ROOT, 'widget/src/version.ts'), 'utf8'))[1];
const REL = `public/widget/v1/tv-events.${VERSION}.js`;
const sri = (buf) => `sha384-${createHash('sha384').update(buf).digest('base64')}`;
const temps = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temp git repo holding a copy of the committed public/widget/ as its base commit. */
function repo() {
  const dir = initRepo();
  temps.push(dir);
  cpSync(join(REPO_ROOT, 'public', 'widget'), join(dir, 'public', 'widget'), { recursive: true });
  commitStep(dir, { message: 'base' });
  return dir;
}
const manifest = (dir) => JSON.parse(readFileSync(join(dir, 'public/widget/manifest.json'), 'utf8'));
const writeManifest = (dir, m) => writeFileSync(join(dir, 'public/widget/manifest.json'), JSON.stringify(m, null, 2) + '\n');
const check = (dir) => runScript(CHECK, dir, ['--src', REPO_ROOT]);
/** Replace the current release file and keep its manifest hash in step, so only the rule under test trips. */
function swapRelease(dir, buf) {
  writeFileSync(join(dir, REL), buf);
  const m = manifest(dir);
  const e = m.versions.find((v) => v.version === VERSION);
  Object.assign(e, { integrity: sri(buf), bytes: buf.length, gzipBytes: gzipSync(buf, { level: 9 }).length });
  writeManifest(dir, m);
}

describe('check-widget', () => {
  it('passes the real repository and a clean copy', () => {
    expect(runScript(CHECK, REPO_ROOT)).toMatchObject({ status: 0 });
    const r = check(repo());
    expect(r.status, r.out).toBe(0);
  });

  it('rule 1: a manifest integrity that does not match the file fails', () => {
    const dir = repo();
    const m = manifest(dir);
    m.versions[0].integrity = 'sha384-' + 'A'.repeat(64);
    writeManifest(dir, m);
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rule1/);
  });

  it('rule 1: a manifest entry whose file is missing fails', () => {
    const dir = repo();
    const m = manifest(dir);
    m.versions.push({ ...m.versions[0], version: '0.9.0', file: '/widget/v1/tv-events.0.9.0.js' });
    writeManifest(dir, m);
    expect(check(dir).out).toMatch(/rule1/);
  });

  it('rule 2: a file under public/widget/v1/ that the manifest does not list fails', () => {
    const dir = repo();
    writeFileSync(join(dir, 'public/widget/v1/tv-events.0.9.0.js'), 'x');
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rule2/);
  });

  it('rule 3: a committed file that differs from a rebuild fails', () => {
    const dir = repo();
    swapRelease(dir, Buffer.concat([readFileSync(join(dir, REL)), Buffer.from('\n')]));
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rule3/);
    expect(r.out).not.toMatch(/rule1/);
  });

  it('rule 4: a release file with an HTML sink fails', () => {
    const dir = repo();
    swapRelease(dir, Buffer.concat([readFileSync(join(dir, REL)), Buffer.from(`;document.body.${['inner', 'HTML'].join('')}='x'`)]));
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rule4/);
  });

  it('rule 5: a release file over the gzip budget fails', () => {
    const dir = repo();
    const noise = Buffer.from(randomBytes(40000).toString('base64'));
    swapRelease(dir, Buffer.concat([readFileSync(join(dir, REL)), noise]));
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rule5/);
  });

  it('rule 6: deleting an old release file and its manifest entry together fails against the base', () => {
    const dir = repo();
    const m = manifest(dir);
    m.versions = m.versions.filter((v) => v.version !== VERSION);
    commitStep(dir, { files: { [REL]: null, 'public/widget/manifest.json': JSON.stringify(m, null, 2) + '\n' }, message: 'drop 1.0.0' });
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rule6/);
  });

  it('rule 6: changing a released integrity fails against the base', () => {
    const dir = repo();
    const m = manifest(dir);
    m.versions[0].integrity = 'sha384-' + 'B'.repeat(64);
    commitStep(dir, { files: { 'public/widget/manifest.json': JSON.stringify(m, null, 2) + '\n' }, message: 'edit' });
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/rule6/);
  });

  it('rule 6 is skipped with a log line when the base has no manifest', () => {
    const dir = initRepo();
    temps.push(dir);
    commitStep(dir, { files: { 'README.md': 'x\n' }, message: 'base' });
    cpSync(join(REPO_ROOT, 'public', 'widget'), join(dir, 'public', 'widget'), { recursive: true });
    commitStep(dir, { message: 'first release' });
    const r = check(dir);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/rule6: skipped/);
  });
});

describe('AC-W2-11 build', () => {
  it('widget:build twice gives a byte-identical file, the manifest entry is committed, and the budget holds', () => {
    const before = readFileSync(join(REPO_ROOT, REL));
    for (let i = 0; i < 2; i++) {
      const r = runScript(join(REPO_ROOT, 'widget', 'build.mjs'), REPO_ROOT);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/js_gz=\d+ css_gz=\d+ total_gz=\d+/);
      const [, js, , total] = /js_gz=(\d+) css_gz=(\d+) total_gz=(\d+)/.exec(r.out).map(Number);
      expect(total).toBeLessThanOrEqual(33792);
      expect(js).toBeLessThanOrEqual(25600);
      expect(readFileSync(join(REPO_ROOT, REL)).equals(before)).toBe(true);
    }
    const e = manifest(REPO_ROOT).versions.find((v) => v.version === VERSION);
    expect(e).toEqual({ version: VERSION, file: `/widget/v1/tv-events.${VERSION}.js`, integrity: sri(before), bytes: before.length, gzipBytes: expect.any(Number) });
  });

  it('refuses to overwrite a released file with different bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-wb-'));
    temps.push(dir);
    cpSync(join(REPO_ROOT, 'public', 'widget'), join(dir, 'public', 'widget'), { recursive: true });
    writeFileSync(join(dir, REL), 'changed');
    const r = runScript(join(REPO_ROOT, 'widget', 'build.mjs'), REPO_ROOT, ['--out', join(dir, 'public', 'widget')]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/immutable: bump WIDGET_VERSION/);
  });
});
