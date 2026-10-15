// V6: data is rendered as React text only. Fails when a tracked .ts/.tsx under src/ or ingest/ contains
// the React raw-HTML prop or an innerHTML assignment.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BAD = [['dangerously', 'SetInnerHTML'].join(''), ['.inner', 'HTML'].join('')];

const files = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1 << 28 })
  .toString('utf8')
  .split('\0')
  .filter((f) => /^(src|ingest)\/.*\.tsx?$/.test(f));

let bad = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (BAD.some((b) => line.includes(b))) {
      console.error(`${f}:${i + 1} raw-html`);
      bad++;
    }
  });
}
if (bad > 0) process.exit(1);
console.log(`check-no-html: ok (${files.length} files)`);
