import './_bootstrap-env';
import { closeConnections } from '@/lib/db';
import { setAccountActive, UserCreationError } from '@/lib/auth/service';

/**
 * Retire an account, or bring one back.
 *
 *   npm run user:deactivate -- --email someone@waresport.com
 *   npm run user:deactivate -- --email someone@waresport.com --reactivate
 *
 * A deactivated account disappears from the sign-in screen and its live
 * sessions stop working. Nothing it produced is deleted — imports, activity and
 * meetings stay attributed to it — which is why accounts are retired rather
 * than removed.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE = 'Usage: npm run user:deactivate -- --email <address or id> [--reactivate]';

async function main() {
  const emailOrId = arg('email') ?? arg('user');
  if (emailOrId === undefined) throw new Error(USAGE);
  const active = process.argv.includes('--reactivate');

  const result = await setAccountActive({ emailOrId, active });
  console.info(
    active
      ? `${result.email} is active again and back on the sign-in screen.`
      : `${result.email} is deactivated. It is off the sign-in screen and signed out everywhere; its history is untouched.`,
  );
}

main()
  .catch((error: unknown) => {
    if (error instanceof UserCreationError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
