import './_bootstrap-env';
import { closeConnections } from '@/lib/db';
import { setUserPassword, UserCreationError } from '@/lib/auth/service';
import { generatePassword, WeakPasswordError } from '@/lib/auth/password';

/**
 * Set or replace an account's password.
 *
 *   npm run user:set-password -- --email you@waresport.com --password "correct horse battery"
 *   npm run user:set-password -- --email you@waresport.com          # generates one
 *
 * Every live session for that account is revoked, so the old password (and
 * anyone still signed in with it) stops working immediately.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE =
  'Usage: npm run user:set-password -- --email <address or id> [--password "<at least 10 characters>"]';

async function main() {
  const emailOrId = arg('email') ?? arg('user');
  if (emailOrId === undefined) throw new Error(USAGE);

  const supplied = arg('password');
  const generated = supplied === undefined ? generatePassword() : null;
  const password = supplied ?? generated!;

  const user = await setUserPassword({ emailOrId, password });

  console.info(`Password set for ${user.email}. Existing sessions were signed out.`);
  if (generated !== null) {
    console.info('');
    console.info(`  Password: ${generated}`);
    console.info('');
    console.info('  Save it now — it is stored only as a hash and is not shown again.');
    console.info('');
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof UserCreationError || error instanceof WeakPasswordError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
