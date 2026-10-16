// AC-R1a-05: the committed brand files.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

// AC-R1a-16..19 (font hygiene): name tables and license notices.
function psName(file) {
  const b = readFileSync(file);
  const n = b.readUInt16BE(4);
  let nameOff = 0;
  for (let i = 0; i < n; i++) if (b.toString('latin1', 12 + i * 16, 16 + i * 16) === 'name') nameOff = b.readUInt32BE(20 + i * 16);
  const count = b.readUInt16BE(nameOff + 2);
  const strOff = nameOff + b.readUInt16BE(nameOff + 4);
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    if (b.readUInt16BE(r + 6) === 6) {
      const len = b.readUInt16BE(r + 8);
      const off = strOff + b.readUInt16BE(r + 10);
      const raw = Buffer.from(b.subarray(off, off + len));
      return b.readUInt16BE(r) === 1 ? raw.toString('latin1') : raw.swap16().toString('utf16le');
    }
  }
  return '';
}
describe('AC-R1a-19 fonts', () => {
  const dir = join(REPO_ROOT, 'scripts/og/fonts');
  it('the two Atkinson files have distinct PostScript names', () => {
    const a = psName(join(dir, 'AtkinsonHyperlegibleNext-Regular.ttf'));
    const b = psName(join(dir, 'AtkinsonHyperlegibleNext-Bold.ttf'));
    expect(a).toContain('Atkinson');
    expect(b).toContain('Bold');
    expect(a).not.toBe(b);
  });
  it('each OFL file carries its family Copyright line', () => {
    const files = readdirSync(dir).filter((f) => /^OFL.*\.txt$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const t = readFileSync(join(dir, f), 'utf8');
      const family = /Atkinson/i.test(f) ? 'Atkinson Hyperlegible Next' : 'Bricolage Grotesque';
      expect(t, f).toMatch(new RegExp(`Copyright[^\\n]*${family}`));
    }
    expect(files.some((f) => /Atkinson/i.test(f))).toBe(true);
    expect(files.some((f) => /Bricolage/i.test(f))).toBe(true);
  });
});

// AC-R1b-CO3: the wordmark woff2 carries the OFL copyright (nameID 0) and license (nameID 13) records.
import { brotliDecompressSync } from 'node:zlib';
const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF '];
function woff2Table(file, want) {
  const b = readFileSync(file);
  expect(b.toString('latin1', 0, 4)).toBe('wOF2');
  const num = b.readUInt16BE(12);
  const compressed = b.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = b[p++];
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const dir = [];
  for (let i = 0; i < num; i++) {
    const flags = b[p++];
    const idx = flags & 0x3f;
    const tag = idx === 0x3f ? b.toString('latin1', p, (p += 4)) : KNOWN[idx];
    const ver = flags >> 6;
    const orig = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? ver === 0 : ver !== 0;
    dir.push({ tag, len: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(b.subarray(p, p + compressed));
  let off = 0;
  for (const t of dir) {
    if (t.tag === want) return data.subarray(off, off + t.len);
    off += t.len;
  }
  return null;
}
function nameRecords(buf) {
  const count = buf.readUInt16BE(2);
  const strOff = buf.readUInt16BE(4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const [plat, , , id, len, off] = [buf.readUInt16BE(r), buf.readUInt16BE(r + 2), buf.readUInt16BE(r + 4), buf.readUInt16BE(r + 6), buf.readUInt16BE(r + 8), buf.readUInt16BE(r + 10)];
    const raw = Buffer.from(buf.subarray(strOff + off, strOff + off + len));
    if (plat === 3) out[id] = raw.swap16().toString('utf16le');
    else out[id] ??= raw.toString('latin1');
  }
  return out;
}
describe('AC-R1b-CO3 wordmark notice', () => {
  const names = nameRecords(woff2Table(join(REPO_ROOT, 'src/app/fonts/BricolageWordmark.woff2'), 'name'));
  it('has the OFL copyright (nameID 0) naming the Bricolage Grotesque Project', () => expect(names[0]).toMatch(/Copyright.*Bricolage Grotesque Project Authors/));
  it('has the license name (nameID 13) and its URL (nameID 14)', () => {
    expect(names[13]).toContain('SIL Open Font License, Version 1.1');
    expect(names[14]).toContain('openfontlicense.org');
  });
  it('has family and PostScript names', () => {
    expect(names[1]).toContain('Bricolage');
    expect(names[6]).toMatch(/Bricolage.*Wordmark|Bricolage/);
  });
});
