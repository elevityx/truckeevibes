// AC-M0-19 and AC-M0-20 (Amendment 4, A4-4/A4-5). Contract for scripts/check-public-copy.mjs:
// scans tracked .ts/.tsx/.md/.mdx under src/app/** for cost/price words; prints "file:line rule-id"; exit 1 on a hit.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, runScript, REPO_ROOT } from './_testlib.mjs';

const CHECK = join(REPO_ROOT, 'scripts', 'check-public-copy.mjs');
const run = (files) => runScript(CHECK, makeRepo(files));

describe('check-public-copy (AC-M0-19)', () => {
  const lines = ['<p>costs almost nothing</p>', '<p>just $5</p>', '<p>10/mo</p>', '<h2>Pricing</h2>'];
  it('flags each banned phrase under src/app/** with one hit per line', () => {
    const { status, out } = run({ 'src/app/x/page.tsx': lines.join('\n') + '\n' });
    expect(status).toBe(1);
    for (let n = 1; n <= lines.length; n++) expect(out).toMatch(new RegExp(`src/app/x/page\\.tsx:${n} [a-z_-]+`));
  });
  for (const [name, text] of [['per month', 'about 3 per month'], ['budget', 'Our budget is small'], ['price', 'the price list'], ['Costing', 'costing us']]) {
    it(`flags "${name}"`, () => expect(run({ 'src/app/x/page.mdx': `${text}\n` }).status).toBe(1));
  }
  it('does not flag price_kind, template literals, or the same words under src/components/', () => {
    const { status } = run({
      'src/app/x/page.tsx': 'const price_kind = 1;\nconst s = `${a}`;\n',
      'src/components/Price.tsx': 'costs $5 10/mo Pricing budget\n',
    });
    expect(status).toBe(0);
  });
  it('ignores file types other than ts/tsx/md/mdx', () =>
    expect(run({ 'src/app/x/data.json': '{"a":"costs"}\n' }).status).toBe(0));
  it('real repo exits 0', () => {
    expect(existsSync(CHECK)).toBe(true);
    expect(runScript(CHECK, REPO_ROOT).status).toBe(0);
  });
  it('is chained into check:repo after check-no-html', () => {
    const c = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts['check:repo'];
    expect(c).toContain('check-public-copy.mjs');
    expect(c.indexOf('check-public-copy')).toBeGreaterThan(c.indexOf('check-no-html'));
  });
});

describe('bot page wording (AC-M0-19)', () => {
  const page = readFileSync(join(REPO_ROOT, 'src', 'app', 'bot', 'page.tsx'), 'utf8');
  it('has the exact conditional-requests sentence', () =>
    expect(page).toContain('Conditional requests avoid downloading an unchanged page again.'));
  it('no longer says "costs"', () => expect(page).not.toMatch(/costs/i));
  const built = join(REPO_ROOT, 'out', 'bot', 'index.html');
  it.skipIf(!existsSync(built))('built out/bot/index.html carries the new sentence [build-time]', () => {
    const html = readFileSync(built, 'utf8');
    expect(html).toContain('Conditional requests avoid downloading an unchanged page again.');
    expect(html).not.toContain('costs');
  });
});

describe('diff hygiene (AC-M0-20)', () => {
  it('CODE_OF_CONDUCT.md ends with exactly one newline', () => {
    const t = readFileSync(join(REPO_ROOT, 'CODE_OF_CONDUCT.md'), 'utf8');
    expect(t.endsWith('\n')).toBe(true);
    expect(t.endsWith('\n\n')).toBe(false);
  });
});
