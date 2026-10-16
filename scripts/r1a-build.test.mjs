// AC-R1a-04, 06, 07, 08. BUILD-TIME checks: they read the static export in out/, so run `npm run build` first (CI `web` does).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const out = (...s) => join(REPO_ROOT, 'out', ...s);
const html = (rel) => readFileSync(out(rel), 'utf8');
const text = (rel) => html(rel).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/<!-- -->/g, '');
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const cssOf = (rel) => [...html(rel).matchAll(/href="([^"]*\.css)"/g)].map((m) => readFileSync(out(m[1]), 'utf8'));

describe('AC-R1a-04 fonts [build-time]', () => {
  for (const rel of ['index.html', 'about/index.html', 'sources/index.html']) {
    it(`${rel} and its css have no Fraunces and no Google font hosts`, () => {
      const all = [html(rel), ...cssOf(rel)].join('\n').toLowerCase();
      expect(all).not.toContain('fraunces');
      expect(all).not.toContain('fonts.googleapis.com');
      expect(all).not.toContain('fonts.gstatic.com');
    });
  }
  it('admin/index.html carries the Fraunces variable class (its own wrapper) and loads Fraunces', () => {
    const h = html('admin/index.html');
    const root = /<html[^>]*class="([^"]*)"/.exec(h)[1].split(/\s+/);
    const classes = new Set([...h.matchAll(/class="([^"]*_variable[^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.endsWith('_variable')));
    const extra = [...classes].filter((c) => !root.includes(c));
    expect(extra.length).toBeGreaterThanOrEqual(1);
    expect(cssOf('admin/index.html').join('\n')).toMatch(/font-family:\s*"?Fraunces/);
  });
  it('the woff2 files the index css loads total <= 124 KiB (126,976 bytes; R1b-CO3 allows the wordmark's OFL notice)', () => {
    const files = new Set();
    for (const css of cssOf('index.html')) for (const m of css.matchAll(/url\(\.\.\/media\/([^)]*\.woff2)\)/g)) files.add(m[1]);
    expect(files.size).toBeGreaterThan(0);
    let total = 0;
    for (const f of files) total += statSync(out('_next/static/media', f)).size;
    expect(total).toBeLessThanOrEqual(126_976);
  });
});

describe('AC-R1a-06 head [build-time]', () => {
  const h = () => html('index.html');
  it('has both theme-color metas, the icons and the manifest', () => {
    expect(h()).toContain('<meta name="theme-color" content="#f3f2ee" media="(prefers-color-scheme: light)"/>');
    expect(h()).toContain('<meta name="theme-color" content="#0e1a2b" media="(prefers-color-scheme: dark)"/>');
    expect(h()).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>');
    expect(h()).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>');
    expect(h()).toContain('<link rel="manifest" href="/site.webmanifest"/>');
  });
});

describe('AC-R1a-07 header [build-time]', () => {
  const h = () => html('about/index.html');
  it('has one home link with its label, /sources/ and /about/ (current)', () => {
    const header = /<header[\s\S]*?<\/header>/.exec(h())[0];
    expect(header.match(/<a [^>]*aria-label="TruckeeVibes home"[^>]*>/g)).toHaveLength(1);
    expect(header.match(/<a [^>]*href="\/"[^>]*>/g)).toHaveLength(1);
    expect(h()).toMatch(/<header[\s\S]*href="\/sources\/"[\s\S]*<\/header>/);
    expect(h()).toMatch(/<header[\s\S]*<a href="\/about\/" aria-current="page">About<\/a>[\s\S]*<\/header>/);
  });
  it('no "Thursday email" anywhere in out/**/*.html', () => {
    for (const f of walk(out())) if (f.endsWith('.html')) expect(readFileSync(f, 'utf8'), f).not.toContain('Thursday email');
  });
  it('no Lists menu while LIST_ROUTES_LIVE is false', () => {
    expect(readFileSync(join(REPO_ROOT, 'src/config/features.ts'), 'utf8')).toContain('LIST_ROUTES_LIVE = false');
    expect(h()).not.toContain('>Lists<');
  });
});

describe('AC-R1a-08 footer [build-time]', () => {
  const rel = 'about/index.html';
  it('contains the exact copy', () => {
    const t = text(rel);
    for (const s of [
      'A free, plain list of what is happening in Truckee and North Lake Tahoe, gathered from local calendars with links back to the organizers.',
      'Sister sites: TruckeeLights (Christmas and winter) and TruckeeFrights (Halloween and fall) draw from this list.',
      'No cookies, no accounts.',
      'Truckee sits on the ancestral homeland of the Washoe (Wašiw) people.',
    ]) expect(t).toContain(s);
  });
  it('links Sources, About, Add your calendar and Our bot', () => {
    const foot = /<footer[\s\S]*<\/footer>/.exec(html(rel))[0];
    for (const href of ['/sources/', '/about/', '/sources/#add', '/bot/']) expect(foot).toContain(`href="${href}"`);
  });
  it('a null sister URL renders the name without a link', () => {
    const cfg = readFileSync(join(REPO_ROOT, 'src/config/features.ts'), 'utf8');
    expect(cfg).toContain('frights: null');
    const foot = /<footer[\s\S]*<\/footer>/.exec(html(rel))[0];
    expect(foot).toContain('TruckeeFrights');
    expect(foot).not.toMatch(/<a [^>]*>TruckeeFrights<\/a>/);
  });
  it('the out/ tree exists', () => expect(existsSync(out('about/index.html'))).toBe(true));
});

// AC-R1b-CO1: with the sources read failing and no previous snapshot, /sources/ shows no zero counts.
describe('AC-R1b-CO1 sources build fallback [build-time]', () => {
  it('out/sources/index.html has no ">0 read daily" and no group with a 0 count', () => {
    const h = html('sources/index.html');
    expect(h).not.toContain('>0 read daily');
    expect(h).not.toMatch(/class="cnt">0</);
  });
});
