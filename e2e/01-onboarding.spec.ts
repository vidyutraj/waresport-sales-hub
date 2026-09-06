import { expect, test } from '@playwright/test';
import {
  clearMailbox,
  completeOnboarding,
  countMessagesFor,
  INTERN_A,
  INTERN_B,
  isoDate,
  OWNER_EMAIL,
  signIn,
  signOut,
  UNINVITED,
  waitForOtp,
} from './helpers';

/**
 * Acceptance flow 1: bootstrap owner, set up the program, invite an intern,
 * exercise the one-time-code edge cases, complete onboarding, and prove the
 * session survives a reload and a fresh sign-in.
 */

test.describe.configure({ mode: 'serial' });

test('owner signs in with a real one-time code', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('owner', { exact: false }).first()).toBeVisible();
});

test('a wrong code is rejected and reports remaining attempts', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(OWNER_EMAIL);
  await page.getByRole('button', { name: /email me a sign-in code/i }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  await page.getByLabel('Verification code').fill('000000');
  await page.getByRole('button', { name: /verify and continue/i }).click();

  await expect(page.getByText('That code is not correct.')).toBeVisible();
  await expect(page.getByText(/attempts? remaining/i)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
});

test('an uninvited address gets no workspace access', async ({ page }) => {
  const since = new Date();
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(UNINVITED);
  await page.getByRole('button', { name: /email me a sign-in code/i }).click();

  // The response is identical to a known address: no account enumeration.
  await expect(page.getByText('Check your email')).toBeVisible();

  // ...but no code is ever actually sent.
  await new Promise((r) => setTimeout(r, 1500));
  expect(await countMessagesFor(UNINVITED)).toBe(0);
  void since;

  // A guessed code cannot get in either.
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: /verify and continue/i }).click();
  await expect(page.getByText('That code is not correct.')).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
});

test('the resend cooldown is enforced', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(OWNER_EMAIL);
  await page.getByRole('button', { name: /email me a sign-in code/i }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  // The resend control is disabled and counts down.
  const resend = page.getByRole('button', { name: /resend code in \d+s/i });
  await expect(resend).toBeVisible();
  await expect(resend).toBeDisabled();
});

test('owner creates a cohort with the program-guide defaults', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/targets');

  await page.getByLabel('Name').fill('Spring 2026');
  await page.getByLabel('Start date').fill(isoDate(-14));
  await page.getByLabel('Weeks').fill('12');
  await page.getByLabel('Reporting timezone').selectOption('America/New_York');
  await page.getByRole('button', { name: /create cohort/i }).click();

  await expect(page.getByText(/cohort created with the program guide defaults/i)).toBeVisible();

  // Week 1 is 75 / 50 and week 2 is 150 / 100, straight from the PDF.
  const week1 = page.getByTestId('target-week-1');
  await expect(week1).toContainText('75');
  await expect(week1).toContainText('50');
  const week2 = page.getByTestId('target-week-2');
  await expect(week2).toContainText('150');
  await expect(week2).toContainText('100');
});

test('owner invites two interns and they claim their invitations', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/interns');

  for (const [email, territory] of [
    [INTERN_A, 'EAST'],
    [INTERN_B, 'WEST'],
  ] as const) {
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Role', { exact: false }).first().selectOption('intern');
    await page.getByLabel('Cohort').selectOption({ label: 'Spring 2026' });
    await page
      .getByLabel('Territory')
      .selectOption({ label: `${territory} — ${territory === 'EAST' ? 'East' : 'West'}` });
    await page.getByRole('button', { name: /send invitation/i }).click();
    await expect(page.getByText(new RegExp(`Invitation sent to ${email}`, 'i'))).toBeVisible();
  }

  await expect(page.getByRole('cell', { name: INTERN_A })).toBeVisible();
  await expect(page.getByRole('cell', { name: INTERN_B })).toBeVisible();
});

test('intern A claims the invitation and completes onboarding', async ({ page }) => {
  await signIn(page, INTERN_A);
  await completeOnboarding(page, { fullName: 'Erin East', preferredName: 'Erin' });

  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole('heading', { name: /welcome, erin/i })).toBeVisible();
  // Territory and program week come from the admin-assigned cohort.
  await expect(page.getByText(/east group/i)).toBeVisible();
  await expect(page.getByText(/week \d+ ·/i).first()).toBeVisible();
});

test('intern B claims the invitation and completes onboarding', async ({ page }) => {
  await signIn(page, INTERN_B);
  await completeOnboarding(page, { fullName: 'Wes West', preferredName: 'Wes' });
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByText(/west group/i)).toBeVisible();
});

test('a claimed invitation cannot be used a second time', async ({ page }) => {
  // Signing in again works (the account now exists), but the invitation itself
  // is consumed — visible to the admin as "claimed".
  await signIn(page, INTERN_A);
  await expect(page).toHaveURL(/\/overview/);
  await signOut(page);

  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/interns');
  await expect(page.getByRole('heading', { name: /live invitations \(0\)/i })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'claimed' }).first()).toBeVisible();
});

test('data survives a reload and a brand new session', async ({ page, context }) => {
  await signIn(page, INTERN_A);
  await page.reload();
  await expect(page.getByRole('heading', { name: /welcome, erin/i })).toBeVisible();

  // Sign-out is POST-only: a GET must not end the session.
  const getSignOut = await page.request.get('/sign-out', { maxRedirects: 0 });
  expect(getSignOut.status()).toBe(405);
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: /welcome, erin/i })).toBeVisible();

  await signOut(page);
  await expect(page).toHaveURL(/\/sign-in/);

  // A protected page redirects to sign-in once signed out.
  await page.goto('/overview');
  await expect(page).toHaveURL(/\/sign-in/);

  // A completely fresh browser context still finds the saved profile.
  const fresh = await context.browser()!.newContext();
  const freshPage = await fresh.newPage();
  await signIn(freshPage, INTERN_A);
  await expect(freshPage.getByRole('heading', { name: /welcome, erin/i })).toBeVisible();
  await freshPage.goto('/profile');
  await expect(freshPage.getByLabel('Full name')).toHaveValue('Erin East');
  await fresh.close();
});

test('an expired code is refused', async ({ page }) => {
  await clearMailbox();
  const since = new Date();
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(INTERN_B);
  await page.getByRole('button', { name: /email me a sign-in code/i }).click();
  const code = await waitForOtp(INTERN_B, since);

  // Age the code past its TTL directly in the database, then try to use it.
  const postgres = (await import('postgres')).default;
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    await sql`
      UPDATE auth_codes SET expires_at = now() - interval '1 minute'
      WHERE email = ${INTERN_B} AND consumed_at IS NULL`;
  } finally {
    await sql.end({ timeout: 5 });
  }

  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: /verify and continue/i }).click();
  await expect(page.getByText(/that code has expired/i)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);
});
