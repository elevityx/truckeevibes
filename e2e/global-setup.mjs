// R1b: the empty and error states are properties of a BUILD (an empty snapshot; a forced live failure), so they need their own exports.
// This builds them once per run into out-empty/ and out-error/ and serves them on 4174 and 4175. The main fixture build in out/ (made by
// `npm run build:fixture`, which test:visual runs first) is moved aside while they build and put back after. Set VC_VARIANTS=0 to skip.
import { execSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createOutServer } from '../scripts/serve-out.mjs';

const VARIANTS = [
  { name: 'empty', port: 4174, env: { SNAPSHOT_FIXTURE: 'scripts/fixtures/snapshot-empty.json' } },
  { name: 'error', port: 4175, env: { SNAPSHOT_FIXTURE: 'scripts/fixtures/snapshot-empty.json', NEXT_PUBLIC_FORCE_LIVE_ERROR: '1' } },
];

export default async function globalSetup() {
  if (process.env.VC_VARIANTS === '0') return undefined;
  if (!existsSync('out/index.html')) throw new Error('globalSetup: out/ is missing; run `npm run build:fixture` first');
  rmSync('out-main', { recursive: true, force: true });
  renameSync('out', 'out-main');
  try {
    for (const v of VARIANTS) {
      rmSync('.next', { recursive: true, force: true }); // NEXT_PUBLIC_* is inlined; never reuse another variant's cache
      rmSync(`out-${v.name}`, { recursive: true, force: true });
      execSync('npm run build', { stdio: 'inherit', env: { ...process.env, ...v.env } });
      renameSync('out', `out-${v.name}`);
    }
  } finally {
    rmSync('out', { recursive: true, force: true });
    renameSync('out-main', 'out');
    rmSync('.next', { recursive: true, force: true });
    // The variant builds left their snapshot in public/data/; put the fixture snapshot back.
    execSync('node --run snapshot', { stdio: 'inherit', env: { ...process.env, SNAPSHOT_FIXTURE: 'scripts/fixtures/snapshot-visual.json' } });
  }
  const servers = VARIANTS.map((v) => createOutServer(resolve(`out-${v.name}`)).listen(v.port, '127.0.0.1'));
  return async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  };
}
