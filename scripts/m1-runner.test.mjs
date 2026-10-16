// M1 PR 2: the ingest workflow (S1.10 + A4-1 checker rules) and the bot page Crawl-delay sentence (S1.13 step 6).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { REPO_ROOT, runScript } from './_testlib.mjs';
import { checkWorkflow } from './check-workflows.mjs';

const WF = join(REPO_ROOT, '.github', 'workflows', 'ingest.yml');
const text = () => (existsSync(WF) ? readFileSync(WF, 'utf8') : '');
const wf = () => parseDocument(text(), { version: '1.2' }).toJS();
const steps = () => Object.values(wf().jobs).flatMap((j) => j.steps ?? []);

describe('.github/workflows/ingest.yml (S1.10, A4-1)', () => {
  it('exists', () => { expect(existsSync(WF)).toBe(true); });
  it('passes checkWorkflow with no violations', () => { expect(checkWorkflow('ingest.yml', text())).toEqual([]); });
  it('the real repo passes `node scripts/check-workflows.mjs` (exit 0)', () => {
    const r = runScript(join(REPO_ROOT, 'scripts', 'check-workflows.mjs'), REPO_ROOT);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/ok \(3 files\)/); // ci.yml + ingest.yml + rebuild.yml
  });
  it('triggers: only schedule (4 runs a day) and workflow_dispatch', () => {
    const on = wf().on;
    expect(Object.keys(on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(on.schedule).toEqual([{ cron: '10 4,13,18,23 * * *' }]);
  });
  it('permissions contents: read; concurrency group ingest without cancelling a running ingest', () => {
    expect(wf().permissions).toEqual({ contents: 'read' });
    expect(wf().concurrency).toEqual({ group: 'ingest', 'cancel-in-progress': false });
  });
  it('one job: ubuntu-latest, 30-minute timeout, main-branch guard', () => {
    const jobs = Object.values(wf().jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]['runs-on']).toBe('ubuntu-latest');
    expect(jobs[0]['timeout-minutes']).toBe(30);
    expect(String(jobs[0].if).replace(/^\$\{\{|\}\}$/g, '').trim()).toBe("github.ref == 'refs/heads/main'");
  });
  it('checkout does not persist credentials; Node comes from .nvmrc; installs with npm ci; runs `npm run ingest`', () => {
    const s = steps();
    const co = s.find((x) => String(x.uses).startsWith('actions/checkout@'));
    expect(co?.with?.['persist-credentials']).toBe(false);
    const node = s.find((x) => String(x.uses).startsWith('actions/setup-node@'));
    expect(node?.with?.['node-version-file']).toBe('.nvmrc');
    expect(s.some((x) => x.run === 'npm ci')).toBe(true);
    expect(s.filter((x) => x.run === 'npm run ingest')).toHaveLength(1);
  });
  it('the ingest step env is exactly INGEST_URL (variable) + INGEST_HMAC_KEY and PAGES_DEPLOY_HOOK_URL (secrets)', () => {
    const step = steps().find((x) => x.run === 'npm run ingest');
    expect(step.env).toEqual({
      INGEST_URL: '${{ vars.INGEST_URL }}',
      INGEST_HMAC_KEY: '${{ secrets.INGEST_HMAC_KEY }}',
      PAGES_DEPLOY_HOOK_URL: '${{ secrets.PAGES_DEPLOY_HOOK_URL }}',
    });
  });
  it('the only secrets referenced anywhere are INGEST_HMAC_KEY and PAGES_DEPLOY_HOOK_URL (the runner holds no database key)', () => {
    const used = [...text().matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();
    expect(used).toEqual(['INGEST_HMAC_KEY', 'PAGES_DEPLOY_HOOK_URL']);
    expect(text()).not.toMatch(/SUPABASE|SERVICE_ROLE|secrets\[|toJSON\(secrets|secrets:\s*inherit|github\.token/i);
  });
  it('no environment, no write permissions, and every `uses` is pinned to a 40-hex SHA', () => {
    expect(text()).not.toMatch(/^\s*environment:/m);
    expect(text()).not.toMatch(/write|feed-signing/);
    for (const s of steps().filter((x) => x.uses)) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('bot page (S1.13 step 6)', () => {
  const page = () => readFileSync(join(REPO_ROOT, 'src', 'app', 'bot', 'page.tsx'), 'utf8');
  const plain = () => page().replace(/<\/?code>/g, '').replace(/`/g, '').replace(/\s+/g, ' ');
  it('says exactly: We honor Crawl-delay and never fetch faster than one request per second per host.', () => {
    expect(plain()).toContain('We honor Crawl-delay and never fetch faster than one request per second per host.');
  });
  it('keeps the earlier wording (AC-M0-11/19) and the page stays text-only', () => {
    expect(page()).toContain('At most 1 request per second per host.');
    expect(page()).toContain('Conditional requests avoid downloading an unchanged page again.');
    expect(page()).not.toMatch(/\bcosts?\b/i);
    expect(page()).not.toMatch(/useState|use client/);
  });
  it('check-public-copy still passes on the real repo (the new sentence adds no banned word)', () => {
    const r = runScript(join(REPO_ROOT, 'scripts', 'check-public-copy.mjs'), REPO_ROOT);
    expect(r.status).toBe(0);
  });
});
