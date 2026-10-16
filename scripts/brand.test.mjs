// AC-R1a-05: the committed brand files.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_testlib.mjs';

const pub = (...s) => join(REPO_ROOT, 'public', ...s);
const size = (f) => {
  const b = readFileSync(pub(f));
  expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe('AC-R1a-05 brand files', () => {
  for (const f of ['badge-full', 'badge-full-dark', 'badge-simple', 'badge-simple-dark', 'lockup', 'lockup-dark'])
    it(`public/brand/${f}.svg exists and has no <text`, () => {
      expect(existsSync(pub('brand', `${f}.svg`))).toBe(true);
      expect(readFileSync(pub('brand', `${f}.svg`), 'utf8')).not.toContain('<text');
    });
  const sizes = { 'favicon-32.png': [32, 32], 'favicon-16.png': [16, 16], 'apple-touch-icon.png': [180, 180], 'icon-512-maskable.png': [512, 512], 'brand/lockup@1x.png': [260, 48], 'brand/lockup@2x.png': [520, 96] };
  for (const [f, wh] of Object.entries(sizes)) it(`${f} is ${wh.join('x')}`, () => expect(size(f)).toEqual(wh));
  it('favicon.svg follows the color scheme', () => expect(readFileSync(pub('favicon.svg'), 'utf8')).toContain('prefers-color-scheme: dark'));
  it('site.webmanifest equals the spec', () =>
    expect(JSON.parse(readFileSync(pub('site.webmanifest'), 'utf8'))).toEqual({
      name: 'TruckeeVibes', short_name: 'TruckeeVibes', start_url: '/', display: 'browser', background_color: '#f3f2ee', theme_color: '#f3f2ee',
      icons: [
        { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      ],
    }));
});
