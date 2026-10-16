// Visual check protocol (VC): each web PR appends its routes and states here.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const NOW = new Date('2026-10-15T15:00:00Z'); // Thu Oct 15, 8:00 am PDT

/** Routes covered so far. `admin` keeps its own look, so its focus ring is its own --focus token. */
const VARIANT = { empty: 'http://127.0.0.1:4174', error: 'http://127.0.0.1:4175' }; // R1b state builds (e2e/global-setup.mjs)
const ROUTES: { path: string; name: string; admin?: boolean; hydrate?: boolean }[] = [
  { path: '/', name: 'home', hydrate: true },
  { path: '/?free=1&when=date:2026-10-17', name: 'home-noresults' },
  { path: `${VARIANT.empty}/`, name: 'home-empty' },
  { path: `${VARIANT.error}/`, name: 'home-error' },
  { path: '/about/', name: 'about' },
  { path: '/sources/', name: 'sources' },
  { path: '/bot/', name: 'bot' },
  { path: '/admin/', name: 'admin', admin: true },
];

async function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    (window as unknown as { __csp: number }).__csp = 0;
    document.addEventListener('securitypolicyviolation', () => ((window as unknown as { __csp: number }).__csp += 1));
  });
  return problems;
}

for (const r of ROUTES) {
  test(`VC ${r.name}`, async ({ page }, info) => {
    await page.clock.install({ time: NOW });
    const problems = await watch(page);
    await page.goto(r.path);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('h1, .adm').first()).toBeVisible();
    if (r.name.startsWith('home')) await page.waitForTimeout(250); // let the clock tick and the URL filters apply after hydration

    mkdirSync('e2e-artifacts', { recursive: true });
    await page.screenshot({ path: `e2e-artifacts/${r.name}-${info.project.name}.png`, fullPage: true });

    // (a) phone: no horizontal scroll
    if (info.project.name.startsWith('phone')) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)).toBe(true);
    }

    // (b) every visible, non-inline control is at least 44 px tall
    const small = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('a, button, input, select, [role=switch], summary')) {
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        if (cs.display === 'inline' || cs.display === 'none' || cs.visibility === 'hidden' || box.width === 0 || box.height === 0) continue;
        if (box.height < 43.5) bad.push(`${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}" ${box.height.toFixed(1)}px`);
      }
      return bad;
    });
    expect(small, 'controls under 44 px').toEqual([]);

    // (c) axe: no serious or critical violations
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

    // (d) no CSP violations, no console errors
    expect(await page.evaluate(() => (window as unknown as { __csp: number }).__csp)).toBe(0);
    expect(problems).toEqual([]);

    // (f) hydration: a When pill responds (list pages)
    if (r.hydrate) {
      const pill = page.getByRole('button', { name: 'Today', exact: true });
      await expect(pill).toHaveAttribute('aria-pressed', 'false');
      await pill.click();
      await expect(pill).toHaveAttribute('aria-pressed', 'true');
      await pill.click();
    }

    // (e) one Tab focuses an element with a 3px solid ring in the river color (admin: its own --focus color)
    await page.keyboard.press('Tab');
    const ring = await page.evaluate((admin) => {
      const el = document.activeElement as HTMLElement;
      if (!el || el === document.body) return null;
      const probe = document.createElement('span');
      probe.style.color = admin ? 'var(--focus)' : 'var(--river)';
      (admin ? el : document.documentElement).appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor, want };
    }, !!r.admin);
    if (ring === null) {
      // No focusable element on this screen (the admin login without a database): nothing to ring.
      expect(r.admin).toBe(true);
    } else {
      expect(ring).toEqual({ width: '3px', style: 'solid', color: ring.want, want: ring.want });
    }
  });
}

test.describe('AC-R1a-14 reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('about: .btn transition-duration is 0s', async ({ page }) => {
    await page.goto('/about/');
    const d = await page.locator('.btn').first().evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(d).toBe('0s');
  });
});

