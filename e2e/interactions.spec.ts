// R1c interactions: the date picker, the event sheet (close paths, focus return, width, reduced motion), the filter sheet, search and Kind.
import { expect, test, type Page } from '@playwright/test';

const NOW = new Date('2026-10-15T15:00:00Z'); // Thu Oct 15, 8:00 am PDT
const PICKED = '00000000-0000-4000-8000-000000000005';

async function open(page: Page, url = '/') {
  await page.clock.install({ time: NOW });
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(250); // the clock ticks and the URL filters apply after hydration
}
/** The floating button appears once the finder has scrolled away. */
async function openFilters(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.getByRole('button', { name: /^Filters/ }).click();
}
const isPhone = (name: string) => name.startsWith('phone');

test('AC-R1c-04 the date input is bounded to today..today+120 and sets when=date:', async ({ page }) => {
  await open(page);
  const input = page.locator('input[type="date"]');
  await expect(input).toHaveAttribute('min', '2026-10-15');
  await expect(input).toHaveAttribute('max', '2027-02-12');
  await input.fill('2026-10-17');
  await expect(page).toHaveURL(/[?&]when=date:2026-10-17(&|$)/);
  await expect(page.locator('label.datepick')).toContainText('Sat Oct 17');
  await expect(page.locator('label.datepick')).toHaveClass(/on/);
});

test.describe('AC-R1c-11 the event sheet', () => {
  const row = (page: Page) => page.locator('button.drow').first();
  const dialog = (page: Page) => page.getByRole('dialog', { name: 'Event details' });

  test('closes by Escape, X, scrim click and (phone) a 120 px handle drag; focus returns to the row each time', async ({ page }, info) => {
    await open(page);
    const r = row(page);
    const reopen = async () => {
      await r.click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page)).toHaveClass(/in/);
      await page.waitForTimeout(350); // let the slide-in finish before measuring the handle
    };

    await reopen();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(r).toBeFocused();

    await reopen();
    await page.getByRole('button', { name: 'Close event details' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(r).toBeFocused();

    await reopen();
    await page.locator('.scrim').click({ position: { x: 20, y: 20 } });
    await expect(dialog(page)).toHaveCount(0);
    await expect(r).toBeFocused();

    if (isPhone(info.project.name)) {
      await reopen();
      const box = (await page.locator('.grab').boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 60, { steps: 6 });
      await page.mouse.move(x, y + 120, { steps: 6 });
      await page.mouse.up();
      await expect(dialog(page)).toHaveCount(0);
      await expect(r).toBeFocused();

      // A short, slow drag springs back instead of closing.
      await reopen();
      const box2 = (await page.locator('.grab').boundingBox())!;
      await page.mouse.move(box2.x + box2.width / 2, box2.y + 20);
      await page.mouse.down();
      await page.mouse.move(box2.x + box2.width / 2, box2.y + 50, { steps: 3 });
      await page.waitForTimeout(400);
      await page.mouse.up();
      await expect(dialog(page)).toBeVisible();
    }
  });

  test('the desktop panel is 520 px wide and full height; the phone sheet starts 72 px from the top', async ({ page }, info) => {
    await open(page);
    await row(page).click();
    await expect(dialog(page)).toHaveClass(/in/);
    await page.waitForTimeout(300);
    const b = (await dialog(page).boundingBox())!;
    if (isPhone(info.project.name)) {
      expect(Math.round(b.y)).toBe(72);
      expect(Math.round(b.width)).toBe(390);
    } else {
      expect(Math.round(b.width)).toBe(520);
      expect(Math.round(b.height)).toBe(900);
      expect(Math.round(b.x + b.width)).toBe(1440);
    }
    await expect(page.locator('.scrim')).toBeVisible();
    const handle = page.locator('.grab');
    await expect(handle).toBeVisible({ visible: isPhone(info.project.name) });
  });

  test('a picked event shows Our pick and its line; the Also on date opens that event', async ({ page }) => {
    await open(page, `/?event=${PICKED}`);
    await expect(dialog(page)).toContainText('Our pick');
    await expect(dialog(page)).toContainText('Example pick line one.');
    await expect(dialog(page).locator('dt')).toHaveText(['Where', 'Price', 'Ages', 'Listed by']);
  });

  test('the Also on dates of a series open the other occurrences', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /Example Sunday Market/ }).first().click();
    await expect(dialog(page)).toContainText('Also on');
    await expect(dialog(page).locator('dd').nth(3)).toHaveText('Oct 25, Nov 1, Nov 8');
    await dialog(page).getByRole('button', { name: 'Nov 1' }).click();
    await expect(page).toHaveURL(/event=/);
    await expect(dialog(page).locator('.dchip')).toContainText('NOV');
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('the sheet has no transition', async ({ page }) => {
      await open(page);
      await row(page).click();
      const d = await dialog(page).evaluate((el) => getComputedStyle(el).transitionDuration);
      expect(d).toBe('0s');
    });
  });
  test('with motion allowed the sheet slides on the motion token', async ({ page }) => {
    await open(page);
    await row(page).click();
    const d = await dialog(page).evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(d).toBe('0.18s');
  });
});

