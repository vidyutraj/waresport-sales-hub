import { expect, test, type Page } from '@playwright/test';
import { INTERN_A, localDateTime, OWNER_EMAIL, signIn, statValue } from './helpers';

/**
 * Acceptance flow 5: an intern books a meeting, submits it as held, an admin
 * verifies it, and earnings update correctly. Includes the tenth verified
 * meeting crossing the $100 milestone, the manual payout, and persistence
 * across a refresh and a brand-new session.
 */

test.describe.configure({ mode: 'serial' });

/** Book a meeting on the intern's Nth assigned club and submit it as held. */
async function bookAndSubmit(page: Page, index: number): Promise<void> {
  await page.goto(`/leads?page=1`);
  const links = page.locator('a[href^="/leads/"]');
  const count = await links.count();
  const href = await links.nth(index % count).getAttribute('href');
  await page.goto(href!);

  await page.getByRole('button', { name: 'Book a meeting' }).click();
  await page.getByLabel('Scheduled start').fill(localDateTime(-24 * 60));
  await page.getByRole('button', { name: 'Book meeting' }).click();
  await expect(page.getByText(/it earns nothing until it has taken place/i)).toBeVisible();

  await page.goto('/meetings');
  const pending = page.getByRole('heading', { name: /^awaiting verification \(\d+\)/i });
  const before = Number(/\((\d+)\)/.exec(await pending.innerText())?.[1] ?? '0');

  await page.getByRole('button', { name: 'Mark as held' }).first().click();
  await page.getByLabel(/when did it actually take place/i).fill(localDateTime(-120));
  await page.getByRole('button', { name: 'Submit for verification' }).click();

  // The page revalidates and the meeting moves into the verification queue,
  // which is the outcome worth asserting (the inline notice goes with it).
  await expect
    .poll(async () => {
      await page.goto('/meetings');
      return Number(/\((\d+)\)/.exec(await pending.innerText())?.[1] ?? '0');
    })
    .toBe(before + 1);
}

/**
 * Verify one queued meeting as an admin.
 *
 * Asserts the queue actually shrinks rather than looking for a toast: the row
 * (and its inline confirmation) is removed by the revalidation that follows.
 */
async function verifyOnePending(page: Page): Promise<void> {
  await page.goto('/admin/meetings');
  const queue = page.getByRole('heading', { name: /^verification queue \(\d+\)/i });
  const before = Number(/\((\d+)\)/.exec(await queue.innerText())?.[1] ?? '0');
  expect(before).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Verify held' }).first().click();
  await expect
    .poll(async () => {
      await page.goto('/admin/meetings');
      return Number(/\((\d+)\)/.exec(await queue.innerText())?.[1] ?? '0');
    })
    .toBe(before - 1);
}

test('booking a meeting earns nothing until it is verified', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/meetings');
  const earnedBefore = await statValue(page, 'Earned');
  expect(earnedBefore).toBe(0);

  await bookAndSubmit(page, 0);

  await page.goto('/meetings');
  expect(await statValue(page, 'Verified held meetings')).toBe(0);
  expect(await statValue(page, 'Earned')).toBe(0);
  await expect(page.getByText(/awaiting admin verification/i)).toBeVisible();
});

test('an intern cannot verify their own meeting', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/meetings');
  // No verification control exists anywhere in the intern workspace.
  await expect(page.getByRole('button', { name: /verify held/i })).toHaveCount(0);
});

test('a held time in the future is refused', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/leads');
  const href = await page.locator('a[href^="/leads/"]').nth(1).getAttribute('href');
  await page.goto(href!);
  await page.getByRole('button', { name: 'Book a meeting' }).click();
  await page.getByLabel('Scheduled start').fill(localDateTime(60 * 24));
  await page.getByRole('button', { name: 'Book meeting' }).click();
  await expect(page.getByText(/it earns nothing until it has taken place/i)).toBeVisible();

  await page.goto('/meetings');
  await page.getByRole('button', { name: 'Mark as held' }).first().click();
  await page.getByLabel(/when did it actually take place/i).fill(localDateTime(60 * 24));
  await page.getByRole('button', { name: 'Submit for verification' }).click();
  await expect(page.getByText(/cannot be recorded as held in the future/i)).toBeVisible();
});

test('an admin verifies a held meeting and the intern sees the credit', async ({
  page,
  context,
}) => {
  await signIn(page, OWNER_EMAIL);
  await verifyOnePending(page);

  const internContext = await context.browser()!.newContext();
  const internPage = await internContext.newPage();
  await signIn(internPage, INTERN_A);
  await internPage.goto('/meetings');
  expect(await statValue(internPage, 'Verified held meetings')).toBe(1);
  expect(await statValue(internPage, 'Earned')).toBe(0);
  await expect(internPage.getByText(/9 more verified meetings to your first \$100/i)).toBeVisible();
  await internContext.close();
});

