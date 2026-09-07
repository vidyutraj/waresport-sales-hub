import './_bootstrap-env';
import { asSystem, closeConnections } from '@/lib/db';
import { env } from '@/lib/env';
import { generateSessionToken, hashToken } from '@/lib/auth/tokens';

/**
 * Development-only helper: mint a session cookie value for smoke-testing
 * routes without going through the sign-in screen.
 *
 * This bypasses authentication entirely — including the admin password — so it
 * refuses to run against anything that looks like a real deployment. Guarded
 * twice on purpose: NODE_ENV alone is easy to set by accident.
 */

function refuseOutsideDevelopment(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('dev-session is a development helper and never runs in production.');
  }
  const host = (() => {
    try {
      return new URL(env().DATABASE_URL).hostname;
    } catch {
      return '';
    }
  })();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local) {
    throw new Error(
      `dev-session refuses to mint a session against a non-local database (${host || 'unknown host'}).`,
    );
  }
}

async function main() {
  refuseOutsideDevelopment();

  const email = process.argv[2] ?? 'owner@waresport.local';
  const token = generateSessionToken();
  await asSystem(async (tx) => {
    const [user] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    if (!user) throw new Error(`no user ${email}`);
    await tx`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${hashToken(token, env().AUTH_SECRET)}, now() + interval '2 hours')`;
  });
  console.info(token);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
