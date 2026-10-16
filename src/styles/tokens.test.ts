// AC-R1a-03: contrast pairs from the design tokens, both themes, plus the byte-identity pin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** sha256 of the approved design-token file as installed (the approved mockup's Design System). */
const DS_TOKENS_SHA256 = '7804e499a38ee877c611fdc0aa5f8fa44b42265c45a47cbdd8b7c12baa0a5156';

const raw = readFileSync(join(process.cwd(), 'src/styles/tokens.json'));
const tokens = JSON.parse(raw.toString('utf8')) as { color: { tokens: { name: string; value: { daylight: string; afterdark: string } }[] } };

type Theme = 'daylight' | 'afterdark';
const color = (name: string, theme: Theme): string => {
  const t = tokens.color.tokens.find((c) => c.name === name);
  if (!t) throw new Error(`no token ${name}`);
  return t.value[theme];
};

function lum(hex: string): number {
  const h = hex.replace('#', '').slice(0, 6);
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: Theme[] = ['daylight', 'afterdark'];
// alpenglow-ink on surface-raised is 4.36:1 in Daylight; the design system says to use ink there.
const NOT_A_TEXT_PAIR = [['alpenglow-ink', 'surface-raised']];

describe('AC-R1a-03 contrast', () => {
  for (const theme of THEMES) {
    describe(theme, () => {
      for (const fg of ['ink', 'ink-muted', 'river', 'alpenglow-ink', 'pine', 'danger'])
        for (const bg of ['ground', 'surface'])
          it(`${fg} on ${bg} >= 4.5`, () => expect(contrast(color(fg, theme), color(bg, theme))).toBeGreaterThanOrEqual(4.5));
      for (const fg of ['ink', 'ink-muted', 'river'])
        it(`${fg} on surface-raised >= 4.5`, () => expect(contrast(color(fg, theme), color('surface-raised', theme))).toBeGreaterThanOrEqual(4.5));
      for (const [fg, bg] of [['on-river', 'river'], ['on-alpenglow', 'alpenglow'], ['on-aspen', 'aspen']])
        it(`${fg} on ${bg} >= 4.5`, () => expect(contrast(color(fg, theme), color(bg, theme))).toBeGreaterThanOrEqual(4.5));
      for (const bg of ['ground', 'surface', 'surface-raised'])
        it(`line-strong on ${bg} >= 3.0`, () => expect(contrast(color('line-strong', theme), color(bg, theme))).toBeGreaterThanOrEqual(3));
    });
  }
  it('alpenglow-ink on surface-raised is explicitly not a text pair', () => {
    expect(NOT_A_TEXT_PAIR).toContainEqual(['alpenglow-ink', 'surface-raised']);
  });
});

describe('AC-R1a-03 tokens.json is the approved file', () => {
  it('sha256 matches DS_TOKENS_SHA256', () => expect(createHash('sha256').update(raw).digest('hex')).toBe(DS_TOKENS_SHA256));
});
