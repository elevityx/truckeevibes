// W2 demo e2e (AC-W2-13..16): the widget on /widget-demo/ from the committed, SRI-pinned release file, in all four projects.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CLOCK = { halloween: new Date('2026-10-15T15:00:00Z'), christmas: new Date('2026-12-10T17:00:00Z') }; // the fixture clocks
type Season = keyof typeof CLOCK;

// GAP (reported, needs a spec decision): two axe findings come from Truckee Lights' own markup and palette, which W2 must reproduce
// for parity (AC-W2-08, AC-L1-06): the row's aria-label (Lights EventRow) does not contain its visible text (label-content-name-mismatch,
// WCAG 2.5.3), and Christmas --ev (#E0393E) on --surface / --surface-2 is below 4.5:1 (color-contrast). They are listed here exactly;
// anything else serious or critical fails.
const KNOWN_LIGHTS: { id: string; target: RegExp; season?: Season }[] = [
  { id: 'label-content-name-mismatch', target: /\.erow$/ },
  { id: 'color-contrast', target: /(^|[ ,>])\.mo$|\.t21$/, season: 'christmas' },
];
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
function serious(r: AxeResults, season: Season): string[] {
  const out: string[] = [];
  for (const v of r.violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    for (const n of v.nodes) {
      const target = n.target.map(String).join(' >>> ');
      const known = KNOWN_LIGHTS.some((k) => k.id === v.id && (!k.season || k.season === season) && k.target.test(target));
      if (!known) out.push(`${v.id}: ${target}`);
    }
  }
  return out;
}

async function open(page: Page, season: Season, state: string, isPhone: boolean) {
  if (isPhone) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  }
  await page.clock.install({ time: CLOCK[season] });
  await page.goto(`/widget-demo/?season=${season}&state=${state}`);
  await expect(page.locator('html')).toHaveAttribute('data-tv-state', /ready|held|stale|failed/);
}

const sheetBox = (page: Page) =>
  page.evaluate(() => {
    const host = document.querySelector('body > [data-tv-overlay]');
    const aside = host?.shadowRoot?.querySelector('aside.tv-panel');
    if (!aside) return null;
    const r = aside.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, ih: innerHeight, iw: innerWidth };
  });

for (const season of ['halloween', 'christmas'] as const) {
  test(`AC-W2-13/14 ${season}: list, upcoming and sheet render; no overflow; sheet geometry; axe`, async ({ page }, info) => {
    const isPhone = info.project.name.startsWith('phone');
    await open(page, season, 'ok', isPhone);
    await expect(page.locator('html')).toHaveAttribute('data-tv-state', 'ready');
    await expect(page.locator('[data-tv-list] .erow')).toHaveCount(12);
    await expect(page.locator('[data-tv-upcoming] .erow')).toHaveCount(3);
    await expect(page.locator('[data-pins] li')).toHaveCount(12);
    await expect(page.locator('[data-tv-list] .tv-credit')).toHaveText('Powered by TruckeeVibes');
    expect(await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth])).toEqual(isPhone ? [390, 390] : [1440, 1440]);

    expect(serious(await new AxeBuilder({ page }).analyze(), season)).toEqual([]);

    await page.locator('[data-tv-list] .erow').first().click();
    await expect(page.locator('[data-tv-overlay] aside[role=dialog]')).toBeVisible();
    await expect(page.locator('[data-tv-overlay] .tv-credit')).toHaveText('Powered by TruckeeVibes');
    const b = (await sheetBox(page))!;
    if (isPhone) {
      expect(Math.abs(b.bottom - b.ih)).toBeLessThan(1);
      expect(b.height).toBeLessThanOrEqual(0.85 * b.ih + 1);
      expect(b.width).toBeCloseTo(b.iw, 0);
    } else {
      expect(b.width).toBeCloseTo(400, 0);
      expect(b.right).toBeCloseTo(b.iw, 0);
      expect(b.top).toBeCloseTo(0, 0);
      expect(b.bottom).toBeCloseTo(b.ih, 0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)).toBe(true);
    expect(serious(await new AxeBuilder({ page }).analyze(), season)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-tv-overlay] aside[role=dialog]')).toHaveCount(0);
  });
}

test('AC-W2-15 xss: no dialog, no widget console error, hostile text shown as text', async ({ page }, info) => {
  const problems: string[] = [];
  page.on('dialog', (d) => {
    problems.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await open(page, 'halloween', 'xss', info.project.name.startsWith('phone'));
  await expect(page.locator('html')).toHaveAttribute('data-tv-state', 'ready');
  await expect(page.locator('[data-tv-list]').getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('[data-tv-list]').getByText('"><script>alert(1)</script>', { exact: true })).toBeVisible();
  for (const row of await page.locator('[data-tv-list] .erow').all()) {
    await row.click();
    await expect(page.locator('[data-tv-overlay] aside[role=dialog]')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  const active = await page.evaluate(() => {
    const roots: (Document | ShadowRoot)[] = [document];
    for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    return roots.reduce((n, r) => n + r.querySelectorAll('script:not([src]), img, iframe, object').length, 0) - document.querySelectorAll('script:not([src])').length;
  });
  expect(active).toBe(0);
  await page.waitForTimeout(300);
  expect(problems).toEqual([]);
});

const NOTES: [string, string][] = [
  ['held', 'Some events are being re-checked. List last confirmed 7:08 am.'],
  ['stale', 'Events last updated 6:00 am.'],
  ['failed', "Events can't load right now. See them on truckeevibes.com."],
  ['empty', 'No events yet — know one? Add it.'],
];
for (const [state, text] of NOTES) {
  test(`AC-W2-16 state=${state} shows its message`, async ({ page }, info) => {
    await open(page, 'halloween', state, info.project.name.startsWith('phone'));
    await expect(page.locator('[data-tv-list]').getByText(text, { exact: true })).toBeVisible();
    await expect(page.locator('[data-tv-upcoming]').getByText(text, { exact: true })).toBeVisible();
  });
}
