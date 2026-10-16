import { defineConfig } from '@playwright/test';

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const desktop = { viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.mjs',
  reporter: [['list']],
  use: { trace: 'retain-on-failure', baseURL: 'http://127.0.0.1:4173' },
  // @clarity specs only run on a flag-on build (R3b); test:visual never runs them.
  ...(process.env.NEXT_PUBLIC_CLARITY_ENABLED === '1' ? {} : { grepInvert: /@clarity/ }),
  projects: [
    { name: 'phone-light', use: { ...phone, colorScheme: 'light' } },
    { name: 'phone-dark', use: { ...phone, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
  ],
  webServer: { command: 'node scripts/serve-out.mjs --port 4173', port: 4173, reuseExistingServer: !process.env.CI },
});
