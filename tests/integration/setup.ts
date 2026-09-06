import { config } from 'dotenv';
import { resolve } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Integration test setup.
 *
 * These tests run against the real local PostgreSQL from docker-compose, with
 * real row level security, real triggers and real transactions. Nothing is
 * mocked: an authorization test that passed against a stub would prove nothing
 * about the deployed system.
 *
 * Bring the database up first:
 *   npm run db:up && npm run db:migrate
 */
config({ path: resolve(process.cwd(), '.env.test'), quiet: true });
config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
config({ path: resolve(process.cwd(), '.env'), quiet: true });

// NODE_ENV is read-only in the type definitions but writable at runtime;
// the app's env schema needs it set before any module reads it.
Object.assign(process.env, { NODE_ENV: 'test' });

afterAll(async () => {
  const { closeConnections } = await import('@/lib/db');
  await closeConnections();
});
