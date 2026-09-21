import { expect, test } from '@playwright/test';
import { INTERN_A, INTERN_B, OWNER_EMAIL, parseCsvLine, signIn, statValue } from './helpers';

/**
 * Acceptance flow 6: an admin changes a target and reassigns a club.
 * Historical contributions stay correct, and the new access boundaries take
 * effect immediately.
 */

test.describe.configure({ mode: 'serial' });

test('changing a cohort target updates the intern goal without rewriting history', async ({
  page,
  context,
}) => {
  const internContext = await context.browser()!.newContext();
  const internPage = await internContext.newPage();
  await signIn(internPage, INTERN_A);
  await internPage.goto('/overview');

  // Read the current week number and its email target.
  const weekLabel = await internPage
    .getByText(/^Week \d+ ·/)
    .first()
    .innerText();
  const weekNumber = Number(/Week (\d+)/.exec(weekLabel)?.[1] ?? '1');
  const meter = internPage.getByText('Emails sent').locator('xpath=../..');
  const before = await meter.innerText();
  const [, achieved, oldTarget] = /(\d+)\s*\/\s*(\d+)/.exec(before.replace(/\s+/g, ' ')) ?? [];

  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/targets');
  const editor = page.locator('section', {
    has: page.getByRole('heading', { name: /set a cohort default target/i }),
  });
  await editor.locator('#t-week-default').selectOption(String(weekNumber));
  await editor.locator('#t-email-default').fill('42');
  await editor.locator('#t-reason-default').fill('Reduced target for the acceptance run.');
  await editor.getByRole('button', { name: 'Save target' }).click();
  await expect(page.getByText(/weeks that have already ended keep the target/i)).toBeVisible();

  // The intern sees the new denominator; their achieved count is untouched.
  await internPage.reload();
  const after = await internPage.getByText('Emails sent').locator('xpath=../..').innerText();
  const [, achievedAfter, newTarget] = /(\d+)\s*\/\s*(\d+)/.exec(after.replace(/\s+/g, ' ')) ?? [];
  expect(newTarget).toBe('42');
  expect(newTarget).not.toBe(oldTarget);
  expect(achievedAfter).toBe(achieved);

  await internContext.close();
});

test('an intern cannot change their own target', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/admin/targets');
  await expect(page).toHaveURL(/\/denied/);
});

test('reassigning a club moves access but not credit', async ({ page, context }) => {
  // Find a club Erin owns that she has actually worked.
  const erinContext = await context.browser()!.newContext();
  const erinPage = await erinContext.newPage();
  await signIn(erinPage, INTERN_A);
  await erinPage.goto('/leads?sort=recent');
  const href = await erinPage.locator('a[href^="/leads/"]').first().getAttribute('href');
  const clubId = href!.split('/').pop()!;

  await erinPage.goto(href!);
  const clubName = await erinPage.getByRole('heading', { level: 1 }).innerText();
  const erinEmailsBefore = await (async () => {
    await erinPage.goto('/overview');
    const text = await erinPage.getByText('Emails sent').locator('xpath=../..').innerText();
    return Number(/(\d+)\s*\/\s*\d+/.exec(text.replace(/\s+/g, ' '))?.[1] ?? '0');
  })();

  // Admin reassigns it to Wes, with the required cross-territory reason.
  await signIn(page, OWNER_EMAIL);
  await page.goto(`/admin/leads?q=${encodeURIComponent(clubName)}`);
  await page.getByRole('checkbox', { name: new RegExp(`select ${clubName}`, 'i') }).check();
  await page.getByLabel('Assign to').selectOption({ label: 'Wes (WEST)' });
  const override = page.getByLabel(/override reason/i);
  if (await override.isVisible().catch(() => false)) {
    await override.fill('Handover for the acceptance run.');
  }
  await page.getByRole('button', { name: /^Assign 1$/ }).click();
  await expect(page.getByText(/historical contributions are unchanged/i)).toBeVisible();

  // Erin keeps her credit ...
  await erinPage.goto('/overview');
  const erinEmailsAfter = Number(
    /(\d+)\s*\/\s*\d+/.exec(
      (await erinPage.getByText('Emails sent').locator('xpath=../..').innerText()).replace(
        /\s+/g,
        ' ',
      ),
    )?.[1] ?? '0',
  );
  expect(erinEmailsAfter).toBe(erinEmailsBefore);

  // ... and can still see her own history on the club, with a clear notice ...
  await erinPage.goto(`/leads/${clubId}`);
  await expect(erinPage.getByText(/you no longer own this club/i)).toBeVisible();
  await expect(erinPage.getByRole('heading', { name: 'Activity timeline' })).toBeVisible();
  // ... but the live contact details are gone, and she cannot log new outreach.
  await expect(
    erinPage.getByText(/only the current owner of a club can see its contact details/i),
  ).toBeVisible();
  await expect(erinPage.getByRole('heading', { name: 'Log outreach' })).toHaveCount(0);

  // Wes now owns it and sees the previous owner's history.
  const wesContext = await context.browser()!.newContext();
  const wesPage = await wesContext.newPage();
  await signIn(wesPage, INTERN_B);
  await wesPage.goto(`/leads/${clubId}`);
  await expect(wesPage.getByRole('heading', { name: 'Log outreach' })).toBeVisible();
  await expect(wesPage.getByRole('heading', { name: 'Activity timeline' })).toBeVisible();
  // Another intern's work is attributed but not personally identified.
  await expect(wesPage.getByRole('cell', { name: 'Another team member' }).first()).toBeVisible();

  await erinContext.close();
  await wesContext.close();
});

