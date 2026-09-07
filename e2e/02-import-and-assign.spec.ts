import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { INTERN_A, INTERN_B, OWNER_EMAIL, signIn } from './helpers';

/**
 * Acceptance flow 2: an admin imports the supplied CSV through the wizard,
 * reviews the preview, confirms, sees an accurate report, then filters and
 * allocates clubs. Interns then see only their own.
 *
 * The real supplied file is used when a private copy is present; otherwise a
 * committed synthetic fixture with the same headers and the same edge cases is
 * used, so the flow is always exercised.
 */

test.describe.configure({ mode: 'serial' });

const SUPPLIED = resolve(process.cwd(), 'private/baseball-club-directors-combined.csv');
const HEADERS = 'club_name,role,contact_name,phone,email,city,state,source_url,notes';

/** Synthetic stand-in, covering the same shapes as the supplied file. */
const FIXTURE = [
  HEADERS,
  'Cary Youth Baseball,President,Ann Reed,919-732-4454,president@caryyouth.example,Cary,NC,https://www.sportsengine.com/org/cary,"Rec + travel"',
  'Cary Youth Baseball,Treasurer,Bo Lane,919-732-4455,treasurer@caryyouth.example,Cary,NC,https://www.sportsengine.com/org/cary,Second contact at the same club',
  'Apex Little League,President,Cal Yates,919-000-0002,president@apexll.example,Apex,NC,https://example.test/apex,"Notes, with a comma"',
  'Raleigh Volleyball Club,Director,,919-000-0003,,Raleigh,NC,https://example.test/rvc,No email on file',
  'Tacoma Youth Soccer,President,Dee Park,253-000-0004,president@tacomayouth.example,Tacoma,WA,https://example.test/tys,West territory club',
  'Bend Basketball Association,Commissioner,Eli Ross,541-000-0005,commish@bendhoops.example,Bend,OR,javascript:alert(1),Unsafe source link',
  ',President,No Club,919-000-0006,orphan@example.test,Cary,NC,,Row with no club name',
  'Apex Little League,Registrar,Fay Bloom,919-000-0007,registrar@apexll.example,,NC,,City missing — uncertain match',
  '',
  'Cary Youth Baseball,President,Ann Reed,919-732-4454,president@caryyouth.example,Cary,NC,https://www.sportsengine.com/org/cary,"Rec + travel"',
].join('\r\n');

const usingSupplied = existsSync(SUPPLIED);
const fileName = usingSupplied ? 'baseball-club-directors-combined.csv' : 'synthetic-leads.csv';
const fileBuffer = usingSupplied ? readFileSync(SUPPLIED) : Buffer.from(`﻿${FIXTURE}\r\n`, 'utf8');

test('admin previews an upload without writing anything', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads/import');

  await page.getByLabel('CSV file').setInputFiles({
    name: fileName,
    mimeType: 'text/csv',
    buffer: fileBuffer,
  });
  await page.getByLabel('Default sport').fill('Baseball');
  await page.getByLabel('Source tag').fill('Acceptance run');
  await page.getByRole('button', { name: /preview import/i }).click();

  await expect(page.getByText(/nothing has been imported yet/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: '2. Review' })).toBeVisible();

  // Column mapping was inferred, and every parsed row reconciles.
  await expect(page.getByText(/every parsed row is accounted for exactly once/i)).toBeVisible();

  if (usingSupplied) {
    await expect(page.getByText('1,231', { exact: false }).first()).toBeVisible();
  }

  // Nothing is in the database yet.
  await page.goto('/admin/leads');
  await expect(page.getByText('No clubs match those filters')).toBeVisible();
});

test('admin confirms the import and gets an accurate report', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads/import');

  await page.getByLabel('CSV file').setInputFiles({
    name: fileName,
    mimeType: 'text/csv',
    buffer: fileBuffer,
  });
  await page.getByLabel('Default sport').fill('Baseball');
  await page.getByLabel('Source tag').fill('Acceptance run');
  await page.getByRole('button', { name: /preview import/i }).click();
  await expect(page.getByRole('heading', { name: '3. Confirm' })).toBeVisible();

  await page.getByRole('button', { name: /^Import [\d,]+ rows$/ }).click();
  await expect(page.getByText(/^Imported\./i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/duplicates? skipped/i)).toBeVisible();
  await expect(page.getByText(/held for review/i)).toBeVisible();
});

