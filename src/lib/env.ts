import { z } from 'zod';

/**
 * Centralised, validated configuration. Anything secret lives here and is
 * only ever imported from server-side modules — nothing in this file is
 * prefixed with NEXT_PUBLIC_, so it cannot leak into the client bundle.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Owner/superuser connection: migrations, sign-in, invite claim, seeding. */
  DATABASE_URL: z.string().min(1),
  /** Request-scoped connection. Not a table owner, so RLS is enforced. */
  APP_DATABASE_URL: z.string().min(1),

  /** Signing key for session cookies and one-time-code hashing. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(168),

  /**
   * Authentication rate limits. Defaults are deliberately strict for a real
   * deployment; they are configurable because an automated acceptance run
   * legitimately signs in far more often than a person does.
   */
  AUTH_REQUEST_LIMIT_PER_EMAIL: z.coerce.number().int().positive().default(5),
  AUTH_REQUEST_LIMIT_PER_IP: z.coerce.number().int().positive().default(20),
  AUTH_VERIFY_LIMIT_PER_EMAIL: z.coerce.number().int().positive().default(10),
  AUTH_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  /** SMTP. In development this points at the local Mailpit capture server. */
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(54325),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  MAIL_FROM: z.string().default('Waresport Sales Hub <no-reply@waresport.local>'),

  APP_URL: z.string().url().default('http://localhost:3000'),

  /**
   * Comma-separated allowlist of addresses permitted to bootstrap the first
   * owner account. Never the first public signup.
   */
  OWNER_BOOTSTRAP_EMAILS: z.string().default(''),

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

export function ownerBootstrapEmails(): string[] {
  return env()
    .OWNER_BOOTSTRAP_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
