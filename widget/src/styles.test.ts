// Lights parity rules that came from L1's parity run (globals.css "Next port additions"): the sheet panel's surface and accent borders,
// the desktop panel below Lights' header, the italic Christmas display face, and a whole-pixel credit row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'styles', 'widget.css'), 'utf8');
const rule = (sel: string, inMedia = false) => {
  const body = inMedia ? css.slice(css.indexOf('@media (min-width:760px)')) : css;
  const i = body.indexOf(`${sel}{`);
  expect(i, sel).toBeGreaterThanOrEqual(0);
  return body.slice(i + sel.length + 1, body.indexOf('}', i));
};

describe('widget.css Lights parity additions', () => {
  it('the panel is Lights surface with a 2px accent top border', () => {
    const r = rule('.tv-panel');
    expect(r).toContain('background:var(--surface, var(--tv-surface))');
    expect(r).toContain('border-top:2px solid var(--accent, var(--tv-accent))');
  });
  it('at 760px and up the panel sits below the header with a 2px accent left border', () => {
    const r = rule('.tv-panel', true);
    expect(r).toContain('top:calc(var(--row-h, 60px) + var(--band-h, 40px))');
    expect(r).toContain('border-left:2px solid var(--accent, var(--tv-accent))');
  });
  it('Christmas display headings are italic, bold, SOFT 100 / opsz 72, no tracking', () => {
    expect(rule(':host([data-season=christmas]) .disp')).toBe('font-style:italic; font-weight:700; font-variation-settings:"SOFT" 100, "opsz" 72; letter-spacing:0');
  });
  it('the credit row has a whole-pixel line height', () => {
    expect(rule('.tv-credit')).toContain('line-height:20px');
  });
});