test('deactivating an intern blocks access immediately but keeps their work', async ({
  page,
  context,
}) => {
  const wesContext = await context.browser()!.newContext();
  const wesPage = await wesContext.newPage();
  await signIn(wesPage, INTERN_B);
  await wesPage.goto('/overview');
  await expect(wesPage.getByRole('heading', { name: /welcome, wes/i })).toBeVisible();

  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/interns');
  const row = page.getByRole('row').filter({ hasText: INTERN_B });
  await row.getByRole('button', { name: 'Deactivate' }).click();
  await row.getByRole('button', { name: 'Confirm' }).click();
  await expect
    .poll(async () => {
      await page.goto('/admin/interns');
      return page.getByRole('row').filter({ hasText: INTERN_B }).first().innerText();
    })
    .toMatch(/deactivated/i);

  // The existing session stops working on the very next request.
  await wesPage.goto('/overview');
  await expect(wesPage).toHaveURL(/\/sign-in/);

  // Their historical work is still attributed to them for an admin.
  await page.goto('/admin/interns');
  await page.getByRole('link', { name: /wes/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Activity timeline' })).toBeVisible();

  // Reactivate so later runs are unaffected.
  await page.goto('/admin/interns');
  await page
    .getByRole('row')
    .filter({ hasText: INTERN_B })
    .getByRole('button', { name: 'Reactivate' })
    .click();
  await expect
    .poll(async () => {
      await page.goto('/admin/interns');
      return page.getByRole('row').filter({ hasText: INTERN_B }).first().innerText();
    })
    .toMatch(/active/i);

  await wesContext.close();
});

test('only the owner can grant the admin role', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/interns');

  // The owner sees the control ...
  const row = page.getByRole('row').filter({ hasText: INTERN_B });
  await expect(row.getByRole('button', { name: 'Change role' })).toBeVisible();

  // ... and a reason is mandatory.
  await row.getByRole('button', { name: 'Change role' }).click();
  await expect(row.getByLabel(/reason for the role change/i)).toBeVisible();
});

test('the admin CSV export matches the dashboard numbers', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin');
  const verified = await statValue(page, 'Earned across cohort');

  const response = await page.request.get('/api/exports/interns');
  expect(response.status()).toBe(200);
  const csv = await response.text();
  expect(csv).toContain('intern,email,status,territory');

  // The exported earned column sums to the dashboard's figure, parsed as real
  // CSV (period labels contain commas and are therefore quoted).
  const rows = csv
    .replace(/^\ufeff/, '')
    .trim()
    .split('\r\n')
    .map(parseCsvLine);
  const header = rows[0]!;
  const earnedIndex = header.indexOf('earned_usd');
  expect(earnedIndex).toBeGreaterThan(-1);
  const total = rows.slice(1).reduce((sum, row) => sum + Number(row[earnedIndex] ?? 0), 0);
  expect(total).toBe(verified);

  // Every intern in the cohort appears exactly once.
  expect(rows.length - 1).toBe(2);
});
