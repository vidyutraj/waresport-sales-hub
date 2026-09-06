import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
config({ path: resolve(process.cwd(), '.env'), quiet: true });

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * End-to-end configuration.
 *
 * The suite drives a real Next.js server against the real local PostgreSQL and
 * reads one-time codes out of the local Mailpit capture server, so the sign-in
 * flow under test is the actual flow, not a stub. Bring the infrastructure up
 * first:  npm run db:up && npm run db:migrate
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile-and-states\.spec\.ts/,
    },
  ],

  webServer: {
    // Production build: what actually ships, not the dev server.
    command: `npm run build && npx next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      ...process.env,
      APP_URL: BASE_URL,
      NODE_ENV: 'production',
      // The real cooldown is 60s and is still exercised (the resend control is
      // asserted to be disabled and counting down); a short value here just
      // keeps a suite that signs in dozens of times from waiting on it.
      OTP_RESEND_COOLDOWN_SECONDS: process.env.E2E_OTP_COOLDOWN ?? '3',
      // The acceptance suite signs in far more often than a person would.
      // The limiter itself is covered by tests/integration/auth.test.ts at its
      // real threshold; here it is raised so it does not mask other failures.
      AUTH_REQUEST_LIMIT_PER_EMAIL: '500',
      AUTH_REQUEST_LIMIT_PER_IP: '2000',
      AUTH_VERIFY_LIMIT_PER_EMAIL: '500',
    } as Record<string, string>,
  },
});
