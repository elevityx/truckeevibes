// AC-M0-03. Contract for scripts/check-workflows.mjs: `node scripts/check-workflows.mjs [rootDir]`
// checks <rootDir or cwd>/.github/workflows/*.yml; exit 1 on any violation, 0 when clean.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeRepo, runScript, REPO_ROOT } from './_testlib.mjs';

const CHECK = join(REPO_ROOT, 'scripts', 'check-workflows.mjs');
const SHA = 'a'.repeat(40);

const CI = `name: ci
on:
  pull_request:
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

const check = (wf) => {
  const files = {};
  for (const [name, body] of Object.entries(wf)) files[`.github/workflows/${name}`] = body;
  return runScript(CHECK, makeRepo(files), []);
};
const fails = (wf) => expect(check(wf).status).toBe(1);

describe('check-workflows (AC-M0-03)', () => {
  it('passes a clean ci.yml', () => expect(check({ 'ci.yml': CI }).status).toBe(0));
  it('passes clean ingest, sign-feed and probe workflows', () =>
    expect(check({ 'ci.yml': CI, 'ingest.yml': INGEST, 'sign-feed.yml': SIGN, 'sign-gate-probe.yml': PROBE }).status).toBe(0));

  it('fails pull_request_target', () => fails({ 'ci.yml': CI.replace('pull_request:', 'pull_request_target:') }));
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
});
