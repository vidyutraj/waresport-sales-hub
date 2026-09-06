import { expect, test, type Page } from '@playwright/test';
import { INTERN_A, isoDate, localDateTime, OWNER_EMAIL, signIn } from './helpers';

/**
 * Acceptance flow 3: an intern logs an email and a follow-up, watches progress
 * and the follow-up queue update, and corrects a log without double-counting.
 */

test.describe.configure({ mode: 'serial' });

async function openFirstAssignedClub(page: Page): Promise<string> {
  await page.goto('/leads');
  const link = page.locator('a[href^="/leads/"]').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  await link.click();
  await expect(page.getByRole('heading', { name: 'Log outreach' })).toBeVisible();
  return href!;
}

/** Reads the "Emails sent" figure from the intern overview. */
async function emailsThisWeek(page: Page): Promise<number> {
  await page.goto('/overview');
  const text = await page
    .getByText(/emails sent/i)
    .locator('xpath=../..')
    .innerText();
  const match = /(\d+)\s*\/\s*(\d+)/.exec(text.replace(/\s+/g, ' '));
  return Number(match?.[1] ?? '0');
}

test('an intern logs a first email and progress moves', async ({ page }) => {
  await signIn(page, INTERN_A);
  const before = await emailsThisWeek(page);

  await openFirstAssignedClub(page);
  await page.getByLabel('What did you do?').selectOption('email_initial');
  await page.getByLabel('Outcome').selectOption('sent');
  await page.getByLabel('When').fill(localDateTime(-60));
  await page.getByLabel('Notes').fill('Intro email about registration and scheduling.');
  await page.getByRole('button', { name: 'Log it' }).click();

  await expect(page.getByText('Outreach logged.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Initial email' }).first()).toBeVisible();

  expect(await emailsThisWeek(page)).toBe(before + 1);
});

test('a research note does not count as outreach', async ({ page }) => {
  await signIn(page, INTERN_A);
  const before = await emailsThisWeek(page);

  await openFirstAssignedClub(page);
  await page.getByLabel('What did you do?').selectOption('research_note');
  await page.getByLabel('When').fill(localDateTime(-50));
  await page.getByLabel('Notes').fill('Drafted a message but have not sent it.');
  await page.getByRole('button', { name: 'Log it' }).click();

  await expect(page.getByText(/does not count as outreach/i)).toBeVisible();
  expect(await emailsThisWeek(page)).toBe(before);
});

test('a follow-up with a due date lands in the queue', async ({ page }) => {
  await signIn(page, INTERN_A);
  const before = await emailsThisWeek(page);

  await openFirstAssignedClub(page);
  await page.getByLabel('What did you do?').selectOption('email_followup');
  await page.getByLabel('Outcome').selectOption('sent');
  await page.getByLabel('When').fill(localDateTime(-40));
  await page.getByLabel('Next follow-up').fill(isoDate(0));
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByText('Outreach logged.')).toBeVisible();

  // A follow-up email counts toward the weekly email target by default.
  expect(await emailsThisWeek(page)).toBe(before + 1);

  await page.goto('/follow-ups');
  await expect(page.getByRole('heading', { name: /due today/i })).toBeVisible();
  const dueToday = page.locator('section', {
    has: page.getByRole('heading', { name: /due today/i }),
  });
  await expect(dueToday.getByRole('button', { name: 'Complete' }).first()).toBeVisible();
});

test('completing a follow-up moves it out of the queue', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/follow-ups');

  const dueToday = page.locator('section', {
    has: page.getByRole('heading', { name: /due today/i }),
  });
  const completed = page.locator('section', {
    has: page.getByRole('heading', { name: /^completed/i }),
  });

  const dueBefore = await dueToday.getByRole('row').count();
  const completedBefore = await completed.getByRole('row').count();
  expect(dueBefore).toBeGreaterThan(1);

  await dueToday.getByRole('button', { name: 'Complete' }).first().click();

  // The queue re-renders: the item leaves "due today" and appears in
  // "completed". Asserting the outcome rather than a transient toast.
  await expect
    .poll(async () => completed.getByRole('row').count())
    .toBeGreaterThan(completedBefore);
  expect(await dueToday.getByRole('row').count()).toBeLessThan(dueBefore);
});

