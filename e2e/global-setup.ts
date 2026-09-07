import { config } from 'dotenv';
import { resolve } from 'node:path';
import postgres from 'postgres';

config({ path: resolve(process.cwd(), '.env.local'), quiet: true });
config({ path: resolve(process.cwd(), '.env'), quiet: true });

/**
 * E2E global setup.
 *
 * Truncates the workspace and creates one owner account, so every run starts
 * from the documented "clean database, create the first account" state.
 * Everything else — cohort, interns, leads — is created through the UI by the
 * tests themselves, which is the point.
 */

const OWNER_EMAIL = 'owner@waresport.local';

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

export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Run `npm run db:up && npm run db:migrate`.');
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error('E2E refuses to run against a non-local database.');
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

    // Territories and training topics come from the standard seed.
    await sql`
      INSERT INTO territories (code, name) VALUES ('EAST', 'East'), ('WEST', 'West')
      ON CONFLICT (code) DO NOTHING`;
    const territories = await sql<{ id: string; code: string }[]>`
      SELECT id, code FROM territories WHERE code IN ('EAST', 'WEST')`;
    const east = territories.find((t) => t.code === 'EAST')!;
    const west = territories.find((t) => t.code === 'WEST')!;
    await sql`
      INSERT INTO territory_states (state_code, territory_id)
      SELECT s, ${east.id} FROM unnest(ARRAY['NC','SC','VA','GA','NY','PA','FL','MA','NJ','OH']::text[]) AS s
      ON CONFLICT (state_code) DO UPDATE SET territory_id = EXCLUDED.territory_id`;
    await sql`
      INSERT INTO territory_states (state_code, territory_id)
      SELECT s, ${west.id} FROM unnest(ARRAY['CA','TX','WA','OR','AZ','CO','NV','UT','ID','MT']::text[]) AS s
      ON CONFLICT (state_code) DO UPDATE SET territory_id = EXCLUDED.territory_id`;

    // The documented first account, applied directly so the suite does not
    // shell out. It is the same INSERT `npm run user:create` performs.
    await sql`
      INSERT INTO users (email, role, status, full_name, timezone,
                         email_verified_at, onboarding_completed_at, program_acknowledged_at)
      VALUES (${OWNER_EMAIL}, 'owner', 'active', 'Alex Owner', 'America/New_York',
              now(), now(), now())
      ON CONFLICT (email) DO UPDATE SET role = 'owner', status = 'active'`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
