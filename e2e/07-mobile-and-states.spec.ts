import { expect, test } from '@playwright/test';
import { INTERN_A, OWNER_EMAIL, signIn, watchForPageErrors } from './helpers';

/**
 * Acceptance flow 7: empty states, validation errors, permission denials,
 * mobile navigation, keyboard access, and the absence of unexpected console
 * errors or failed requests on the happy paths.
 *
 * This file runs in both the desktop and the mobile Playwright projects.
 */

test.describe.configure({ mode: 'serial' });

const INTERN_PAGES = [
  '/overview',
  '/leads',
  '/linkedin',
  '/follow-ups',
  '/meetings',
  '/training',
  '/profile',
];

const ADMIN_PAGES = [
  '/admin',
  '/admin/leads',
  '/admin/leads/import',
  '/admin/interns',
  '/admin/meetings',
  '/admin/targets',
  '/admin/resources',
  '/admin/settings',
];

test('every intern page loads with no console errors or failed requests', async ({ page }) => {
  const watcher = watchForPageErrors(page);
  await signIn(page, INTERN_A);

  for (const path of INTERN_PAGES) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBeLessThan(400);
    await expect(page.locator('main')).toBeVisible();
    // Exactly one h1 per page.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  }

  expect(watcher.consoleErrors, 'console errors').toEqual([]);
  expect(watcher.failedRequests, 'failed requests').toEqual([]);
});

test('every admin page loads with no console errors or failed requests', async ({ page }) => {
  const watcher = watchForPageErrors(page);
  await signIn(page, OWNER_EMAIL);

  for (const path of ADMIN_PAGES) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBeLessThan(400);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  }

  expect(watcher.consoleErrors, 'console errors').toEqual([]);
  expect(watcher.failedRequests, 'failed requests').toEqual([]);
});

test('the page never scrolls sideways', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  for (const path of ['/admin', '/admin/leads', '/admin/meetings']) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // Wide tables scroll inside their own container, not the document.
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});

test('mobile navigation opens, navigates, and closes', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile navigation only renders below the md breakpoint.');
  await signIn(page, INTERN_A);
  await page.goto('/overview');

  const toggle = page.getByTestId('mobile-nav-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const panel = page.locator('#mobile-nav-panel');
  await panel.getByRole('link', { name: 'Follow-ups' }).click();
  await expect(page).toHaveURL(/\/follow-ups/);
  // The disclosure closes itself on navigation.
  await expect(page.getByTestId('mobile-nav-toggle')).toHaveAttribute('aria-expanded', 'false');

  // Escape closes it too.
  await page.getByTestId('mobile-nav-toggle').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mobile-nav-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('the log-outreach form is usable on a small screen', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Desktop layout is covered elsewhere.');
  await signIn(page, INTERN_A);
  await page.goto('/leads');
  const link = page.locator('a[href^="/leads/"]').first();
  await expect(link).toBeVisible();
  await link.click();

  const form = page.getByRole('heading', { name: 'Log outreach' });
  await expect(form).toBeVisible();
  const action = page.getByLabel('What did you do?');
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeLessThanOrEqual(viewport.width);
  await expect(page.getByRole('button', { name: 'Log it' })).toBeVisible();
});

test('empty states explain what to do next', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);

  // A filter that matches nothing.
  await page.goto('/admin/leads?q=zzz-no-such-club-zzz');
  await expect(page.getByText('No clubs match those filters')).toBeVisible();
  await expect(page.getByText(/widen the filters/i)).toBeVisible();

  // A filter view is bookmarkable: reloading keeps the same result.
  await page.reload();
  await expect(page.getByText('No clubs match those filters')).toBeVisible();
  await expect(page.getByLabel('Search')).toHaveValue('zzz-no-such-club-zzz');
});

test('validation errors are shown inline and keep what was typed', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/interns');

  await page.getByLabel('Email address').fill('not-an-email');
  await page.getByRole('button', { name: /create profile/i }).click();

  await expect(page.getByText(/enter a valid email address/i).first()).toBeVisible();
  // The typed value survives the rejected submission.
  await expect(page.getByLabel('Email address')).toHaveValue('not-an-email');
});

test('a permission denial is a styled page, not a crash', async ({ page }) => {
  await signIn(page, INTERN_A);
  const response = await page.goto('/admin/settings');
  expect(response?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/denied/);
  await expect(page.getByText(/you do not have permission/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /back to your workspace/i })).toBeVisible();
});

test('a missing record returns a 404 rather than an error page', async ({ page }) => {
  await signIn(page, INTERN_A);
  const response = await page.goto('/leads/00000000-0000-0000-0000-000000000000');
  expect(response?.status()).toBe(404);
});

test('key interactions are reachable by keyboard with a visible focus ring', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Keyboard navigation is asserted on desktop.');
  await signIn(page, INTERN_A);
  await page.goto('/overview');

  // The first Tab lands on the skip link, which is a real, working link.
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: /skip to main content/i });
  await expect(skip).toBeFocused();

  // Focus is visibly styled rather than removed — read while still focused.
  const focusRing = await skip.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusRing.style).not.toBe('none');
  expect(focusRing.width).not.toBe('0px');

  await skip.press('Enter');
  await expect(page).toHaveURL(/#main/);

  // Tabbing continues into the navigation.
  await page.goto('/leads');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
  expect(['A', 'BUTTON', 'INPUT', 'SELECT']).toContain(focused);
});

test('missing contact details read as "Not available", never a broken action', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads?contactability=none');

  const rows = await page.getByRole('row').count();
  test.skip(rows < 2, 'Every club in this dataset has a contactable detail.');
  await expect(page.getByText('Not available').first()).toBeVisible();
});

test('an unsafe imported link is never rendered as a live anchor', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads?q=Bend Basketball');
  const rows = await page.getByRole('row').count();
  test.skip(rows < 2, 'The unsafe-link fixture is not in this dataset.');

  // Match the club link by name: `a[href^="/admin/leads/"]` also matches the
  // "Import CSV" button at /admin/leads/import.
  await page.getByRole('link', { name: 'Bend Basketball Association' }).click();
  // The value is shown as text, flagged, and is not an anchor.
  await expect(page.getByText(/not a safe link/i)).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
});