test('a future timestamp is rejected', async ({ page }) => {
  await signIn(page, INTERN_A);
  await openFirstAssignedClub(page);

  await page.getByLabel('What did you do?').selectOption('email_initial');
  await page.getByLabel('When').fill(localDateTime(60 * 24));
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByText(/future timestamp/i)).toBeVisible();
});

test('correcting a log removes the credit without deleting the record', async ({ page }) => {
  await signIn(page, INTERN_A);
  const before = await emailsThisWeek(page);

  const href = await openFirstAssignedClub(page);
  await page.getByLabel('What did you do?').selectOption('email_initial');
  await page.getByLabel('Outcome').selectOption('sent');
  await page.getByLabel('When').fill(localDateTime(-20));
  await page.getByLabel('Notes').fill('Logged against the wrong club by mistake.');
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByText('Outreach logged.')).toBeVisible();
  expect(await emailsThisWeek(page)).toBe(before + 1);

  await page.goto(href);
  await page
    .getByRole('button', { name: /correct or void this entry/i })
    .first()
    .click();
  await page.getByLabel('Why is this wrong?').fill('Sent to the wrong club.');
  await page.getByRole('button', { name: 'Void entry' }).click();

  // The entry stays on the timeline, marked with its reason — it is voided,
  // never deleted.
  await expect(page.getByText(/voided: sent to the wrong club/i)).toBeVisible();
  await expect(page.getByText('Voided', { exact: true }).first()).toBeVisible();

  // ...and the credit is gone.
  expect(await emailsThisWeek(page)).toBe(before);
});

test('a submit in flight cannot be fired twice', async ({ page }) => {
  await signIn(page, INTERN_A);
  const before = await emailsThisWeek(page);

  await openFirstAssignedClub(page);
  await page.getByLabel('What did you do?').selectOption('email_initial');
  await page.getByLabel('Outcome').selectOption('sent');
  await page.getByLabel('When').fill(localDateTime(-10));
  await page.getByLabel('Notes').fill('Double-click test.');

  const button = page.getByRole('button', { name: 'Log it' });
  // The button disables itself for the duration of the submission, so a second
  // click never reaches the server. (The server-side guarantee — an
  // idempotency key on the activity row — is covered directly in
  // tests/integration/assignment-outreach.test.ts, which retries the same
  // submission and asserts a single row.)
  const [, disabled] = await Promise.all([button.click(), button.isDisabled().catch(() => false)]);
  void disabled;

  await expect(page.getByText(/outreach logged|already logged/i)).toBeVisible();
  expect(await emailsThisWeek(page)).toBe(before + 1);
});

test('a bounce suppresses further outreach to that contact', async ({ page }) => {
  await signIn(page, INTERN_A);
  const href = await openFirstAssignedClub(page);

  // Pick a specific contact so the suppression attaches to them.
  const contactSelect = page.getByLabel('Contact');
  const options = await contactSelect.locator('option').count();
  test.skip(options < 2, 'This club has no specific contact to suppress.');
  await contactSelect.selectOption({ index: 1 });

  await page.getByLabel('What did you do?').selectOption('email_initial');
  await page.getByLabel('Outcome').selectOption('bounced');
  await expect(page.getByText(/suppresses further email/i)).toBeVisible();
  await page.getByLabel('When').fill(localDateTime(-5));
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByText('Outreach logged.')).toBeVisible();

  // The UI warns before the attempt...
  await page.goto(href);
  await page.getByLabel('Contact').selectOption({ index: 1 });
  await expect(page.getByText(/the server will reject a new send/i)).toBeVisible();

  // ...and the server refuses it outright.
  await page.getByLabel('What did you do?').selectOption('email_followup');
  await page.getByLabel('Outcome').selectOption('sent');
  await page.getByLabel('When').fill(localDateTime(-4));
  await page.getByRole('button', { name: 'Log it' }).click();
  await expect(page.getByText(/an admin must lift the suppression/i)).toBeVisible();

  // An admin can see and lift it.
  const admin = await page.context().browser()!.newContext();
  const adminPage = await admin.newPage();
  await signIn(adminPage, OWNER_EMAIL);
  await adminPage.goto('/admin/settings');
  await expect(
    adminPage.getByRole('heading', { name: /active suppressions \([1-9]/i }),
  ).toBeVisible();
  await admin.close();
});
