import { z } from 'zod';

/**
 * Centralised, validated configuration. Anything secret lives here and is
 * only ever imported from server-side modules — nothing in this file is
 * prefixed with NEXT_PUBLIC_, so it cannot leak into the client bundle.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Owner/superuser connection: migrations, sign-in, account creation, seeding. */
  DATABASE_URL: z.string().min(1),
  /** Request-scoped connection. Not a table owner, so RLS is enforced. */
  APP_DATABASE_URL: z.string().min(1),

  /** Signing key for session cookies. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  APP_URL: z.string().url().default('http://localhost:3000'),

  /** Import guardrails; configurable per deployment. */
  IMPORT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10_000_000),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().default(50_000),

  /** Private file storage root for uploaded resources (never web-served). */
  STORAGE_DIR: z.string().default('./storage'),
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the memoised value after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}
