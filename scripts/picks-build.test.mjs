// AC-R1c-13: the shipped picks file passes readPicks, and the owner veto path (PICKS_PATH -> { picks: [] }) renders no "Our picks".
// The page is a server component, so it is rendered here against a temp working directory that holds the fixture snapshot; a real
// `build:fixture` is the end-to-end check (test:visual).
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from './_testlib.mjs';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }) => createElement('a', { href, ...rest }, children),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const { readPicks } = await import('../src/lib/picksFile.ts');
const { default: Home } = await import('../src/app/page.tsx');

const cwd = process.cwd();
const savedPicks = process.env.PICKS_PATH;
afterEach(() => {
  process.chdir(cwd);
  if (savedPicks === undefined) delete process.env.PICKS_PATH;
  else process.env.PICKS_PATH = savedPicks;
});

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'picks-build-'));
  mkdirSync(join(dir, 'public', 'data'), { recursive: true });
  copyFileSync(join(REPO_ROOT, 'scripts/fixtures/snapshot-visual.json'), join(dir, 'public/data/events.json'));
  return dir;
}
const html = () => renderToString(createElement(Home)).replace(/<!-- -->/g, '');

describe('AC-R1c-13 picks file', () => {
  it('src/content/picks.json passes readPicks', () => {
    const f = readPicks(join(REPO_ROOT, 'src/content/picks.json'));
    expect(f.weekOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(f.picks.length).toBeLessThanOrEqual(5);
  });
});

describe('AC-R1c-13 owner veto', () => {
  it('with the fixture picks the home page has the Our picks row', () => {
    process.chdir(workdir());
    process.env.PICKS_PATH = join(REPO_ROOT, 'scripts/fixtures/picks-visual.json');
    const h = html();
    expect(h).toContain('Our picks');
    expect(h.match(/class="card pick"/g)).toHaveLength(3);
  });
  it('with { picks: [] } there is no "Our picks" text in the page', () => {
    const dir = workdir();
    const veto = join(dir, 'veto.json');
    writeFileSync(veto, JSON.stringify({ weekOf: '2026-10-15', picks: [] }));
    process.chdir(dir);
    process.env.PICKS_PATH = veto;
    const h = html();
    expect(h).not.toContain('Our picks');
    expect(h).not.toContain('Our pick');
    expect(h).toContain('Around Truckee this week'); // the page itself still renders
  });
  it('a bad picks file fails the render (the build)', () => {
    const dir = workdir();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ weekOf: '2026-10-15', picks: [{ eventId: '00000000-0000-4000-8000-000000000005', line: 'ALL CAPS' }] }));
    process.chdir(dir);
    process.env.PICKS_PATH = bad;
    expect(() => html()).toThrow('picks: pick_0_line_case');
  });
});
