import './_bootstrap-env';
import { asSystem, closeConnections } from '@/lib/db';
import {
  createUserAccount,
  roleNeedsPassword,
  UserCreationError,
  type AppRole,
} from '@/lib/auth/service';
import { generatePassword } from '@/lib/auth/password';

/**
 * Create a profile from the backend.
 *
 *   npm run user:create -- --email jordan@waresport.com --name "Jordan Lee" --role intern
 *   npm run user:create -- --email you@waresport.com --name "Your Name" --role owner
 *
 * Optional: --cohort "Fall 2026" (or a cohort id), --territory EAST (or an id),
 * --timezone America/New_York, --password "…". The account is active
 * immediately and appears on the sign-in screen.
 *
 * Interns sign in by picking their name. Admin and owner accounts need a
 * password: pass one, or let this print a generated one exactly once.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const USAGE =
  'Usage: npm run user:create -- --email <address> [--name "Full Name"] ' +
  '[--role intern|admin|owner] [--cohort <name or id>] [--territory <code or id>] ' +
  '[--timezone America/New_York] [--password "<at least 10 characters>"]';

/** Accept a human-friendly cohort name or territory code as well as a uuid. */
async function resolveCohort(value: string | undefined): Promise<string | null> {
  if (value === undefined) return null;
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      SELECT id FROM cohorts
      WHERE id::text = ${value} OR lower(name) = lower(${value})
      LIMIT 1`;
    if (row === undefined) throw new Error(`No cohort matches "${value}".`);
    return row.id;
  });
}

async function resolveTerritory(value: string | undefined): Promise<string | null> {
  if (value === undefined) return null;
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      SELECT id FROM territories
      WHERE id::text = ${value} OR upper(code) = upper(${value}) OR lower(name) = lower(${value})
      LIMIT 1`;
    if (row === undefined) throw new Error(`No territory matches "${value}".`);
    return row.id;
  });
}

async function main() {
  const email = arg('email');
  const role = (arg('role') ?? 'intern') as AppRole;

  if (email === undefined) throw new Error(USAGE);
  if (role !== 'owner' && role !== 'admin' && role !== 'intern') {
    throw new Error(`Unknown role "${role}". Use intern, admin or owner.`);
  }

  const cohortId = await resolveCohort(arg('cohort'));
  const territoryId = await resolveTerritory(arg('territory'));

  // An admin or owner cannot sign in without a password, so rather than
  // creating an account nobody can use, generate one and print it once.
  const supplied = arg('password') ?? null;
  const generated = supplied === null && roleNeedsPassword(role) ? generatePassword() : null;

  const created = await createUserAccount({
    email,
    role,
    fullName: arg('name') ?? null,
    timezone: arg('timezone') ?? null,
    cohortId,
    territoryId,
    password: supplied ?? generated,
  });

  console.info(`Created ${role} ${created.email} (${created.userId}).`);
  if (generated !== null) {
    console.info('');
    console.info(`  Password: ${generated}`);
    console.info('');
    console.info('  Save it now — it is not stored anywhere in readable form and is not');
    console.info('  shown again. Change it with:');
    console.info(`    npm run user:set-password -- --email ${created.email}`);
    console.info('');
  }
  console.info(
    roleNeedsPassword(role)
      ? 'They sign in at /sign-in by picking their name, then entering that password.'
      : 'They can sign in now by picking their name at /sign-in.',
  );
}

main()
  .catch((error: unknown) => {
    if (error instanceof UserCreationError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
