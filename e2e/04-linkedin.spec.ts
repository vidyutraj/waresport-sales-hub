import { expect, test, type Page } from '@playwright/test';
import { INTERN_A, INTERN_B, signIn, statValue } from './helpers';

/**
 * Acceptance flow 4: the LinkedIn track.
 *
 * Interns work LinkedIn with Premium — they connect and message in one motion —
 * so the app records one thing: who they connected with. No club to pick, no
 * second step, and a profile counts exactly once however often they message it.
 */

test.describe.configure({ mode: 'serial' });

const PROFILE = 'https://www.linkedin.com/in/pat-director-waresport';

async function counter(page: Page, label: string): Promise<number> {
  return statValue(page, label);
}

test('an unsafe or non-profile LinkedIn link is rejected', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');

  for (const [url, expected] of [
    ['https://linkedin.com.evil.example/in/someone', /not a LinkedIn domain/i],
    ['https://www.linkedin.com/company/waresport', /personal profile link/i],
    ['javascript:alert(1)', /unsupported link protocol/i],
  ] as const) {
    await page.locator('#connection-name').fill('Mallory Test');
    await page.locator('#connection-url').fill(url);
    await page.getByRole('button', { name: /log connection/i }).click();
    await expect(page.getByText(expected)).toBeVisible();
  }
});

test('logging a connection takes a name, a link and nothing else', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');

  // The old flow made them attach every prospect to one of their clubs.
  await expect(page.locator('#organizationId')).toHaveCount(0);

  const before = await counter(page, 'Connections this week');

  await page.locator('#connection-name').fill('Pat Director');
  await page.locator('#connection-url').fill(PROFILE);
  await page
    .locator('#connection-notes')
    .fill('Runs the 12U program. Asked me to follow up in May.');
  await page.getByRole('button', { name: /log connection/i }).click();

  await expect(page.getByText(/counts toward this week/i)).toBeVisible();
  await expect(page.getByText('Pat Director', { exact: true })).toBeVisible();
  await expect(page.getByText(/runs the 12u program/i)).toBeVisible();

  await page.reload();
  expect(await counter(page, 'Connections this week')).toBe(before + 1);
});

test('the same profile cannot be logged twice, whatever its casing', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');
  const before = await counter(page, 'Connections this week');

  await page.locator('#connection-name').fill('Pat Director');
  // Different casing, a tracking parameter and a trailing slash: same profile.
  await page
    .locator('#connection-url')
    .fill('HTTPS://www.linkedin.com/in/Pat-Director-Waresport/?utm_source=share&trk=x');
  await page.getByRole('button', { name: /log connection/i }).click();

  await expect(page.getByText(/already in your list/i)).toBeVisible();

  await page.reload();
  expect(await counter(page, 'Connections this week')).toBe(before);
});

test('notes can be edited afterwards', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');

  await page
    .getByRole('button', { name: /edit notes/i })
    .first()
    .click();
  await page.getByRole('textbox').last().fill('Replied — sending the deck Monday.');
  await page.getByRole('button', { name: /save notes/i }).click();

  await expect(page.getByText(/notes saved/i)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/sending the deck monday/i)).toBeVisible();
});

test('the weekly counter on the overview matches', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/linkedin');
  const connections = await counter(page, 'Connections this week');

  await page.goto('/overview');
  const meter = page.getByText('LinkedIn requests sent').locator('xpath=../..');
  await expect(meter).toContainText(String(connections));
});

test('another intern is told the profile is taken, and nothing more', async ({ page }) => {
  await signIn(page, INTERN_B);
  await page.goto('/linkedin');

  await page.locator('#connection-name').fill('Pat Director');
  await page.locator('#connection-url').fill(PROFILE);
  await page.getByRole('button', { name: /log connection/i }).click();

  await expect(page.getByText(/someone else is already working this profile/i)).toBeVisible();
  // The notice names no intern, no club and no notes. Word-bounded: the page
  // copy contains "remembering", which a bare /erin/ would match.
  await expect(page.getByText(/\berin\b/i)).toHaveCount(0);
  await expect(page.getByText(/12u program/i)).toHaveCount(0);
});

test("one intern's connections are invisible to another", async ({ page }) => {
  await signIn(page, INTERN_B);
  await page.goto('/linkedin');

  await page.locator('#connection-name').fill('Robin Coach');
  await page.locator('#connection-url').fill('https://www.linkedin.com/in/robin-coach-bellevue');
  await page.getByRole('button', { name: /log connection/i }).click();
  await expect(page.getByText(/counts toward this week/i)).toBeVisible();

  await expect(page.getByText('Robin Coach', { exact: true })).toBeVisible();
  await expect(page.getByText('Pat Director', { exact: true })).toHaveCount(0);
});