test.describe('AC-R1c-14 the filter sheet (phone)', () => {
  test.beforeEach(({}, info) => test.skip(!isPhone(info.project.name), 'phone only'));

  test('"Show 9 events" for when=7d; tapping it closes the sheet', async ({ page }) => {
    await open(page, '/?when=7d');
    await openFilters(page);
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await expect(sheet).toBeVisible();
    const show = sheet.getByRole('button', { name: 'Show 9 events' });
    await expect(show).toBeVisible();
    await show.click();
    await expect(sheet).toHaveCount(0);
  });
  test('"Show 1 event" when one matches', async ({ page }) => {
    await open(page, '/?when=7d&kids=1');
    await page.getByRole('button', { name: 'More areas' }).click(); // a one-row page never scrolls the finder away
    await expect(page.getByRole('dialog', { name: 'Filters' }).getByRole('button', { name: 'Show 1 event', exact: true })).toBeVisible();
  });
  test('Kind chips and the Kids switch change the count; More areas opens the sheet', async ({ page }) => {
    await open(page, '/?when=7d');
    await page.getByRole('button', { name: 'More areas' }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await sheet.getByRole('button', { name: 'Music', exact: true }).click();
    await expect(sheet.getByRole('button', { name: /^Show \d+ events?$/ })).not.toHaveText('Show 9 events');
    await expect(page).toHaveURL(/cat=music/);
    await sheet.getByRole('switch', { name: 'Kids OK' }).click();
    await expect(page).toHaveURL(/kids=1/);
    await sheet.getByRole('button', { name: 'Clear all' }).click();
    await expect(page).not.toHaveURL(/cat=|kids=|when=/);
  });
});

test.describe('the finder', () => {
  test('search narrows the list after 250 ms and writes ?q=', async ({ page }) => {
    await open(page);
    await page.getByRole('searchbox', { name: 'Search events' }).fill('Sunday Market');
    await expect(page).toHaveURL(/[?&]q=Sunday\+Market/);
    const titles = await page.locator('button.drow strong').allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t === 'Example Sunday Market')).toBe(true);
    await page.getByRole('searchbox', { name: 'Search events' }).fill('');
    await expect(page).not.toHaveURL(/q=/);
  });
  test('pill counts: Today 1, Next 7 days 9 (This weekend 5 on desktop)', async ({ page }, info) => {
    await open(page);
    await expect(page.getByRole('button', { name: 'Today 1' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next 7 days 9' })).toBeVisible();
    await expect(page.getByRole('button', { name: isPhone(info.project.name) ? 'Weekend 5' : 'This weekend 5' })).toBeVisible();
  });
  test('desktop: Free only and Kids OK are switches with counts; the rail Kind boxes bind to cat', async ({ page }, info) => {
    test.skip(isPhone(info.project.name), 'desktop only');
    await open(page);
    await expect(page.getByRole('switch', { name: 'Free only 0' })).toBeVisible();
    const kids = page.getByRole('switch', { name: 'Kids OK 1' });
    await kids.click();
    await expect(kids).toHaveAttribute('aria-checked', 'true');
    await expect(page).toHaveURL(/kids=1/);
    await kids.click();
    await page.locator('aside.rail li label', { hasText: /^Music/ }).click();
    await expect(page).toHaveURL(/cat=music/);
    await expect(page.locator('aside.rail li label', { hasText: /^Music/ }).locator('input')).toBeChecked();
  });
  test('phone: Free / Kids / area chips with counts', async ({ page }, info) => {
    test.skip(!isPhone(info.project.name), 'phone only');
    await open(page);
    const row = page.getByRole('group', { name: 'Narrow it down' });
    await expect(row.getByRole('button')).toHaveText(['Free 0', 'Kids 1', 'Truckee 22', 'Incline 13', 'More areas']);
    await row.getByRole('button', { name: 'Truckee 22' }).click();
    await expect(page).toHaveURL(/area=truckee/);
    await expect(row.getByRole('button', { name: /^Truckee/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
