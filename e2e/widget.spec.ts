// W2 demo e2e (AC-W2-13..16): the widget on /widget-demo/ from the committed, SRI-pinned release file, in all four projects.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const CLOCK = { halloween: new Date('2026-10-15T15:00:00Z'), christmas: new Date('2026-12-10T17:00:00Z') }; // the fixture clocks
type Season = keyof typeof CLOCK;

// GAP (reported, needs a spec decision): two axe findings come from Truckee Lights' own markup and palette, which W2 must reproduce
// for parity (AC-W2-08, AC-L1-06): the row's aria-label (Lights EventRow) does not contain its visible text (label-content-name-mismatch,
// WCAG 2.5.3), and Christmas --ev (#E0393E) on --surface / --surface-2 is below 4.5:1 (color-contrast). Only those exact nodes are
// accepted: inside a widget host, the exact element, and (for contrast) the exact baseline colours. Anything else serious or critical fails.
type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeNode = AxeResults['violations'][number]['nodes'][number];
const HOST = /^div\[data-tv-(list|upcoming|overlay)=""\],/;
function knownLights(id: string, n: AxeNode, season: Season): boolean {
  const target = n.target.map(String).join(' >>> ');
  if (!HOST.test(target)) return false;
  if (id === 'label-content-name-mismatch') return /(^|[ ,>])\.erow$/.test(target) && n.html.startsWith('<button type="button" class="erow"');
  if (id === 'color-contrast' && season === 'christmas' && /(^|[ ,>])\.(mo|t21)$/.test(target)) {
    const d = (n.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string };
    return d.fgColor === '#e0393e' && (d.bgColor === '#13233a' || d.bgColor === '#1b2f4b');
  }
  return false;
}
function serious(r: Pick<AxeResults, 'violations'>, season: Season): string[] {
  const out: string[] = [];
  for (const v of r.violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    for (const n of v.nodes) if (!knownLights(v.id, n, season)) out.push(`${v.id}: ${n.target.map(String).join(' >>> ')}`);
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

test('the axe baseline filter accepts only the two Lights findings', () => {
  const node = (target: unknown[], html: string, data?: object) => ({ target, html, any: data ? [{ data }] : [] }) as unknown as AxeNode;
  const res = (id: string, n: AxeNode) => ({ violations: [{ id, impact: 'serious', nodes: [n] }] }) as unknown as AxeResults;
  const mo = node([['div[data-tv-list=""]', 'li > .erow > .dchip > .mo']], '<span class="mo">', { fgColor: '#e0393e', bgColor: '#1b2f4b' });
  expect(serious(res('color-contrast', mo), 'christmas')).toEqual([]);
  expect(serious(res('color-contrast', mo), 'halloween')).toHaveLength(1);
  expect(serious(res('color-contrast', node([['div[data-tv-list=""]', '.t21']], '<span class="t21">', { fgColor: '#ff0000', bgColor: '#1b2f4b' })), 'christmas')).toHaveLength(1);
  expect(serious(res('color-contrast', node(['main > .mo'], '<span class="mo">', { fgColor: '#e0393e', bgColor: '#1b2f4b' })), 'christmas')).toHaveLength(1);
  const row = node([['div[data-tv-list=""]', 'li > .erow']], '<button type="button" class="erow" aria-label="x">');
  expect(serious(res('label-content-name-mismatch', row), 'halloween')).toEqual([]);
  expect(serious(res('label-content-name-mismatch', node(['main > .erow'], '<button type="button" class="erow">')), 'halloween')).toHaveLength(1);
  expect(serious(res('button-name', row), 'halloween')).toHaveLength(1);
});

test('keyboard: an open sheet survives the 5-min refresh and Escape returns focus to its row (W2 review P2)', async ({ page }, info) => {
  await open(page, 'halloween', 'ok', info.project.name.startsWith('phone'));
  const deepActiveId = () =>
    page.evaluate(() => {
      let a: Element | null = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      return a?.getAttribute('data-id') ?? a?.tagName ?? null;
    });
  const row = page.locator('[data-tv-list] .erow').nth(2);
  const id = await row.getAttribute('data-id');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tv-overlay] aside[role=dialog]')).toBeVisible();
  await page.clock.runFor(5 * 60_000 + 1000);
  await page.waitForTimeout(200);
  await expect(page.locator('[data-tv-overlay] aside[role=dialog]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-tv-overlay] aside[role=dialog]')).toHaveCount(0);
  expect(await deepActiveId()).toBe(id);
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