test('the tenth verified meeting crosses the $100 milestone', async ({ page, context }) => {
  const internContext = await context.browser()!.newContext();
  const internPage = await internContext.newPage();
  await signIn(internPage, INTERN_A);

  // Book and submit nine more, so ten are held in total.
  for (let i = 1; i <= 9; i += 1) {
    await bookAndSubmit(internPage, i);
  }

  await signIn(page, OWNER_EMAIL);
  for (let i = 0; i < 9; i += 1) {
    await verifyOnePending(page);
  }

  await internPage.goto('/meetings');
  expect(await statValue(internPage, 'Verified held meetings')).toBe(10);
  expect(await statValue(internPage, 'Earned')).toBe(100);

  // The display is honest at exactly ten: earned, and a fresh 0/10 to go.
  await expect(
    internPage.getByText('$100 earned; 0/10 toward your next $100').first(),
  ).toBeVisible();
  await expect(internPage.getByText('10 to go')).toBeVisible();
  await internContext.close();
});

test('an admin records the $100 payout, and it cannot be recorded twice', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/meetings');

  const row = page.getByRole('row').filter({ hasText: 'Erin' });
  await row.getByRole('button', { name: /record \$100 paid/i }).click();
  await page.getByLabel('Paid on').fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel('Payment reference').fill('BANK-0001');
  await page.getByRole('button', { name: 'Record payment' }).click();

  // The form is replaced by the revalidated row, so assert the outcome: the
  // milestone leaves the unrecorded list and appears in the ledger.
  await expect
    .poll(async () => {
      await page.goto('/admin/meetings');
      return page.getByRole('row').filter({ hasText: 'Erin' }).first().innerText();
    })
    .toMatch(/all earned milestones recorded/i);

  await expect(page.getByRole('cell', { name: 'BANK-0001' })).toBeVisible();
  // There is no second control offering to pay the same milestone again.
  await expect(page.getByRole('button', { name: /record \$100 paid/i })).toHaveCount(0);
});

test('earnings persist across a refresh and a brand-new session', async ({ page, context }) => {
  await signIn(page, INTERN_A);
  await page.goto('/meetings');
  expect(await statValue(page, 'Earned')).toBe(100);
  expect(await statValue(page, 'Recorded as paid')).toBe(100);

  await page.reload();
  expect(await statValue(page, 'Earned')).toBe(100);

  const fresh = await context.browser()!.newContext();
  const freshPage = await fresh.newPage();
  await signIn(freshPage, INTERN_A);
  await freshPage.goto('/meetings');
  expect(await statValue(freshPage, 'Earned')).toBe(100);
  expect(await statValue(freshPage, 'Verified held meetings')).toBe(10);
  await expect(freshPage.getByRole('cell', { name: 'BANK-0001' })).toBeVisible();
  await fresh.close();
});

test('a weekly date filter never changes cumulative compensation', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin');
  const earnedAll = await statValue(page, 'Earned across cohort');

  // A one-day window that contains almost no activity.
  const day = new Date().toISOString().slice(0, 10);
  await page.goto(`/admin?from=${day}&to=${day}`);
  expect(await statValue(page, 'Earned across cohort')).toBe(earnedAll);
  await expect(page.getByText(/lifetime, not period/i)).toBeVisible();
});

test('reversing a verification recalculates earnings but keeps the payout', async ({
  page,
  context,
}) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/meetings');

  // Scope to one row: every verified meeting has its own "Reverse
  // verification" control, so an unscoped .last() would hit another row.
  const verified = page.locator('section', {
    has: page.getByRole('heading', { name: /^verified meetings/i }),
  });
  const row = verified.getByRole('row').filter({ hasText: 'Erin' }).first();

  await row.getByRole('button', { name: 'Reverse verification' }).click();
  await row
    .getByLabel(/why are you reversing this/i)
    .fill('Prospect says the call never happened.');
  await row.getByRole('button', { name: 'Confirm reversal' }).click();

  // The row leaves the verified list and the reconciliation banner appears,
  // which is the durable evidence (the inline notice goes with the row).
  await expect
    .poll(async () => {
      await page.goto('/admin/meetings');
      return page.getByText(/reconciliation needed/i).count();
    })
    .toBeGreaterThan(0);
  await expect(page.getByText(/the payment record is intentionally preserved/i)).toBeVisible();

  const internContext = await context.browser()!.newContext();
  const internPage = await internContext.newPage();
  await signIn(internPage, INTERN_A);
  await internPage.goto('/meetings');

  expect(await statValue(internPage, 'Verified held meetings')).toBe(9);
  expect(await statValue(internPage, 'Earned')).toBe(0);
  // The payment record survives, and the shortfall is shown rather than hidden.
  expect(await statValue(internPage, 'Recorded as paid')).toBe(100);
  await expect(internPage.getByText(/a payout needs reconciling/i)).toBeVisible();
  // The ledger entry itself is still there, not deleted.
  await expect(internPage.getByRole('cell', { name: 'BANK-0001' })).toBeVisible();
  await internContext.close();
});
