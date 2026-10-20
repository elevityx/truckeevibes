// RCA_CI_Next_Font: next/font/google fetched Google Fonts at build time and failed the build whenever Google answered css2 with
// extensionless /l/font?kit=…&skey=… URLs (vercel/next.js#99114). Every web font is self-hosted now; these checks keep it that way.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const tracked = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: REPO_ROOT }).toString('utf8').split('\0').filter((f) => /\.(ts|tsx|css)$/.test(f));
const FONTS = join(REPO_ROOT, 'src/app/fonts');
const OFL = { AtkinsonHyperlegibleNext: 'scripts/og/fonts/OFL-Atkinson.txt', Bricolage: 'scripts/og/fonts/OFL-Bricolage.txt', Fraunces: 'src/app/fonts/OFL-Fraunces.txt' };

describe('self-hosted fonts (no build-time Google Fonts fetch)', () => {
  it('no source file imports next/font/google or links a Google Fonts host', () => {
    const bad = tracked.filter((f) => /from\s*['"]next\/font\/google['"]|\/\/fonts\.(googleapis|gstatic)\.com/.test(readFileSync(join(REPO_ROOT, f), 'utf8')));
    expect(bad).toEqual([]);
  });
  const woff2 = readdirSync(FONTS).filter((f) => f.endsWith('.woff2'));
  const loaders = ['src/app/layout.tsx', 'src/app/fonts/site.ts', 'src/app/fonts/admin.ts'].map((f) => readFileSync(join(REPO_ROOT, f), 'utf8')).join('\n');
  for (const f of woff2) {
    it(`${f} is a woff2 file that a next/font/local call loads, with its family's OFL notice`, () => {
      expect(readFileSync(join(FONTS, f)).subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(loaders).toMatch(new RegExp(`'\\./(fonts/)?${f.replace(/[.]/g, '\\.')}'`));
      const family = Object.keys(OFL).find((k) => f.startsWith(k));
      expect(family, f).toBeDefined();
      expect(readFileSync(join(REPO_ROOT, OFL[family]), 'utf8')).toMatch(/SIL Open Font License, Version 1\.1/);
    });
  }
});
