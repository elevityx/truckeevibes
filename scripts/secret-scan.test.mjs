// AC-M0-02. Every positive sample is assembled at runtime from fragments, so no full forbidden
// string exists in tracked bytes (the scanner scans this file too).
// Contract for scripts/secret-scan.mjs: scans `git ls-files` of the cwd, exits 1 on a hit and prints
// "<file>:<line> <rule-id>" per hit (never the match); exports EXCLUDED_FILES; importing it must not run the CLI.
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeRepo, runScript, REPO_ROOT } from './_testlib.mjs';

const SCAN = join(REPO_ROOT, 'scripts', 'secret-scan.mjs');
const x = (n) => 'x'.repeat(n);

const cases = {
  'sb-secret': ['sb', 'secret', x(20)].join('_'),
  'jwt': ['ey' + 'J' + x(12), 'ey' + 'J' + x(12), x(10)].join('.'),
  'private-key': ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  'db-url': ['postgres', '://u:p@h/db'].join(''),
  'google-key': 'AI' + 'za' + 'a'.repeat(35),
  'resend': ['re', x(16), 'y'].join('_'),
  'deploy-hook': ['api.cloudflare', '.com/client/v4/pages/webhooks/deploy_hooks/', 'a1'.repeat(12)].join(''),
  'personal-email': 'someone@' + 'gmail' + '.com',
};

const scan = (files) => runScript(SCAN, makeRepo(files));

describe('secret-scan (AC-M0-02)', () => {
  for (const [name, sample] of Object.entries(cases)) {
    it(`flags ${name} with file:line and a rule id, never the match`, () => {
      const { status, out } = scan({ 'src/a.ts': `const ok = 1;\nconst v = '${sample}';\n` });
      expect(status).toBe(1);
      expect(out).toMatch(/src\/a\.ts:2 [a-z0-9_-]+/);
      expect(out).not.toContain(sample);
    });
  }

  it('flags a tracked .env.local', () => {
    const { status, out } = scan({ '.env.local': 'FOO=bar\n' });
    expect(status).toBe(1);
    expect(out).toContain('.env.local');
  });

  it('passes a repo with only .env.example and the public takedown address', () => {
    const { status } = scan({
      '.env.example': 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55421\n',
      'src/about.ts': "export const c = 'takedown@truckeevibes.com';\n",
    });
    expect(status).toBe(0);
  });

  it('skips package-lock.json', () => {
    const { status } = scan({ 'package-lock.json': `{"x":"${cases['sb-secret']}"}\n` });
    expect(status).toBe(0);
  });

  it('exports an exclusion constant that is exactly package-lock.json', async () => {
    const mod = await import(SCAN);
    expect([...mod.EXCLUDED_FILES]).toEqual(['package-lock.json']);
  });

  it('real-repo case: scanning this repository (incl. the scanner and this test) exits 0', () => {
    const { status } = runScript(SCAN, REPO_ROOT);
    expect(status).toBe(0);
  });
});
