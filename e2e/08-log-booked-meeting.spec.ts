import { expect, test } from '@playwright/test';
import { INTERN_B, localDateTime, OWNER_EMAIL, signIn } from './helpers';

/**
 * Acceptance flow 8: an intern logs a booked meeting from the Meetings tab,
 * it waits in the admin approval queue, and approving it schedules it.
 * Approval alone earns nothing.
 */

test.describe.configure({ mode: 'serial' });

const WHO = 'Casey Booking-Flow';
const MEET = 'https://meet.google.com/abc-defg-hij';

test('an intern logs a booked meeting and it waits for approval', async ({ page }) => {
  await signIn(page, INTERN_B);
  await page.goto('/meetings');

  await page.getByRole('button', { name: 'Log a booked meeting' }).click();
  await page.getByLabel(/who is the meeting with/i).fill(WHO);
  await page.getByLabel(/^when/i).fill(localDateTime(60 * 24 * 2));
  await page.getByLabel(/google meet link/i).fill(MEET);
  await page.getByLabel(/how did you reach them/i).selectOption('linkedin');
  await page
    .getByLabel(/what do you know about them/i)
    .fill('Runs a 14U travel team, looking for scheduling software.');
  await page.getByRole('button', { name: 'Send for approval' }).click();

  await expect(page.getByText(/sent to an admin for approval/i)).toBeVisible();

  await page.goto('/meetings');
  const awaiting = page.getByRole('heading', { name: /^awaiting approval \(\d+\)/i });
  await expect(awaiting).toContainText('(1)');
  await expect(page.getByText(WHO)).toBeVisible();
  await expect(page.getByText(/reached via linkedin/i)).toBeVisible();
  // Not approved yet, so there is nothing to mark as held.
  await expect(page.getByRole('button', { name: 'Mark as held' })).toHaveCount(0);
});

test('a meeting link that is not http(s) is refused', async ({ page }) => {
  await signIn(page, INTERN_B);
  await page.goto('/meetings');

  await page.getByRole('button', { name: 'Log a booked meeting' }).click();
  await page.getByLabel(/who is the meeting with/i).fill('Mallory Link');
  await page.getByLabel(/^when/i).fill(localDateTime(60 * 24));
  await page.getByLabel(/google meet link/i).fill('javascript:alert(1)');
  await page.getByLabel(/how did you reach them/i).selectOption('email');
  await page.getByRole('button', { name: 'Send for approval' }).click();

  await expect(page.getByText(/check the meeting link/i)).toBeVisible();
});

test('an admin sees the details and approves it', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/meetings');

  const row = page.getByRole('row').filter({ hasText: WHO });
  await expect(row).toContainText('LinkedIn');
  await expect(row).toContainText(/14u travel team/i);
  await expect(row.getByRole('link', { name: 'Meeting link' })).toHaveAttribute('href', MEET);

  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect
    .poll(async () => {
      await page.goto('/admin/meetings');
      return page.getByRole('row').filter({ hasText: WHO }).count();
    })
    // It leaves the approval queue and appears once, under Scheduled.
    .toBe(1);
});

test('once approved, the intern can mark it held', async ({ page }) => {
  await signIn(page, INTERN_B);
  await page.goto('/meetings');

  await expect(page.getByRole('heading', { name: /^awaiting approval \(0\)/i })).toBeVisible();
  const upcoming = page.getByRole('row').filter({ hasText: WHO });
  await expect(upcoming.getByRole('button', { name: 'Mark as held' })).toBeVisible();
});
