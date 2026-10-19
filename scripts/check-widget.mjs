// W2.1 check-widget: the released widget files are exactly what the manifest says, reproducible, free of HTML sinks, within budget,
// and no released version ever disappears or changes.
//   node scripts/check-widget.mjs [--src <repo with widget/src>]   (checks public/widget/ in cwd; --src defaults to this script's repo)
// Rules: 1 manifest entries exist and match their sha384; 2 every file in public/widget/v1/ is in the manifest; 3 rebuilding the
// current WIDGET_VERSION is byte-identical; 4 no HTML sink / eval in the release file; 5 gzip budget (total <= 33,792 B, JS-only
// <= 25,600 B); 6 every manifest entry of the merge base (origin/main, or HEAD~1 on main) is still present, unchanged, with its file.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle, gz, sri, widgetVersion } from '../widget/build.mjs';

export const TOTAL_GZ_MAX = 33_792;
export const JS_GZ_MAX = 25_600;
// Assembled so this file does not match itself (the same trick as check-no-html.mjs).
export const SINKS = [['inner', 'HTML'], ['outer', 'HTML'], ['insert', 'Adjacent', 'HTML'], ['document', '.write'], ['ev', 'al('], ['new ', 'Function'], ['src', 'doc']].map((p) => p.join(''));

const git = (cwd, args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

export async function checkWidget(root, src) {
  const errors = [];
  const logs = [];
  const pub = join(root, 'public');
  const mfPath = join(pub, 'widget', 'manifest.json');
  if (!existsSync(mfPath)) return { errors: ['rule1: public/widget/manifest.json is missing'], logs };
  const manifest = JSON.parse(readFileSync(mfPath, 'utf8'));
  const entries = Array.isArray(manifest.versions) ? manifest.versions : [];

  // 1
  for (const e of entries) {
    const f = join(pub, String(e.file ?? ''));
    if (!/^\/widget\/v1\/tv-events\.\d+\.\d+\.\d+\.js$/.test(String(e.file)) || !existsSync(f)) errors.push(`rule1: ${e.version}: file ${e.file} is missing`);
    else if (sri(readFileSync(f)) !== e.integrity) errors.push(`rule1: ${e.version}: sha384 of ${e.file} does not match the manifest`);
  }
  // 2
  const dir = join(pub, 'widget', 'v1');
  const listed = new Set(entries.map((e) => e.file));
  if (existsSync(dir)) for (const n of readdirSync(dir)) if (!listed.has(`/widget/v1/${n}`)) errors.push(`rule2: public/widget/v1/${n} is not in the manifest`);
  // 3 + 5
  const version = widgetVersion(src);
  const cur = join(dir, `tv-events.${version}.js`);
  if (!existsSync(cur)) errors.push(`rule3: the current version ${version} has no release file`);
  else {
    const committed = readFileSync(cur);
    const built = await bundle(src);
    if (!committed.equals(built.code)) errors.push(`rule3: tv-events.${version}.js differs from a rebuild of widget/src (run npm run widget:build, or bump WIDGET_VERSION)`);
    const total = gz(committed);
    const js = gz(built.jsOnly);
    if (total > TOTAL_GZ_MAX) errors.push(`rule5: total gzip ${total} B > ${TOTAL_GZ_MAX} B`);
    if (js > JS_GZ_MAX) errors.push(`rule5: JS-only gzip ${js} B > ${JS_GZ_MAX} B`);
    logs.push(`total_gz=${total} js_gz=${js}`);
  }
  // 4
  for (const e of entries) {
    const f = join(pub, String(e.file ?? ''));
    if (!existsSync(f)) continue;
    const t = readFileSync(f, 'utf8');
    for (const s of SINKS) if (t.includes(s)) errors.push(`rule4: ${e.file} contains a forbidden sink`);
  }
  // 6
  const head = git(root, ['rev-parse', 'HEAD']);
  let base = git(root, ['merge-base', 'HEAD', 'origin/main']);
  if (!base || base === head) base = git(root, ['rev-parse', '--verify', '-q', 'HEAD~1']);
  const baseText = base ? git(root, ['show', `${base}:public/widget/manifest.json`]) : null;
  if (!baseText) logs.push('rule6: skipped (no base manifest)');
  else {
    const old = JSON.parse(baseText).versions ?? [];
    for (const o of old) {
      const now = entries.find((e) => e.version === o.version);
      if (!now || now.file !== o.file || now.integrity !== o.integrity) errors.push(`rule6: released ${o.version} was removed or changed in the manifest`);
      const f = join(pub, String(o.file ?? ''));
      if (!existsSync(f) || sri(readFileSync(f)) !== o.integrity) errors.push(`rule6: released file ${o.file} is missing or changed`);
    }
    logs.push(`rule6: ${old.length} released version(s) checked against ${base.slice(0, 7)}`);
  }
  return { errors, logs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--src');
  const src = i > 0 ? resolve(process.argv[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { errors, logs } = await checkWidget(process.cwd(), src);
  for (const l of logs) console.log(l);
  for (const e of errors) console.error(e);
  if (errors.length > 0) process.exit(1);
  console.log('check-widget: ok');
}
