// Renders the brand assets (badge, lock-up, favicons, touch icons, web manifest) into public/.
//   npx tsx scripts/brand/render.tsx
// Text is converted to paths by satori (no SVG here contains a text element); PNGs come from resvg.
// The outputs are committed (plan W3): this script is run by hand, never at build.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FONTS = join(ROOT, 'scripts/og/fonts');
const PUB = join(ROOT, 'public');

type Theme = 'daylight' | 'afterdark';
const tokenFile = JSON.parse(readFileSync(join(ROOT, 'src/styles/tokens.json'), 'utf8')) as {
  color: { tokens: { name: string; value: Record<Theme, string> }[] };
};
const palette = (theme: Theme) => {
  const get = (name: string) => tokenFile.color.tokens.find((c) => c.name === name)!.value[theme];
  return { ground: get('ground'), surface: get('surface'), line: get('line'), ink: get('ink'), river: get('river'), alpenglow: get('alpenglow'), alpenglowInk: get('alpenglow-ink') };
};
type Palette = ReturnType<typeof palette>;

const bricolage = readFileSync(join(FONTS, 'BricolageGrotesque-ExtraBold.ttf'));
const fontOptions = [{ name: 'Bricolage Grotesque', data: bricolage, weight: 800 as const, style: 'normal' as const }];

/** hhea ascender/descender and unitsPerEm of a TrueType font, to place a baseline inside satori's line box. */
function metrics(buf: Buffer) {
  const n = buf.readUInt16BE(4);
  const table = (tag: string) => {
    for (let i = 0; i < n; i++) if (buf.toString('latin1', 12 + i * 16, 16 + i * 16) === tag) return buf.readUInt32BE(20 + i * 16);
    throw new Error(`no ${tag} table`);
  };
  const upm = buf.readUInt16BE(table('head') + 18);
  const hhea = table('hhea');
  return { upm, asc: buf.readInt16BE(hhea + 4), desc: buf.readInt16BE(hhea + 6) };
}
const M = metrics(bricolage);

interface Run { text: string; color: string }
interface TextPaths { markup: string; minX: number; maxX: number }

/** Text as path elements. Coordinates: x from 0 (left edge of the first glyph advance), y = 0 on the baseline. */
async function textPaths(runs: Run[], fontSize: number, letterSpacing = 0): Promise<TextPaths> {
  const lineHeight = Math.round(fontSize * 2);
  const width = 600;
  const svg = await satori(
    <div style={{ display: 'flex', width, height: lineHeight, fontFamily: 'Bricolage Grotesque', fontWeight: 800, fontSize, lineHeight: `${lineHeight}px`, letterSpacing }}>
      {runs.map((r, i) => (
        <span key={i} style={{ color: r.color }}>{r.text}</span>
      ))}
    </div>,
    { width, height: lineHeight, fonts: fontOptions },
  );
  const baseline = (lineHeight - ((M.asc - M.desc) / M.upm) * fontSize) / 2 + (M.asc / M.upm) * fontSize;
  const paths = svg.match(/<path\b[^>]*>/g) ?? [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of paths) {
    const d = /\sd="([^"]*)"/.exec(p)?.[1] ?? '';
    const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number) ?? [];
    for (let i = 0; i < nums.length; i += 2) {
      minX = Math.min(minX, nums[i]);
      maxX = Math.max(maxX, nums[i]);
    }
  }
  const body = paths.map((p) => p.replace(/\sstroke(-width)?="[^"]*"/g, '')).join('');
  return { markup: `<g transform="translate(0 ${-baseline.toFixed(2)})">${body}</g>`, minX, maxX };
}

const RIVER_LINE = (p: Palette, pts: string, w: number) => `<polyline points="${pts}" fill="none" stroke="${p.river}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;

/** badge-simple in the 170 x 170 box. */
const badgeSimple = (p: Palette) =>
  `<circle cx="85" cy="85" r="80" fill="${p.surface}" stroke="${p.ink}" stroke-width="10"/>` +
  RIVER_LINE(p, '30,108 58,72 80,92 104,58 140,108', 14) +
  `<circle cx="124" cy="52" r="14" fill="${p.alpenglow}"/>`;

/** badge-full in the 170 x 170 box. */
async function badgeFull(p: Palette) {
  const a = await textPaths([{ text: 'TRUCKEE', color: p.ink }], 20);
  const b = await textPaths([{ text: 'VIBES', color: p.alpenglowInk }], 16, 3);
  const at = (t: TextPaths, y: number) => `<g transform="translate(${(85 - (t.minX + t.maxX) / 2).toFixed(2)} ${y})">${t.markup}</g>`;
  return (
    `<circle cx="85" cy="85" r="80" fill="${p.surface}" stroke="${p.ink}" stroke-width="5"/>` +
    `<circle cx="85" cy="85" r="68" fill="none" stroke="${p.line}" stroke-width="2"/>` +
    RIVER_LINE(p, '30,98 52,74 66,86 88,56 106,78 118,68 140,98', 6) +
    `<circle cx="122" cy="50" r="8" fill="${p.alpenglow}"/>` +
    at(a, 124) +
    at(b, 145)
  );
}

const wrap = (w: number, h: number, inner: string, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${extra}${inner}</svg>`;

