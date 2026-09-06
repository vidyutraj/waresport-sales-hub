import { randomUUID } from 'node:crypto';
import { asSystem, asUser, type Tx } from '@/lib/db';

/**
 * Test fixtures.
 *
 * Every helper creates *synthetic* data with an obviously fake domain, so no
 * real prospect record ever ends up in a test database or a fixture file.
 * Each test namespaces its rows with a unique tag, so suites can share one
 * database without interfering.
 */

export const TEST_DOMAIN = 'example.test';

export function tag(): string {
  return randomUUID().slice(0, 8);
}

export async function createUser(input: {
  email?: string;
  role: 'owner' | 'admin' | 'intern';
  status?: 'invited' | 'active' | 'deactivated';
  fullName?: string;
  timezone?: string;
}): Promise<string> {
  const email = input.email ?? `${input.role}-${tag()}@${TEST_DOMAIN}`;
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO users (email, role, status, full_name, timezone, onboarding_completed_at, email_verified_at)
      VALUES (${email}, ${input.role}::app_role, ${input.status ?? 'active'}::user_status,
              ${input.fullName ?? `Test ${input.role}`}, ${input.timezone ?? 'America/New_York'},
              now(), now())
      RETURNING id`;
    return row!.id;
  });
}

export async function createCohort(input: {
  name?: string;
  startDate: string;
  weeksCount?: number;
  reportingTimezone?: string;
  createdBy: string;
}): Promise<string> {
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO cohorts (name, start_date, weeks_count, reporting_timezone, created_by)
      VALUES (${input.name ?? `Cohort ${tag()}`}, ${input.startDate}::date,
              ${input.weeksCount ?? 12}, ${input.reportingTimezone ?? 'America/New_York'},
              ${input.createdBy})
      RETURNING id`;
    await tx`
      INSERT INTO metric_policies (cohort_id, version, effective_from, created_by)
      VALUES (${row!.id}, 1, now() - interval '10 years', ${input.createdBy})`;
    return row!.id;
  });
}

export async function ensureTerritory(code: string, name?: string): Promise<string> {
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO territories (code, name)
      VALUES (${code}, ${name ?? code})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`;
    return row!.id;
  });
}

export async function addMembership(input: {
  userId: string;
  cohortId: string;
  territoryId?: string | null;
  joinedOn: string;
}): Promise<void> {
  await asSystem(async (tx) => {
    await tx`
      INSERT INTO cohort_memberships (user_id, cohort_id, territory_id, joined_on)
      VALUES (${input.userId}, ${input.cohortId}, ${input.territoryId ?? null}, ${input.joinedOn}::date)
      ON CONFLICT (user_id, cohort_id) DO UPDATE
        SET territory_id = EXCLUDED.territory_id, joined_on = EXCLUDED.joined_on, left_on = NULL`;
  });
}

export async function createOrganization(input: {
  name?: string;
  city?: string | null;
  state?: string | null;
  territoryId?: string | null;
  createdBy: string;
}): Promise<string> {
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO organizations (name, city, state, territory_id, created_by, source)
      VALUES (${input.name ?? `Test Club ${tag()}`}, ${input.city ?? 'Testville'},
              ${input.state ?? 'NC'}, ${input.territoryId ?? null}, ${input.createdBy}, 'test_fixture')
      RETURNING id`;
    return row!.id;
  });
}

export async function createContact(input: {
  organizationId: string;
  email?: string | null;
  fullName?: string;
  phoneRaw?: string | null;
  createdBy: string;
}): Promise<string> {
  return asSystem(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO contacts (organization_id, full_name, email, email_valid, phone_raw, phone_valid, created_by)
      VALUES (${input.organizationId}, ${input.fullName ?? `Test Contact ${tag()}`},
              ${input.email ?? `contact-${tag()}@${TEST_DOMAIN}`}, true,
              ${input.phoneRaw ?? '919-732-4454'}, true, ${input.createdBy})
      RETURNING id`;
    return row!.id;
  });
}

export async function assignOrg(input: {
  organizationId: string;
  internUserId: string;
  assignedBy: string;
}): Promise<void> {
  await asSystem(async (tx) => {
    await tx`
      UPDATE organization_assignments SET unassigned_at = now()
      WHERE organization_id = ${input.organizationId} AND unassigned_at IS NULL`;
    await tx`
      INSERT INTO organization_assignments (organization_id, intern_user_id, assigned_by)
      VALUES (${input.organizationId}, ${input.internUserId}, ${input.assignedBy})`;
  });
}

export async function createMeeting(input: {
  organizationId: string;
  creditedUserId: string;
  cohortId: string;
  status?: 'scheduled' | 'pending_verification' | 'verified_held' | 'cancelled' | 'no_show';
  scheduledStartAt?: Date;
  heldAt?: Date | null;
  verifiedBy?: string | null;
}): Promise<string> {
  return asSystem(async (tx) => {
    const status = input.status ?? 'scheduled';
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO meetings (
        organization_id, credited_user_id, booked_by_user_id, cohort_id,
        scheduled_start_at, scheduled_timezone, status, held_at, verified_at, verified_by
      ) VALUES (
        ${input.organizationId}, ${input.creditedUserId}, ${input.creditedUserId}, ${input.cohortId},
        ${input.scheduledStartAt ?? new Date(Date.now() - 86_400_000)}, 'America/New_York',
        ${status}::meeting_status, ${input.heldAt ?? null},
        ${status === 'verified_held' ? new Date() : null},
        ${status === 'verified_held' ? (input.verifiedBy ?? input.creditedUserId) : null}
      )
      RETURNING id`;
    return row!.id;
  });
}

/** Create N verified-held meetings for an intern, for compensation tests. */
export async function createVerifiedMeetings(input: {
  count: number;
  creditedUserId: string;
  cohortId: string;
  createdBy: string;
  heldAt: Date;
}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < input.count; i += 1) {
    const orgId = await createOrganization({
      name: `Verified Club ${tag()}`,
      createdBy: input.createdBy,
    });
    ids.push(
      await createMeeting({
        organizationId: orgId,
        creditedUserId: input.creditedUserId,
        cohortId: input.cohortId,
        status: 'verified_held',
        heldAt: input.heldAt,
        verifiedBy: input.createdBy,
      }),
    );
  }
  return ids;
}

export async function countRows(table: string, where: string): Promise<number> {
  return asSystem(async (tx) => {
    const [row] = await tx.unsafe<{ c: string }[]>(
      `SELECT count(*)::text AS c FROM ${table} WHERE ${where}`,
    );
    return Number(row?.c ?? 0);
  });
}

/** Run a callback as a given user against the RLS-enforced connection. */
export async function as<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return asUser(userId, fn);
}

/** Assert that a promise rejects, returning the error for inspection. */
export async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to be rejected, but it succeeded.');
}

export function pgCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return null;
}