test('a re-import of the same file creates nothing', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads');
  const countBefore = await page
    .getByText(/records$/)
    .first()
    .textContent();

  await page.goto('/admin/leads/import');
  await page.getByLabel('CSV file').setInputFiles({
    name: fileName,
    mimeType: 'text/csv',
    buffer: fileBuffer,
  });
  await page.getByLabel('Source tag').fill('Acceptance run second pass');
  await page.getByRole('button', { name: /preview import/i }).click();
  await expect(page.getByRole('heading', { name: '2. Review' })).toBeVisible();

  // Every row is now classified as a duplicate.
  await expect(page.getByTestId('import-outcome-organization_created')).toContainText('0');
  await expect(page.getByTestId('import-outcome-contact_added')).toContainText('0');

  await page.getByRole('button', { name: /^Import [\d,]+ rows$/ }).click();
  await expect(page.getByText(/^Imported\./i)).toBeVisible({ timeout: 60_000 });

  await page.goto('/admin/leads');
  await expect(page.getByText(/records$/).first()).toHaveText(countBefore ?? '');
});

test('the synthetic edge-case fixture imports alongside the supplied file', async ({ page }) => {
  // Always imported, even when the real lead file is present, so the unsafe
  // link, missing club name and uncertain match cases exist for later flows.
  test.skip(!usingSupplied, 'The fixture is already the primary import.');

  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads/import');
  await page.getByLabel('CSV file').setInputFiles({
    name: 'synthetic-edge-cases.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`\ufeff${FIXTURE}\r\n`, 'utf8'),
  });
  await page.getByLabel('Source tag').fill('Synthetic edge cases');
  await page.getByRole('button', { name: /preview import/i }).click();
  await expect(page.getByRole('heading', { name: '2. Review' })).toBeVisible();

  // The unsafe source URL is flagged in the preview, not silently accepted.
  await expect(page.getByText(/not a usable http\(s\) link/i).first()).toBeVisible();
  // A row with no club name is reported as invalid rather than guessed at.
  const invalidRow = page.getByTestId('import-outcome-invalid');
  await expect(invalidRow).toContainText('1');
  await expect(invalidRow).toContainText(/nothing is written/i);

  await page.getByRole('button', { name: /^Import [\d,]+ rows$/ }).click();
  await expect(page.getByText(/^Imported\./i)).toBeVisible({ timeout: 60_000 });
});

test('rejected rows can be downloaded', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('link', { name: /rejected rows csv/i })
      .first()
      .click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/waresport-import-rejects.*\.csv/);
});

test('admin allocates only part of the unallocated queue', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads?assignment=unassigned');

  // The unallocated tab is where the queue lives.
  await expect(page.getByRole('heading', { name: /allocate a batch/i })).toBeVisible();
  const before = Number(
    (await page.getByRole('tab', { name: /unallocated/i }).innerText()).replace(/[^0-9]/g, ''),
  );
  test.skip(before < 2, 'Needs at least two unallocated clubs.');

  await page.locator('#allocate-count').fill('1');
  await page.locator('#allocate-intern').selectOption({ label: 'Erin (EAST)' });
  await page.locator('#allocate-reason').fill('First batch for week 1');
  await page.locator('#allocate-override').fill('Acceptance run');

  // The form says exactly what will happen before it happens.
  await expect(page.getByText(/stay unallocated for later/i)).toBeVisible();
  await page.getByRole('button', { name: /^allocate 1 to /i }).click();

  await expect(page.getByText(/allocated 1 club/i)).toBeVisible();
  await expect(page.getByText(/still unallocated/i)).toBeVisible();

  // The rest stayed in the queue rather than being handed out.
  const after = Number(
    (await page.getByRole('tab', { name: /unallocated/i }).innerText()).replace(/[^0-9]/g, ''),
  );
  expect(after).toBe(before - 1);
});

