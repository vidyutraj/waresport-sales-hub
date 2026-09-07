import './_bootstrap-env';
import { closeConnections } from '@/lib/db';
import { setAccountRole, UserCreationError, type AppRole } from '@/lib/auth/service';

/**
 * Change an account's role.
 *
 *   npm run user:role -- --email you@waresport.com --role owner
 *
 * Owner is the only role that can grant or revoke admin, and the workspace
 * always keeps exactly one active owner. An admin or owner needs a password
 * first (`npm run user:set-password`), or this refuses rather than creating an
 * account that cannot sign in.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE = 'Usage: npm run user:role -- --email <address or id> --role owner|admin|intern';

async function main() {
  const emailOrId = arg('email') ?? arg('user');
  const role = arg('role') as AppRole | undefined;

  if (emailOrId === undefined || role === undefined) throw new Error(USAGE);
  if (role !== 'owner' && role !== 'admin' && role !== 'intern') {
    throw new Error(`Unknown role "${role}". Use intern, admin or owner.`);
  }

  const result = await setAccountRole({ emailOrId, role }).catch((error: unknown) => {
    if (error instanceof UserCreationError && error.code === 'password_required') {
      throw new Error(
        `${error.message} Run: npm run user:set-password -- --email ${emailOrId}`,
      );
    }
    throw error;
  });
  console.info(
    result.previousRole === role
      ? `${result.email} is already ${role}.`
      : `${result.email} is now ${role} (was ${result.previousRole}).`,
  );
}

main()
  .catch((error: unknown) => {
    if (error instanceof UserCreationError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
