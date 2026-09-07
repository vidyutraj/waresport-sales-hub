import { expect, type Page } from '@playwright/test';

/**
 * End-to-end helpers.
 *
 * Sign-in is the real product flow: /sign-in lists every account and you pick
 * one. An intern is in at that point; an admin or owner then has to pass the
 * password step. Nothing is stubbed and no email is involved — the app sends
 * none.
 */

/** Accounts used across the acceptance flows. */
export const OWNER_EMAIL = 'owner@waresport.local';
export const INTERN_A = 'intern.east@waresport.local';
export const INTERN_B = 'intern.west@waresport.local';

/** The owner password the global setup installs. */
export const OWNER_PASSWORD = 'acceptance-owner-passphrase';

/** Passwords for the password-gated accounts, by address. */
const PASSWORDS: Record<string, string> = { [OWNER_EMAIL]: OWNER_PASSWORD };

/**
 * Sign in by picking the account with this email address, passing the password
 * step when the account has one.
 */
export async function signIn(page: Page, email: string, password?: string): Promise<void> {
  await page.goto('/sign-in');
  const choice = page.getByRole('button', { name: new RegExp(escapeRegExp(email), 'i') });
  await expect(choice).toBeVisible({ timeout: 10_000 });
  await choice.click();

  // Admin and owner accounts land on the password step first.
  await page.waitForURL(
    (url) => !url.pathname.startsWith('/sign-in') || url.searchParams.has('user'),
    { timeout: 20_000 },
  );
  if (new URL(page.url()).searchParams.has('user')) {
    const secret = password ?? PASSWORDS[email];
    if (secret === undefined) throw new Error(`${email} needs a password and none was supplied.`);
    await page.getByLabel(/password/i).fill(secret);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function signOut(page: Page): Promise<void> {
  // Sign-out is a POST-only action, so it is driven by the real button.
  await page
    .getByRole('button', { name: /sign out/i })
    .first()
    .click();
  await page.waitForURL(/\/sign-in/);
}

/** Complete the onboarding form for a newly created intern. */
export async function completeOnboarding(
  page: Page,
  input: { fullName: string; preferredName?: string },
): Promise<void> {
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Full name').fill(input.fullName);
  if (input.preferredName) {
    await page.getByLabel('Preferred name').fill(input.preferredName);
  }
  await page.getByLabel(/I have read the program guidance/i).check();
  await page.getByRole('button', { name: /finish setup/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/onboarding'));
}

/**
 * Collect console errors and failed requests for the "no unexpected errors"
 * assertions. Next.js prefetch aborts are filtered out — they are normal
 * navigation behaviour, not application faults.
 */
export function watchForPageErrors(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? '';
    if (failure.includes('ERR_ABORTED') || failure.includes('net::ERR_ABORTED')) return;
    failedRequests.push(`${request.method()} ${request.url()} — ${failure}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  return { consoleErrors, failedRequests };
}

/**
 * A local wall-clock string for a `datetime-local` input, kept inside today.
 *
 * The suite logs activity "a little while ago" and then asserts it counts
 * toward this program week. Run just after midnight, a naive offset lands in
 * yesterday — and on a Monday, in last week, where the app quite correctly does
 * not count it. Clamping keeps the fixture honest without weakening what the
 * test checks.
 */
export function localDateTime(offsetMinutes = -30): string {
  const now = new Date();
  const target = new Date(now.getTime() + offsetMinutes * 60_000);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  const d =
    target < midnight ? new Date(Math.max(midnight.getTime(), now.getTime() - 60_000)) : target;

  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A local calendar date, not a UTC one.
 *
 * `toISOString()` would roll the date forward once local time passes UTC
 * midnight, which put "today" a day ahead of the app's own reporting-timezone
 * today for any evening run.
 */
export function isoDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Read a StatTile's numeric value by its label. */
export async function statValue(page: Page, label: string): Promise<number> {
  const id = `stat-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-value`;
  const text = (await page.getByTestId(id).innerText()).replace(/[^0-9.-]/g, '');
  return Number(text || '0');
}

/**
 * Minimal RFC-4180 splitter for asserting on exported CSVs.
 *
 * The exports quote any cell containing a comma (period labels do), so a naive
 * `split(',')` misaligns the columns.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
