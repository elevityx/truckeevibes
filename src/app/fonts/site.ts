// Bricolage Grotesque (display) and Atkinson Hyperlegible Next (body), self-hosted so `next build` never fetches Google Fonts.
// next/font/google failed the build whenever Google answered css2 with extensionless /l/font?kit=…&skey=… URLs (vercel/next.js#99114;
// RCA_CI_Next_Font). The woff2 files are the exact bytes next/font/google downloaded (Bricolage v9, Atkinson v7; OFL: scripts/og/fonts),
// and each call repeats one @font-face block of Google's css2 response: same family name, weights, stretch, unicode-range and preload
// (Google preloaded only Atkinson latin). next/font requires literal options, so the unicode ranges are written out per call.
import localFont from 'next/font/local';
import vars from './site.module.css';

export const atkinsonLatin = localFont({
  src: [{ path: './AtkinsonHyperlegibleNext-latin.woff2', weight: '400' }, { path: './AtkinsonHyperlegibleNext-latin.woff2', weight: '700' }],
  style: 'normal',
  display: 'swap',
  preload: true,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Atkinson Hyperlegible Next'" },
    { prop: 'unicode-range', value: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },
  ],
});

export const atkinsonLatinExt = localFont({
  src: [{ path: './AtkinsonHyperlegibleNext-latin-ext.woff2', weight: '400' }, { path: './AtkinsonHyperlegibleNext-latin-ext.woff2', weight: '700' }],
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Atkinson Hyperlegible Next'" },
    { prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF' },
  ],
});

export const bricolageLatin = localFont({
  src: [{ path: './BricolageGrotesque-latin.woff2', weight: '700' }, { path: './BricolageGrotesque-latin.woff2', weight: '800' }],
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Bricolage Grotesque'" },
    { prop: 'font-stretch', value: '100%' },
    { prop: 'unicode-range', value: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' },
  ],
});

export const bricolageLatinExt = localFont({
  src: [{ path: './BricolageGrotesque-latin-ext.woff2', weight: '700' }, { path: './BricolageGrotesque-latin-ext.woff2', weight: '800' }],
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Bricolage Grotesque'" },
    { prop: 'font-stretch', value: '100%' },
    { prop: 'unicode-range', value: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF' },
  ],
});

export const bricolageVietnamese = localFont({
  src: [{ path: './BricolageGrotesque-vietnamese.woff2', weight: '700' }, { path: './BricolageGrotesque-vietnamese.woff2', weight: '800' }],
  style: 'normal',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: "'Bricolage Grotesque'" },
    { prop: 'font-stretch', value: '100%' },
    { prop: 'unicode-range', value: 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB' },
  ],
});

/** Sets --font-bricolage and --font-atkinson (the names tokens.css reads); goes on <html> like the old next/font variable classes. */
export const siteFontVariables = vars.variable;