/** Lock-up: badge-simple at 34 px, a 10 px gap, then the wordmark at 26 px. Returns its markup and natural size. */
async function lockup(p: Palette) {
  const t = await textPaths([{ text: 'Truckee', color: p.ink }, { text: 'Vibes', color: p.alpenglowInk }], 26);
  const textW = t.maxX - t.minX;
  const w = 34 + 10 + textW;
  const inner =
    `<g transform="scale(0.2)">${badgeSimple(p)}</g>` +
    `<g transform="translate(${(44 - t.minX).toFixed(2)} 17)"><g transform="translate(0 9)">${t.markup}</g></g>`;
  return { inner, w: Math.ceil(w), h: 34 };
}

function write(rel: string, data: string | Buffer) {
  const f = join(PUB, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, data);
  console.log(`brand: wrote public/${rel}`);
}
const png = (svg: string, width: number) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());

async function main() {
  const light = palette('daylight');
  const dark = palette('afterdark');
  const full = (p: Palette) => badgeFull(p).then((g) => wrap(170, 170, g));
  write('brand/badge-full.svg', await full(light));
  write('brand/badge-full-dark.svg', await full(dark));
  write('brand/badge-simple.svg', wrap(170, 170, badgeSimple(light)));
  write('brand/badge-simple-dark.svg', wrap(170, 170, badgeSimple(dark)));
  const lk = await lockup(light);
  const lkDark = await lockup(dark);
  write('brand/lockup.svg', wrap(lk.w, lk.h, lk.inner));
  write('brand/lockup-dark.svg', wrap(lkDark.w, lkDark.h, lkDark.inner));

  // PNG lock-up on a transparent canvas, contained in 260 x 48 (and 520 x 96).
  const lockPng = (cw: number, ch: number) => {
    const s = Math.min((cw - 8) / lk.w, (ch - 8) / lk.h);
    const x = (cw - lk.w * s) / 2;
    const y = (ch - lk.h * s) / 2;
    return png(wrap(cw, ch, `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})">${lk.inner}</g>`), cw);
  };
  write('brand/lockup@1x.png', lockPng(260, 48));
  write('brand/lockup@2x.png', lockPng(520, 96));

  // favicon.svg: badge-simple whose four fills follow the color scheme.
  const css =
    `<style>.s{fill:${light.surface};stroke:${light.ink}}.r{stroke:${light.river}}.a{fill:${light.alpenglow}}` +
    `@media (prefers-color-scheme: dark){.s{fill:${dark.surface};stroke:${dark.ink}}.r{stroke:${dark.river}}.a{fill:${dark.alpenglow}}}</style>`;
  const fav =
    `<circle class="s" cx="85" cy="85" r="80" stroke-width="10"/>` +
    `<polyline class="r" points="30,108 58,72 80,92 104,58 140,108" fill="none" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle class="a" cx="124" cy="52" r="14"/>`;
  write('favicon.svg', wrap(170, 170, fav, css));
  const badge = (px: number, size: number, bg: string | null) =>
    png(wrap(size, size, `${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ''}<g transform="translate(${(size - px) / 2} ${(size - px) / 2}) scale(${px / 170})">${badgeSimple(light)}</g>`), size);
  write('favicon-32.png', badge(32, 32, null));
  write('favicon-16.png', badge(16, 16, null));
  write('apple-touch-icon.png', badge(148, 180, light.surface));
  write('icon-512-maskable.png', badge(320, 512, light.ground));

  const manifest = {
    name: 'TruckeeVibes',
    short_name: 'TruckeeVibes',
    start_url: '/',
    display: 'browser',
    background_color: '#f3f2ee',
    theme_color: '#f3f2ee',
    icons: [
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  };
  write('site.webmanifest', JSON.stringify(manifest, null, 2) + '\n');
}

void main();
