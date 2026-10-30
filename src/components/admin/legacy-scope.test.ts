// AC-R1a-12: the back office keeps its original look. admin-legacy.css declares the old tokens on .adm, with the 58ae776 values.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/components/admin/admin-legacy.css'), 'utf8');
const block = /\.adm\{([^}]*)\}/.exec(css)![1];

const OLD: Record<string, string> = {
  '--bg': '#0B1626', '--surface': '#13233A', '--surface-2': '#1B2F4B', '--line': '#2c4466', '--text': '#F7F5EF', '--muted': '#AFC0D6',
  '--accent': '#F2C14E', '--on-accent': '#0B1626', '--accent-2': '#C62828', '--on-accent-2': '#FFFFFF', '--focus': '#F2C14E',
  '--danger': '#FF8A80', '--ok': '#7FD6A0', '--radius': '16px',
};

describe('AC-R1a-12 admin-legacy.css', () => {
  for (const [k, v] of Object.entries(OLD)) it(`.adm declares ${k}: ${v}`, () => expect(block).toContain(`${k}:${v}`));
  it('keeps the old display font, body font and dark color-scheme', () => {
    expect(block).toContain('--font-display: var(--font-fraunces), serif');
    expect(block).toContain('--body: var(--font-atkinson)');
    expect(block).toContain('color-scheme: dark');
  });
  it('re-scopes the old .btn, .card, .page, .disp and .fine rules under .adm', () => {
    for (const sel of ['.adm .btn', '.adm .btn.primary', '.adm .btn.alt', '.adm .btn.ghost', '.adm .btn:disabled', '.adm .disp', '.adm .card', '.adm .page', '.adm .fine'])
      expect(css).toContain(sel);
  });
  it('AdminApp imports admin-legacy.css first', () => {
    const app = readFileSync(join(process.cwd(), 'src/components/admin/AdminApp.tsx'), 'utf8');
    expect(app.indexOf("import './admin-legacy.css'")).toBeGreaterThan(-1);
    expect(app.indexOf("import './admin-legacy.css'")).toBeLessThan(app.indexOf("import './admin.css'"));
  });
  it('the admin layout loads Fraunces and the public root layout does not', () => {
    // Fraunces is self-hosted (RCA_CI_Next_Font): src/app/fonts/admin.ts loads it, and only the admin layout imports that module.
    expect(readFileSync(join(process.cwd(), 'src/app/admin/layout.tsx'), 'utf8')).toContain("from '../fonts/admin'");
    expect(readFileSync(join(process.cwd(), 'src/app/fonts/admin.ts'), 'utf8')).toContain("src: './Fraunces-latin.woff2'");
    for (const f of ['src/app/layout.tsx', 'src/app/fonts/site.ts'])
      expect(readFileSync(join(process.cwd(), f), 'utf8').toLowerCase()).not.toContain('fraunces');
  });
});
