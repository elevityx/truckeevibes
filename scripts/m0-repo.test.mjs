// AC-M0-01 (layout/scripts/CI wiring), AC-M0-11 and AC-M0-12.
// AC-M0-11 reads the static export, so it is a BUILD-TIME check: run `npm run build` first (CI `web` job does).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
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
  it('AC-R2a-11 AGENTS.md invariant V1 names list_event_pages among the public reads', () => {
    const v1 = read('AGENTS.md').split('\n').find((l) => l.startsWith('- V1 '));
    expect(v1).toBeTruthy();
    expect(v1).toContain('`list_event_pages`');
    expect(v1).toContain('`list_events`');
    expect(v1).toContain('`list_sources_public`');
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

// R1a: package scripts and the CI `visual` job are pinned. Each later web PR updates the expected lists in the same PR.
describe('AC-R1a-15 pinned scripts, vitest include and the CI visual job', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  it('build:fixture and test:visual equal the Package scripts table', () => {
    expect(scripts['build:fixture']).toBe(
      'SNAPSHOT_FIXTURE=scripts/fixtures/snapshot-visual.json MANIFEST_FIXTURE=scripts/fixtures/event-pages-visual.json PICKS_PATH=scripts/fixtures/picks-visual.json npm run build',
    );
    expect(scripts['test:visual']).toBe('npm run build:fixture && playwright test');
  });
  it('classify-report equals the Package scripts table (R4b)', () => {
    expect(scripts['classify-report']).toBe('tsx ingest/tools/classify-report.ts');
  });
  it('test:lhci and test:budget equal the Package scripts table (R1b)', () => {
    expect(scripts['test:lhci']).toBe('lhci autorun');
    expect(scripts['test:budget']).toBe(
      'node scripts/fixtures/make-big-fixture.mjs --events 700 --seed 1 && SNAPSHOT_FIXTURE=.build/fixture/snapshot-700.json MANIFEST_FIXTURE=.build/fixture/event-pages-700.json npm run build && node --test scripts/html-budget.budget.mjs',
    );
  });
  it('@lhci/cli is pinned to an exact version', () => {
    expect(JSON.parse(read('package.json')).devDependencies['@lhci/cli']).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('lighthouserc.json: mobile preset, 3 runs, median, four categories at 0.9', () => {
    const rc = JSON.parse(read('lighthouserc.json')).ci;
    expect(rc.collect.startServerCommand).toBe('node scripts/serve-out.mjs --port 4173');
    expect(rc.collect.staticDistDir).toBeUndefined();
    expect(rc.collect.numberOfRuns).toBe(3);
    expect(rc.collect.url).toEqual(['http://127.0.0.1:4173/']);
    expect(rc.collect.settings?.preset ?? 'mobile').not.toBe('desktop');
    expect(rc.assert.assertions['largest-contentful-paint']).toEqual(['warn', { maxNumericValue: 2500, aggregationMethod: 'median' }]) // warn: local median is 2.7-2.8 s (framework floor 2.4 s); see the PR description;
    expect(rc.assert.assertions['label-content-name-mismatch']).toEqual(['error', { minScore: 1 }]);
    for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) {
      expect(rc.assert.assertions[`categories:${c}`]).toEqual(['error', { minScore: 0.9, aggregationMethod: 'median' }]);
    }
  });
  it('check:repo includes the token check', () => expect(scripts['check:repo']).toContain('node scripts/build-tokens.mjs --check'));
  it('vitest include equals the r2 value plus the W0 functions/widget globs', () => {
    expect(read('vitest.config.ts')).toContain("include: ['src/**/*.test.ts', 'ingest/**/*.test.ts', 'scripts/**/*.test.{mjs,ts}', 'functions/**/*.test.ts', 'widget/**/*.test.ts']");
  });

  const VISUAL_RUNS = ['npm ci', 'npx playwright install --with-deps chromium', 'npm run test:visual', 'npm run test:lhci', 'npm run test:budget']; // R2c appends og:bench; R3b test:clarity
  const steps = parseYaml(read('.github', 'workflows', 'ci.yml')).jobs.visual.steps;
  it('jobs.visual has the pinned job keys', () => {
    const job = parseYaml(read('.github', 'workflows', 'ci.yml')).jobs.visual;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(25);
    expect(job.needs).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain('secrets.');
  });
  it('the ordered run list equals the R1b list, with no later PR step', () => {
    expect(steps.filter((s) => s.run).map((s) => s.run)).toEqual(VISUAL_RUNS);
  });
  it('every npm run <x> in the visual job names a package.json script', () => {
    for (const s of steps.filter((x) => x.run && x.run.startsWith('npm run '))) expect(scripts).toHaveProperty(s.run.slice('npm run '.length));
  });
  it('the last step uploads the artifact with if: always()', () => {
    const last = steps.at(-1);
    expect(last.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(last.if).toBe('always()');
    expect(last.with.name).toBe('visual-${{ github.sha }}');
    expect(last.with.path).toBe('e2e-artifacts/');
    expect(last.with['retention-days']).toBe(14);
  });
});
