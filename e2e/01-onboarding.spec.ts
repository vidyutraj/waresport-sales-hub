import { expect, test } from '@playwright/test';
import {
  completeOnboarding,
  INTERN_A,
  INTERN_B,
  isoDate,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  signIn,
  signOut,
} from './helpers';

/**
 * Acceptance flow 1: the owner signs in, sets up the program, creates two
 * intern profiles, they sign in by picking their own name and complete
 * onboarding, and the session survives a reload and a fresh browser context.
 */

test.describe.configure({ mode: 'serial' });

test('the owner picks their name and then has to pass a password', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: /who are you/i })).toBeVisible();

  await page.getByRole('button', { name: new RegExp(OWNER_EMAIL, 'i') }).click();

  // Picking the name is not enough for an admin account.
  await expect(page).toHaveURL(/\/sign-in\?user=/);
  await expect(page.getByText(/admin access needs a password/i)).toBeVisible();

  await page.getByLabel(/password/i).fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();

  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});

test('a wrong admin password gets nowhere', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: new RegExp(OWNER_EMAIL, 'i') }).click();
  await page.getByLabel(/password/i).fill('not-the-password');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  await expect(page.getByText(/that password is not correct/i)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);

  // And the session really was not created.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('an account that does not exist cannot be picked', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: /stranger@example\.test/i })).toHaveCount(0);
});

test('picking an admin card alone issues no session', async ({ page }) => {
  // The picker marks admin accounts, so their ids are not secret. Skipping the
  // password step has to be impossible on the server, not just in the UI.
  await page.goto('/sign-in');
  const adminCard = page.getByRole('button', { name: new RegExp(OWNER_EMAIL, 'i') });
  await expect(adminCard).toBeVisible();

  await adminCard.click();
  await expect(page).toHaveURL(/\/sign-in\?user=/);

  // No session cookie was issued by picking alone.
  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === 'waresport_session')).toBe(false);
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

  // Week 1 is 75 emails and week 2 is 150, straight from the PDF. LinkedIn has
  // no target, so the guide's request figures are not shown.
  const week1 = page.getByTestId('target-week-1');
  await expect(week1).toContainText('75');
  const week2 = page.getByTestId('target-week-2');
  await expect(week2).toContainText('150');
  await expect(page.getByRole('columnheader', { name: /requests/i })).toHaveCount(0);
});

test('owner creates two intern profiles', async ({ page }) => {
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
    await page.getByRole('button', { name: /create profile/i }).click();
    await expect(page.getByText(new RegExp(`${email} can now sign in`, 'i'))).toBeVisible();
  }

  await expect(page.getByRole('cell', { name: INTERN_A })).toBeVisible();
  await expect(page.getByRole('cell', { name: INTERN_B })).toBeVisible();
});

test('the same address cannot be added twice', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/interns');

  await page.getByLabel('Email address').fill(INTERN_A);
  await page.getByRole('button', { name: /create profile/i }).click();
  await expect(page.getByText(/already has an account/i)).toBeVisible();
});

test('a new profile appears on the sign-in screen', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: new RegExp(INTERN_A, 'i') })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(INTERN_B, 'i') })).toBeVisible();
});

test('onboarding has a way back to the picker', async ({ page }) => {
  // Picking the wrong profile must not be a dead end: / sends an un-onboarded
  // account to onboarding and /sign-in sends anyone with a session back to /,
  // so onboarding has to carry its own sign-out.
  await signIn(page, INTERN_A);
  await expect(page).toHaveURL(/\/onboarding/);

  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByRole('heading', { name: /who are you/i })).toBeVisible();
});

test('intern A signs in and completes onboarding', async ({ page }) => {
  await signIn(page, INTERN_A);
  await completeOnboarding(page, { fullName: 'Erin East', preferredName: 'Erin' });

  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByRole('heading', { name: /welcome, erin/i })).toBeVisible();
  // Territory and program week come from the admin-assigned cohort.
  await expect(page.getByText(/east group/i)).toBeVisible();
  await expect(page.getByText(/week \d+ ·/i).first()).toBeVisible();
});

test('intern B signs in and completes onboarding', async ({ page }) => {
  await signIn(page, INTERN_B);
  await completeOnboarding(page, { fullName: 'Wes West', preferredName: 'Wes' });
  await expect(page).toHaveURL(/\/overview/);
  await expect(page.getByText(/west group/i)).toBeVisible();
});

test('the picker shows the name people chose during onboarding', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: /erin/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /wes/i })).toBeVisible();
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
