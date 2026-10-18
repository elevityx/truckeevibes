// W2.1: builds the versioned, immutable widget release and upserts its SRI manifest entry.
//   node widget/build.mjs [--out <dir>]   (default out dir: public/widget)
// Output: <out>/v1/tv-events.<WIDGET_VERSION>.js. A released file is never rewritten with different bytes (exit 1).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function widgetVersion(root = ROOT) {
  const m = /WIDGET_VERSION = '(\d+\.\d+\.\d+)'/.exec(readFileSync(join(root, 'widget/src/version.ts'), 'utf8'));
  if (!m) throw new Error('widget/src/version.ts: WIDGET_VERSION not found');
  return m[1];
}

export const gz = (buf) => gzipSync(buf, { level: 9 }).length;
export const sri = (buf) => `sha384-${createHash('sha384').update(buf).digest('base64')}`;

/** `?raw` CSS imports (the Vitest spelling) resolve to the file; `emptyCss` swaps the CSS for '' to measure the JS alone. */
const cssRaw = (emptyCss) => ({
  name: 'css-raw',
  setup(b) {
    b.onResolve({ filter: /\.css\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, '')), namespace: emptyCss ? 'empty-css' : 'file' }));
    b.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'text' }));
  },
});

/** The release bytes, plus the JS-only bytes (same build with the stylesheet text emptied). */
export async function bundle(root = ROOT) {
  const one = async (emptyCss) => {
    const r = await build({
      entryPoints: [join(root, 'widget/src/index.ts')], bundle: true, format: 'iife', globalName: 'TruckeeVibes', minify: true,
      target: ['es2020', 'safari15'], loader: { '.css': 'text' }, legalComments: 'none', charset: 'utf8', sourcemap: false,
      write: false, absWorkingDir: root, logLevel: 'silent', plugins: [cssRaw(emptyCss)],
    });
    return Buffer.from(r.outputFiles[0].contents);
  };
  const code = await one(false);
  const jsOnly = await one(true);
  const css = readFileSync(join(root, 'widget/src/styles/widget.css'));
  return { code, jsOnly, css };
}

const semverCmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

async function main() {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? resolve(process.argv[i + 1]) : join(ROOT, 'public/widget');
  const version = widgetVersion();
  const { code, jsOnly, css } = await bundle();
  const rel = `/widget/v1/tv-events.${version}.js`;
  const file = join(out, 'v1', `tv-events.${version}.js`);
  if (existsSync(file) && !readFileSync(file).equals(code)) {
    console.error(`immutable: bump WIDGET_VERSION (${rel} exists with different bytes)`);
    process.exit(1);
  }
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, code);
  const mf = join(out, 'manifest.json');
  const manifest = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : { versions: [] };
  if (!manifest.versions.some((v) => v.version === version)) {
    manifest.versions.push({ version, file: rel, integrity: sri(code), bytes: code.length, gzipBytes: gz(code) });
  }
  manifest.versions.sort((a, b) => semverCmp(a.version, b.version)); // existing entries are never changed
  writeFileSync(mf, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`widget ${version}: ${rel} ${code.length} bytes`);
  console.log(`js_gz=${gz(jsOnly)} css_gz=${gz(css)} total_gz=${gz(code)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
