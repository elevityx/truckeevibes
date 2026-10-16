// Visual check protocol (VC): each web PR appends its routes and states here.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const NOW = new Date('2026-10-15T15:00:00Z'); // Thu Oct 15, 8:00 am PDT

/** Routes covered so far. `admin` keeps its own look, so its focus ring is its own --focus token. */
const ROUTES: { path: string; name: string; admin?: boolean }[] = [
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
