// AC-M0-01 (layout/scripts/CI wiring), AC-M0-11 and AC-M0-12.
// AC-M0-11 reads the static export, so it is a BUILD-TIME check: run `npm run build` first (CI `web` job does).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const p = (...s) => join(REPO_ROOT, ...s);
const read = (...s) => readFileSync(p(...s), 'utf8');

describe('AC-M0-01 repo wiring', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const name of ['dev', 'build', 'lint', 'typecheck', 'test', 'test:functions', 'db:start', 'db:reset',
                      'db:test', 'ingest', 'check:repo']) {
    it(`package.json declares script ${name}`, () => expect(scripts).toHaveProperty(name));
  }
  it('check:repo chains the four repo checks', () => {
    for (const s of ['secret-scan', 'check-workflows', 'check-fixtures', 'check-no-html'])
      expect(scripts['check:repo']).toContain(s);
  });
  it('ci.yml exists with web and db jobs', () => {
    const ci = read('.github', 'workflows', 'ci.yml');
    expect(ci).toMatch(/^ {2}web:/m);
    expect(ci).toMatch(/^ {2}db:/m);
    expect(ci).not.toContain('pull_request_target');
  });
  it('supabase config uses the vibes project id', () =>
    expect(read('supabase', 'config.toml')).toContain('project_id = "truckeevibes"'));
  it('fixture rule README exists', () => expect(existsSync(p('ingest', 'fixtures', 'README.md'))).toBe(true));
});

describe('AC-M0-01 build output [build-time: needs `npm run build`]', () => {
  for (const f of ['index.html', 'bot/index.html', 'sources/index.html', 'about/index.html']) {
    it(`out/${f} exists`, () => expect(existsSync(p('out', f))).toBe(true));
  }
});

describe('AC-M0-11 /bot/ page content [build-time: needs `npm run build`]', () => {
  const needles = [
    'TruckeeVibesBot/1.0 (+https://truckeevibes.com/bot/)',
    'takedown@truckeevibes.com',
    '48 hours',
    'robots.txt',
    '1 request per second',
  ];
  for (const n of needles) {
    it(`out/bot/index.html contains "${n}"`, () => {
      const f = p('out', 'bot', 'index.html');
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f, 'utf8')).toContain(n);
    });
  }
});

describe('AC-M0-12 robots.txt', () => {
  it('disallows /admin/ and /feed/', () => {
    const f = p('public', 'robots.txt');
    expect(existsSync(f)).toBe(true);
    const t = readFileSync(f, 'utf8');
    expect(t).toContain('Disallow: /admin/');
    expect(t).toContain('Disallow: /feed/');
  });
});
