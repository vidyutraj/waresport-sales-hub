import { expect, test, type Page } from '@playwright/test';
import { INTERN_A, INTERN_B, signIn, statValue } from './helpers';

/**
 * Acceptance flow 4: an intern adds a LinkedIn prospect, records a request,
 * adds later messages, and gets accurate *separate* counters. Duplicate and
 * unsafe URLs are handled without leaking another intern's work.
 */

test.describe.configure({ mode: 'serial' });

const PROFILE = 'https://www.linkedin.com/in/pat-director-waresport';

/** Reads one of the counter tiles on the LinkedIn page. */
async function counter(page: Page, label: string): Promise<number> {
  return statValue(page, label);
}

test('an unsafe or non-profile LinkedIn URL is rejected', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');
  // Pick a club first, so the URL itself is what is being judged.
  await page.locator('#organizationId').selectOption({ index: 1 });

  for (const [url, expected] of [
    ['https://linkedin.com.evil.example/in/someone', /not a LinkedIn domain/i],
    ['https://www.linkedin.com/company/waresport', /personal profile link/i],
    ['javascript:alert(1)', /unsupported link protocol/i],
  ] as const) {
    await page.getByLabel('Full name').fill('Mallory Test');
    await page.getByLabel('LinkedIn profile URL').fill(url);
    await page.getByRole('button', { name: /add prospect/i }).click();
    await expect(page.getByText(expected)).toBeVisible();
  }
});

test('adding a prospect is research, not outreach', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');

  const requestsBefore = await counter(page, 'Requests sent');

  await page.locator('#organizationId').selectOption({ index: 1 });
  await page.getByLabel('Full name').fill('Pat Director');
  await page.getByLabel('Title').fill('Club President');
  await page.getByLabel('LinkedIn profile URL').fill(PROFILE);
  await page.getByRole('button', { name: /add prospect/i }).click();

  await expect(page.getByText(/does not count as outreach yet/i)).toBeVisible();
  await expect(page.getByRole('cell', { name: /pat director/i })).toBeVisible();

  await page.reload();
  expect(await counter(page, 'Requests sent')).toBe(requestsBefore);
  expect(await counter(page, 'Prospects tracked')).toBeGreaterThan(0);
});

test('the same profile cannot be added twice, whatever its casing', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');
  const tracked = await counter(page, 'Prospects tracked');

  await page.locator('#organizationId').selectOption({ index: 1 });
  await page.getByLabel('Full name').fill('Pat Director');
  // Different casing, a tracking parameter and a trailing slash: same profile.
  await page
    .getByLabel('LinkedIn profile URL')
    .fill('HTTPS://www.linkedin.com/in/Pat-Director-Waresport/?utm_source=share&trk=x');
  await page.getByRole('button', { name: /add prospect/i }).click();

  await expect(page.getByText(/already track that profile/i)).toBeVisible();
  await page.reload();
  expect(await counter(page, 'Prospects tracked')).toBe(tracked);
});

test('recording a request counts once, and only once', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');
  const before = await counter(page, 'Requests sent');

  await page.getByRole('button', { name: 'Request sent' }).first().click();
  await expect(page.getByText(/counts once toward this week/i)).toBeVisible();

  await page.reload();
  expect(await counter(page, 'Requests sent')).toBe(before + 1);

  // The control is gone, because a second request cannot count.
  const row = page.getByRole('row').filter({ hasText: 'Pat Director' });
  await expect(row.getByRole('button', { name: 'Request sent' })).toHaveCount(0);
});

test('acceptance and messages are separate, non-counting events', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');
  const requestsBefore = await counter(page, 'Requests sent');
  const messagesBefore = await counter(page, 'Messages sent');

  const row = page.getByRole('row').filter({ hasText: 'Pat Director' });
  await row.getByRole('button', { name: 'Accepted' }).click();
  await expect(page.getByText(/accepting a connection is not outreach/i)).toBeVisible();

  await page.reload();
  expect(await counter(page, 'Requests sent')).toBe(requestsBefore);

  await page
    .getByRole('row')
    .filter({ hasText: 'Pat Director' })
    .getByRole('button', { name: 'Message sent' })
    .click();
  await expect(page.getByText(/does not count again toward the request target/i)).toBeVisible();

  await page.reload();
  expect(await counter(page, 'Requests sent')).toBe(requestsBefore);
  expect(await counter(page, 'Messages sent')).toBe(messagesBefore + 1);
});

test('the weekly LinkedIn counter on the overview matches', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');
  const requests = await counter(page, 'Requests sent');

  await page.goto('/overview');
  const meter = page.getByText('LinkedIn requests sent').locator('xpath=../..');
  await expect(meter).toContainText(String(requests));
});

test('another intern is told the profile is taken, and nothing more', async ({ page }) => {
  await signIn(page, INTERN_B);
  await page.goto('/linkedin');

  // Wes researches his own organization, then tries the same profile.
  await page.getByLabel('A new organization I researched').check();
  await page.getByLabel('Organization name').fill('Tacoma Volleyball Club');
  await page.getByLabel('City').fill('Tacoma');
  await page.getByLabel('State').fill('WA');
  await page.getByLabel('Full name').fill('Pat Director');
  await page.getByLabel('LinkedIn profile URL').fill(PROFILE);
  await page.getByRole('button', { name: /add prospect/i }).click();

  const notice = page.getByText(/already being tracked by someone else/i);
  await expect(notice).toBeVisible();
  // The notice names no intern, no club and no notes.
  await expect(page.getByText(/erin/i)).toHaveCount(0);
});

test('an intern can research and claim a new organization', async ({ page }) => {
  await signIn(page, INTERN_B);
  await page.goto('/linkedin');

  await page.getByLabel('A new organization I researched').check();
  await page.getByLabel('Organization name').fill('Bellevue Gymnastics Academy');
  await page.getByLabel('City').fill('Bellevue');
  await page.getByLabel('State').fill('WA');
  await page.getByLabel('Sport').fill('Gymnastics');
  await page.getByLabel('Full name').fill('Robin Coach');
  await page
    .getByLabel('LinkedIn profile URL')
    .fill('https://www.linkedin.com/in/robin-coach-bellevue');
  await page.getByRole('button', { name: /add prospect/i }).click();

  await expect(page.getByText(/prospect added/i)).toBeVisible();

  // The club he researched is now his, and appears in My Leads.
  await page.goto('/leads');
  await expect(page.getByRole('cell', { name: /bellevue gymnastics academy/i })).toBeVisible();
});
