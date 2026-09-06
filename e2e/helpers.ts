import { expect, type Page } from '@playwright/test';

/**
 * End-to-end helpers.
 *
 * Sign-in goes through the real one-time-code flow: the app sends a message
 * over SMTP to the local Mailpit capture server, and these helpers read the
 * code back out of Mailpit's HTTP API. Nothing is stubbed, and no message ever
 * leaves the machine.
 */

/** Accounts used across the acceptance flows. */
export const OWNER_EMAIL = 'owner@waresport.local';
export const INTERN_A = 'intern.east@waresport.local';
export const INTERN_B = 'intern.west@waresport.local';
export const UNINVITED = 'stranger@example.test';

export const MAILPIT_API = process.env.MAILPIT_API ?? 'http://127.0.0.1:54324/api/v1';

export type MailpitMessage = {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Created: string;
};

export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILPIT_API}/messages`, { method: 'DELETE' });
}

async function listMessages(): Promise<MailpitMessage[]> {
  const response = await fetch(`${MAILPIT_API}/messages?limit=200`);
  if (!response.ok) throw new Error(`Mailpit is not reachable at ${MAILPIT_API}`);
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages ?? [];
}

async function messageText(id: string): Promise<string> {
  const response = await fetch(`${MAILPIT_API}/message/${id}`);
  const body = (await response.json()) as { Text?: string; HTML?: string };
  return `${body.Text ?? ''}\n${body.HTML ?? ''}`;
}

/** Wait for the newest message to `email` and return its 6-digit code. */
export async function waitForOtp(email: string, since = new Date(0)): Promise<string> {
  const target = email.toLowerCase();
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const messages = await listMessages();
    const matching = messages
      .filter((m) => m.To.some((t) => t.Address.toLowerCase() === target))
      .filter((m) => new Date(m.Created).getTime() >= since.getTime() - 2000)
      .sort((a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime());

    for (const message of matching) {
      const text = await messageText(message.ID);
      const code = /\b(\d{6})\b/.exec(text)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`No one-time code arrived for ${email} within 20s.`);
}

export async function countMessagesFor(email: string): Promise<number> {
  const target = email.toLowerCase();
  const messages = await listMessages();
  return messages.filter((m) => m.To.some((t) => t.Address.toLowerCase() === target)).length;
}

/**
 * Full sign-in: request a code, read it from Mailpit, submit it.
 *
 * The resend cooldown is a real product rule, so a suite that signs in
 * repeatedly can legitimately hit it. When that happens the helper waits it
 * out and requests again rather than pretending the cooldown does not exist.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(email);

  let since = new Date();
  await page.getByRole('button', { name: /email me a sign-in code/i }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  const cooldownNotice = page.getByText(/you can request another in \d+s/i);
  if (await cooldownNotice.isVisible().catch(() => false)) {
    const resend = page.getByRole('button', { name: /send a new code|resend code in/i });
    await expect(resend).toBeEnabled({ timeout: 30_000 });
    since = new Date();
    await resend.click();
  }

  const code = await waitForOtp(email, since);
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: /verify and continue/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
}

export async function signOut(page: Page): Promise<void> {
  // Sign-out is a POST-only action, so it is driven by the real button.
  await page
    .getByRole('button', { name: /sign out/i })
    .first()
    .click();
  await page.waitForURL(/\/sign-in/);
}

/** Complete the onboarding form for a freshly invited intern. */
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

/** A local wall-clock string for a `datetime-local` input. */
export function localDateTime(offsetMinutes = -30): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function isoDate(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
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
