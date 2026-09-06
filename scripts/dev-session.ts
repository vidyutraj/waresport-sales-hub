import './_bootstrap-env';
import { asSystem, closeConnections } from '@/lib/db';
import { env } from '@/lib/env';
import { generateSessionToken, hashToken } from '@/lib/auth/tokens';

/** Dev-only helper: mint a session cookie value for smoke-testing routes. */
async function main() {
  const email = process.argv[2] ?? 'owner@waresport.local';
  const token = generateSessionToken();
  await asSystem(async (tx) => {
    const [user] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    if (!user) throw new Error(`no user ${email}`);
    await tx`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${hashToken(token, env().AUTH_SECRET)}, now() + interval '2 hours')`;
  });
  console.log(token);
}
main().finally(() => closeConnections());
