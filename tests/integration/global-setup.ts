import { config } from 'dotenv';
import { resolve } from 'node:path';
import postgres from 'postgres';

config({ path: resolve(process.cwd(), '.env.test'), quiet: true });
config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
config({ path: resolve(process.cwd(), '.env'), quiet: true });

/**
 * Global setup for the integration suite.
 *
 * Truncates every business table before the run so results are deterministic
 * and independent of whatever a previous manual import left behind. The schema
 * itself is left in place — migrations are applied separately by
 * `npm run db:migrate`, and this never touches a database that does not look
 * like the local development one.
 */
const BUSINESS_TABLES = [
  'audit_events',
  'payout_adjustments',
  'payout_ledger',
  'meeting_events',
  'meetings',
  'prospect_events',
  'follow_ups',
  'activity_events',
  'linkedin_prospects',
  'organization_status_events',
  'suppressions',
  'import_source_keys',
  'import_rows',
  'import_batches',
  'organization_assignments',
  'contacts',
  'organizations',
  'weekly_target_snapshots',
  'weekly_targets',
  'metric_policies',
  'reflections',
  'project_submissions',
  'project_assignments',
  'projects',
  'intern_provisioning',
  'training_completions',
  'cohort_memberships',
  'sessions',
  'cohorts',
  'users',
];

export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL is not set; run `npm run db:up && npm run db:migrate` first.');

  // Guardrail: refuse to truncate anything that is not the local test database.
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error(
      'Integration tests refuse to run against a non-local database. ' +
        'Point DATABASE_URL at the local docker-compose PostgreSQL.',
    );
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [schema] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'users') AS exists`;
    if (schema?.exists !== true) {
      throw new Error('Schema is missing. Run `npm run db:up && npm run db:migrate` first.');
    }
    await sql.unsafe(`TRUNCATE ${BUSINESS_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