test.describe('Amendment R1a-1 canvas alignment', () => {
  for (const path of ['/about/', '/sources/']) {
    test(`AC-R1a-16 ${path}: h1 left edge equals the lock-up's`, async ({ page }, info) => {
      await page.goto(path);
      const [lock, h1] = await Promise.all([
        page.locator('header .lock').first().evaluate((el) => el.getBoundingClientRect().left),
        page.locator('main h1').first().evaluate((el) => el.getBoundingClientRect().left),
      ]);
      expect(Math.abs(lock - h1)).toBeLessThanOrEqual(1);
      if (info.project.name.startsWith('phone')) expect(Math.round(h1)).toBe(16);
    });
  }
  test('AC-R1a-17 /sources/: flat rows, 2px ink group heads, raised current pill', async ({ page }, info) => {
    await page.goto('/sources/');
    if (info.project.name.startsWith('phone')) await page.locator('header summary').click(); // the links sit in the menu on phones
    const rows = await page.locator('.srcrow').evaluateAll((els) => els.map((e) => ({ r: getComputedStyle(e).borderTopLeftRadius, bg: getComputedStyle(e).backgroundColor })));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.r).toBe('0px');
      expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(r.bg);
    }
    const heads = await page.locator('.dayh').evaluateAll((els) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ink)';
      document.body.appendChild(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      return els.map((e) => ({ w: getComputedStyle(e).borderBottomWidth, c: getComputedStyle(e).borderBottomColor, ink }));
    });
    expect(heads).toHaveLength(3);
    for (const h of heads) expect(h).toEqual({ w: '2px', c: h.ink, ink: h.ink });
    const cur = await page.locator('header a[aria-current="page"]:visible').first().evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--surface-raised)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return { bg: getComputedStyle(el).backgroundColor, want };
    });
    expect(cur.bg).toBe(cur.want);
  });
});

test.describe('AC-R1b-CO2 footer links', () => {
  test('no side padding; the first link meets the lock-up on phones, the last link meets the right edge on desktop', async ({ page }, info) => {
    await page.goto('/about/');
    const m = await page.evaluate(() => {
      const foot = document.querySelector('footer.foot') as HTMLElement;
      const lock = foot.querySelector('.lock') as HTMLElement;
      const links = [...foot.querySelectorAll<HTMLElement>('nav a')];
      const pad = links.map((a) => [getComputedStyle(a).paddingLeft, getComputedStyle(a).paddingRight]);
      return {
        lockLeft: lock.getBoundingClientRect().left,
        firstLeft: links[0].getBoundingClientRect().left,
        lastRight: links.at(-1)!.getBoundingClientRect().right,
        footRight: foot.getBoundingClientRect().right,
        pad, n: links.length,
      };
    });
    expect(m.n).toBe(4);
    for (const [l, r] of m.pad) expect([l, r]).toEqual(['0px', '0px']);
    if (info.project.name.startsWith('phone')) expect(Math.abs(m.firstLeft - m.lockLeft)).toBeLessThanOrEqual(1);
    else expect(Math.abs(m.lastRight - m.footRight)).toBeLessThanOrEqual(1);
  });
});

test.describe('R1b home layout', () => {
  test('tiles: 8 in order, 4 columns from 760 px and 2 below; Kids says Soon', async ({ page }, info) => {
    await page.clock.install({ time: NOW });
    await page.goto('/');
    const tiles = page.locator('nav[aria-label="Lists"] .tile');
    await expect(tiles).toHaveCount(8);
    await expect(tiles.nth(4)).toContainText('Soon');
    const lefts = await tiles.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(info.project.name.startsWith('phone') ? 2 : 4);
  });
  test('a tile toggles the in-page list and back (no navigation)', async ({ page }) => {
    await page.clock.install({ time: NOW });
    await page.goto('/');
    await page.getByRole('button', { name: /^Music/ }).click();
    await expect(page.locator('h1')).toHaveText('Music around Truckee');
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: /^Music/ }).click();
    await expect(page.locator('h1')).toHaveText('Around Truckee this week');
  });
  test('the rail shows from 1024 px, the floating Filters button below it', async ({ page }, info) => {
    await page.clock.install({ time: NOW });
    await page.goto('/');
    const desktop = info.project.name.startsWith('desktop');
    await expect(page.locator('aside.rail')).toBeVisible({ visible: desktop });
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible({ visible: !desktop });
    if (desktop) {
      const w = await page.locator('aside.rail').evaluate((e) => Math.round(e.getBoundingClientRect().width));
      expect(w).toBe(260);
    }
  });
  test('seven day heads, an empty Saturday, and 26 more through Nov 11', async ({ page }) => {
    await page.clock.install({ time: NOW });
    await page.goto('/');
    await expect(page.locator('.days > .day')).toHaveCount(7);
    await expect(page.getByText('Nothing listed yet. Organizers:')).toHaveCount(1);
    await expect(page.getByText('26 more through Nov 11')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show the rest (20 more)' })).toBeVisible();
  });
  test('the sheet opens from a row', async ({ page }) => {
    await page.clock.install({ time: NOW });
    await page.goto('/');
    await page.locator('button.drow').first().click();
    await expect(page.getByRole('dialog', { name: 'Event details' })).toBeVisible();
  });
});
