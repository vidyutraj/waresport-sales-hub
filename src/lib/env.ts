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

/**
 * The placeholder in .env.example. A deployment that still carries it would
 * have a publicly known session-signing key, so production refuses to boot.
 */
const DEV_PLACEHOLDER_SECRET = 'dev-only-insecure-secret-change-me-0123456789abcdef';

/**
 * Loopback, or a provider's private network.
 *
 * `.internal` and `.flycast` are Fly's private DNS (the latter is its private
 * load balancer); Railway and Render use `.internal` too. Traffic to these
 * never leaves the provider's private network, so requiring TLS on top of it
 * would be theatre — and would block a perfectly good deployment.
 */
function isPrivateHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.internal') ||
      host.endsWith('.flycast') ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

function requiresTls(url: string): boolean {
  if (isPrivateHost(url)) return false;
  return !/[?&](sslmode=(require|verify-ca|verify-full)|ssl=true)/.test(url);
}

/**
 * Real-deployment invariants.
 *
 * These are the mistakes that stay invisible until they matter: shipping the
 * example secret, serving over plain HTTP so session cookies lose their Secure
 * flag, or talking to a hosted database without TLS. Failing at boot beats all
 * three.
 *
 * Scoped to a production build served on a real host. A production build on
 * loopback is the acceptance suite and `npm run build` locally, which are
 * meant to run without certificates or secrets.
 */
function assertDeploymentSafety(env: AppEnv): void {
  if (env.NODE_ENV !== 'production') return;
  if (isPrivateHost(env.APP_URL)) return;
  const problems: string[] = [];

  if (env.AUTH_SECRET === DEV_PLACEHOLDER_SECRET) {
    problems.push('AUTH_SECRET is still the example value. Generate one: openssl rand -base64 48');
  }
  if (!env.APP_URL.startsWith('https://')) {
    problems.push(
      `APP_URL must be https in production (got ${env.APP_URL}). Session cookies are only marked Secure when it is.`,
    );
  }
  if (requiresTls(env.DATABASE_URL)) {
    problems.push('DATABASE_URL must use TLS (add ?sslmode=require) unless it is a private host.');
  }
  if (requiresTls(env.APP_DATABASE_URL)) {
    problems.push(
      'APP_DATABASE_URL must use TLS (add ?sslmode=require) unless it is a private host.',
    );
  }
  if (env.DATABASE_URL === env.APP_DATABASE_URL) {
    problems.push(
      'APP_DATABASE_URL must be the unprivileged waresport_app role, not the owning connection: ' +
        'row level security does not apply to a table owner.',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Unsafe production configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  assertDeploymentSafety(parsed.data);
  cached = parsed.data;
  return cached;
}

/** Test helper: forget the memoised value after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}
