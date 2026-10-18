// AC-W2-12: the widget keeps no client state and sends nothing but its API reads.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BANNED = [['document', 'cookie'].join('.'), ['local', 'Storage'].join(''), ['session', 'Storage'].join(''), ['indexed', 'DB'].join(''),
  ['navigator', 'sendBeacon'].join('.')];

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else yield p;
  }
}

describe('AC-W2-12 privacy', () => {
  it('widget/src has no cookie, storage or beacon use', () => {
    const hits: string[] = [];
    let n = 0;
    for (const f of files(join(__dirname))) {
      n++;
      const t = readFileSync(f, 'utf8');
      for (const b of BANNED) if (t.includes(b)) hits.push(`${f}: ${b}`);
    }
    expect(n).toBeGreaterThan(10);
    expect(hits).toEqual([]);
  });
});
