import './_bootstrap-env';
import { parseArgs } from 'node:util';
import { bootstrapOwner, BootstrapError } from '@/lib/auth/service';
import { closeConnections } from '@/lib/db';
import { ownerBootstrapEmails } from '@/lib/env';

/**
 * Secure owner bootstrap.
 *
 *   npm run bootstrap:owner -- --email owner@waresport.com --name "Alex Owner"
 *
 * The address must already appear in OWNER_BOOTSTRAP_EMAILS. This is the only
 * way an owner account comes into existence: there is no public signup path
 * that can produce one, and no shared admin password anywhere in the system.
 * The account still signs in with a one-time code sent to its own inbox.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      timezone: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (!values.email) {
    console.error(
      'Usage: npm run bootstrap:owner -- --email <address> [--name "Full Name"] [--timezone America/New_York]',
    );
    console.error(
      `Allowlisted addresses: ${ownerBootstrapEmails().join(', ') || '(none configured)'}`,
    );
    process.exit(1);
  }

  const result = await bootstrapOwner({
    email: values.email,
    fullName: values.name ?? null,
    timezone: values.timezone ?? null,
  });

  console.info(
    result.created
      ? `Created owner account for ${values.email}.`
      : `${values.email} is now an owner (account already existed).`,
  );
  console.info('Sign in at /sign-in — a one-time code will be emailed to that address.');
}

main()
  .catch((error: unknown) => {
    if (error instanceof BootstrapError) {
      console.error(`Bootstrap refused: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