test('admin filters and assigns clubs to an intern', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  await page.goto('/admin/leads?state=NC');

  await expect(page.getByRole('button', { name: /select all/i })).toBeVisible();
  await page.getByRole('button', { name: /select all/i }).click();
  await expect(page.getByText(/clubs? selected/i)).toBeVisible();

  await page.getByLabel('Assign to').selectOption({ label: 'Erin (EAST)' });
  await page.getByLabel('Reason', { exact: false }).first().fill('Initial East allocation');
  await page.getByRole('button', { name: /^Assign \d+$/ }).click();

  await expect(page.getByText(/assigned.*reassigned.*unchanged/i)).toBeVisible();
  await expect(page.getByText(/historical contributions are unchanged/i)).toBeVisible();
});

test('a cross-territory assignment needs an explicit override reason', async ({ page }) => {
  await signIn(page, OWNER_EMAIL);
  // WA/OR clubs sit in WEST; Erin is EAST.
  await page.goto('/admin/leads?state=WA');
  const rows = await page.getByRole('row').count();
  test.skip(rows < 2, 'No WEST-territory clubs in this dataset.');

  await page.getByRole('button', { name: /select all/i }).click();
  await page.getByLabel('Assign to').selectOption({ label: 'Erin (EAST)' });

  // The preview warns before anything is submitted.
  await expect(page.getByText(/outside that intern's territory/i)).toBeVisible();
  await expect(page.getByLabel(/override reason/i)).toBeVisible();

  // Submitting without a reason is refused by the server.
  await page.getByRole('button', { name: /^Assign \d+$/ }).click();
  await expect(page.getByText(/could not be assigned|override reason/i).first()).toBeVisible();

  // With a reason it succeeds.
  await page.getByLabel(/override reason/i).fill('Erin already knows this club.');
  await page.getByRole('button', { name: /^Assign \d+$/ }).click();
  await expect(page.getByText(/assigned.*reassigned.*unchanged/i)).toBeVisible();
});

test('interns see only the clubs assigned to them', async ({ page, context }) => {
  await signIn(page, INTERN_A);
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'My leads' })).toBeVisible();

  const erinRows = await page.getByRole('row').count();
  expect(erinRows).toBeGreaterThan(1);
  const firstClubLink = page
    .getByRole('link', { name: /./ })
    .filter({ hasNotText: /leads|linkedin|overview/i });
  void firstClubLink;

  // Wes has nothing assigned yet, and cannot see Erin's clubs.
  const wesContext = await context.browser()!.newContext();
  const wesPage = await wesContext.newPage();
  await signIn(wesPage, INTERN_B);
  await wesPage.goto('/leads');
  await expect(wesPage.getByText('No clubs assigned yet')).toBeVisible();
  await wesContext.close();
});

test('an intern cannot reach a club assigned to someone else', async ({ page, context }) => {
  await signIn(page, INTERN_A);
  await page.goto('/leads');
  const href = await page.getByRole('link').filter({ hasText: /./ }).nth(0).getAttribute('href');
  void href;

  // Grab a real club id Erin owns, then try it as Wes.
  const link = await page.locator('a[href^="/leads/"]').first().getAttribute('href');
  expect(link).toBeTruthy();

  const wesContext = await context.browser()!.newContext();
  const wesPage = await wesContext.newPage();
  await signIn(wesPage, INTERN_B);
  const response = await wesPage.goto(link!);
  // Row level security makes a forged id indistinguishable from a missing one.
  expect(response?.status()).toBe(404);
  await wesContext.close();
});

test('an intern cannot reach the admin area', async ({ page }) => {
  await signIn(page, INTERN_A);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/denied/);
  await expect(page.getByText(/do not have permission/i)).toBeVisible();

  // ...and the admin CSV export refuses them too.
  const response = await page.request.get('/api/exports/leads');
  expect(response.status()).toBe(403);
});
