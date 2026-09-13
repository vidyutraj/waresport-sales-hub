import '@/lib/server-guard';
import { attempt, isUniqueViolation, type Tx } from '@/lib/db';
import { normalizeEmail } from '@/lib/domain/normalize';
import { seedCohortDefaultTargets } from '@/lib/queries/program';
import { revokeAllSessionsForUser } from '@/lib/auth/service';
import { recordAudit } from './audit';

/**
 * Administrative operations: accounts, cohorts, territories and targets.
 *
 * Callers must already have passed `assertAdmin()` / `assertOwner()`. These
 * functions run on the RLS-enforced connection, so the database independently
 * rejects anything an intern could contrive to call.
 */

export class AdminError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'already_member'
      | 'not_found'
      | 'not_permitted'
      | 'last_owner'
      | 'invalid_input'
      | 'conflict',
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type PersonRow = {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'intern';
  status: 'invited' | 'active' | 'deactivated';
  fullName: string | null;
  preferredName: string | null;
  timezone: string;
  waresportOutreachEmail: string | null;
  cohortId: string | null;
  cohortName: string | null;
  territoryId: string | null;
  territoryCode: string | null;
  joinedOn: string | null;
  onboardingCompletedAt: Date | null;
  lastSignInAt: Date | null;
  trainingCompleted: number;
  trainingTotal: number;
};

export async function listPeople(
  tx: Tx,
  input: { role?: 'owner' | 'admin' | 'intern' | null; cohortId?: string | null } = {},
): Promise<PersonRow[]> {
  const rows = await tx<
    {
      id: string;
      email: string;
      role: 'owner' | 'admin' | 'intern';
      status: 'invited' | 'active' | 'deactivated';
      full_name: string | null;
      preferred_name: string | null;
      timezone: string;
      waresport_outreach_email: string | null;
      cohort_id: string | null;
      cohort_name: string | null;
      territory_id: string | null;
      territory_code: string | null;
      joined_on: string | null;
      onboarding_completed_at: Date | null;
      last_sign_in_at: Date | null;
      training_completed: string;
      training_total: string;
    }[]
  >`
    SELECT u.id, u.email::text AS email, u.role, u.status, u.full_name, u.preferred_name,
           u.timezone, u.waresport_outreach_email::text AS waresport_outreach_email,
           m.cohort_id, c.name AS cohort_name, m.territory_id, t.code AS territory_code,
           m.joined_on::text AS joined_on, u.onboarding_completed_at, u.last_sign_in_at,
           (SELECT count(*) FROM training_completions tc WHERE tc.user_id = u.id)::text AS training_completed,
           (SELECT count(*) FROM training_topics tt WHERE tt.is_active)::text AS training_total
    FROM users u
    LEFT JOIN cohort_memberships m ON m.user_id = u.id AND m.left_on IS NULL
    LEFT JOIN cohorts c ON c.id = m.cohort_id
    LEFT JOIN territories t ON t.id = m.territory_id
    WHERE (${input.role ?? null}::text IS NULL OR u.role::text = ${input.role ?? null})
      AND (${input.cohortId ?? null}::uuid IS NULL OR m.cohort_id = ${input.cohortId ?? null})
      -- Retired placeholders: accounts that could not be deleted (their audit
      -- rows are append-only) and were moved onto the reserved .invalid domain
      -- to free the real address. They are not people, so they are not listed.
      -- A genuinely deactivated account keeps its real email and stays visible.
      AND u.email::text NOT LIKE '%@%.invalid'
    ORDER BY
      CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
      coalesce(u.full_name, u.email::text)`;

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.status,
    fullName: r.full_name,
    preferredName: r.preferred_name,
    timezone: r.timezone,
    waresportOutreachEmail: r.waresport_outreach_email,
    cohortId: r.cohort_id,
    cohortName: r.cohort_name,
    territoryId: r.territory_id,
    territoryCode: r.territory_code,
    joinedOn: r.joined_on,
    onboardingCompletedAt: r.onboarding_completed_at,
    lastSignInAt: r.last_sign_in_at,
    trainingCompleted: Number(r.training_completed),
    trainingTotal: Number(r.training_total),
  }));
}

export async function setUserActive(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    userId: string;
    active: boolean;
    reason?: string | null;
  },
): Promise<void> {
  const [before] = await tx<{ status: string; role: string }[]>`
    SELECT status::text, role::text FROM users WHERE id = ${input.userId}`;
  if (before === undefined) throw new AdminError('That account no longer exists.', 'not_found');

  try {
    await tx`
      UPDATE users SET status = ${input.active ? 'active' : 'deactivated'}::user_status
      WHERE id = ${input.userId}`;
  } catch (error) {
    if (isLastOwnerViolation(error)) {
      throw new AdminError('The workspace must keep at least one active owner.', 'last_owner');
    }
    throw error;
  }

  // Deactivation must take effect immediately, even for a live session.
  if (!input.active) await revokeAllSessionsForUser(input.userId);

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.active ? 'user.activated' : 'user.deactivated',
    entityType: 'user',
    entityId: input.userId,
    before: { status: before.status },
    after: { status: input.active ? 'active' : 'deactivated' },
    reason: input.reason ?? null,
  });
}

function isLastOwnerViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    String((error as { message: unknown }).message).includes('last active owner')
  );
}

/** Owner-only. Grants or revokes admin. Never reachable by an admin. */
export async function setUserRole(
  tx: Tx,
  input: { actorUserId: string; userId: string; role: 'admin' | 'intern'; reason: string },
): Promise<void> {
  if (input.userId === input.actorUserId) {
    throw new AdminError('You cannot change your own role.', 'not_permitted');
  }
  const [before] = await tx<
    { role: string }[]
  >`SELECT role::text FROM users WHERE id = ${input.userId}`;
  if (before === undefined) throw new AdminError('That account no longer exists.', 'not_found');

  try {
    await tx`UPDATE users SET role = ${input.role}::app_role WHERE id = ${input.userId}`;
  } catch (error) {
    if (isLastOwnerViolation(error)) {
      throw new AdminError('The workspace must keep at least one active owner.', 'last_owner');
    }
    throw error;
  }

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: 'owner',
    action: 'user.role_changed',
    entityType: 'user',
    entityId: input.userId,
    before: { role: before.role },
    after: { role: input.role },
    reason: input.reason,
  });
}

export async function setOutreachEmail(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    userId: string;
    outreachEmail: string | null;
  },
): Promise<void> {
  const email = input.outreachEmail === null ? null : normalizeEmail(input.outreachEmail);
  await tx`UPDATE users SET waresport_outreach_email = ${email} WHERE id = ${input.userId}`;
  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'user.outreach_email_set',
    entityType: 'user',
    entityId: input.userId,
    after: { waresportOutreachEmail: email },
  });
}

export async function assignCohortMembership(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    userId: string;
    cohortId: string;
    territoryId: string | null;
    joinedOn: string;
  },
): Promise<void> {
  await tx`
    INSERT INTO cohort_memberships (user_id, cohort_id, territory_id, joined_on)
    VALUES (${input.userId}, ${input.cohortId}, ${input.territoryId}, ${input.joinedOn}::date)
    ON CONFLICT (user_id, cohort_id)
    DO UPDATE SET territory_id = EXCLUDED.territory_id, joined_on = EXCLUDED.joined_on, left_on = NULL`;

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'membership.assigned',
    entityType: 'user',
    entityId: input.userId,
    after: { cohortId: input.cohortId, territoryId: input.territoryId, joinedOn: input.joinedOn },
  });
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export async function createCohort(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    name: string;
    startDate: string;
    weeksCount: number;
    reportingTimezone: string;
  },
): Promise<{ cohortId: string }> {
  const created = await attempt(tx, async (sp) => {
    const [row] = await sp<{ id: string }[]>`
      INSERT INTO cohorts (name, start_date, weeks_count, reporting_timezone, created_by)
      VALUES (${input.name}, ${input.startDate}::date, ${input.weeksCount},
              ${input.reportingTimezone}, ${input.actorUserId})
      RETURNING id`;
    return row;
  });
  if (!created.ok) {
    if (isUniqueViolation(created.error)) {
      throw new AdminError('A cohort with that name already exists.', 'conflict');
    }
    throw created.error;
  }
  const row = created.value;
  if (row === undefined) throw new AdminError('Could not create that cohort.', 'invalid_input');

  {
    // Start from the figures printed in the program guide.
    await seedCohortDefaultTargets(tx, row.id, input.weeksCount, input.actorUserId);
    await tx`
      INSERT INTO metric_policies (cohort_id, version, effective_from, notes, created_by)
      VALUES (${row.id}, 1, now(),
              'Default policy: initial and follow-up emails both count toward the weekly email target; only a first-time LinkedIn connection request counts toward the request target.',
              ${input.actorUserId})`;

    await recordAudit(tx, {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: 'cohort.created',
      entityType: 'cohort',
      entityId: row.id,
      after: {
        name: input.name,
        startDate: input.startDate,
        weeksCount: input.weeksCount,
        reportingTimezone: input.reportingTimezone,
      },
    });
  }

  return { cohortId: row.id };
}

export async function updateCohort(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    cohortId: string;
    name: string;
    startDate: string;
    weeksCount: number;
    reportingTimezone: string;
    expectedRowVersion: number;
  },
): Promise<void> {
  const [before] = await tx<
    {
      name: string;
      start_date: string;
      weeks_count: number;
      reporting_timezone: string;
      row_version: number;
    }[]
  >`
    SELECT name, start_date::text AS start_date, weeks_count, reporting_timezone, row_version
    FROM cohorts WHERE id = ${input.cohortId} FOR UPDATE`;
  if (before === undefined) throw new AdminError('That cohort no longer exists.', 'not_found');
  // Optimistic locking: a stale editor is rejected, never silently applied.
  if (before.row_version !== input.expectedRowVersion) {
    throw new AdminError(
      'Someone else changed this cohort while you were editing. Reload and re-apply your change.',
      'conflict',
    );
  }

  await tx`
    UPDATE cohorts
    SET name = ${input.name}, start_date = ${input.startDate}::date,
        weeks_count = ${input.weeksCount}, reporting_timezone = ${input.reportingTimezone}
    WHERE id = ${input.cohortId}`;

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'cohort.updated',
    entityType: 'cohort',
    entityId: input.cohortId,
    before: {
      name: before.name,
      startDate: before.start_date,
      weeksCount: before.weeks_count,
      reportingTimezone: before.reporting_timezone,
    },
    after: {
      name: input.name,
      startDate: input.startDate,
      weeksCount: input.weeksCount,
      reportingTimezone: input.reportingTimezone,
    },
  });
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export async function setWeeklyTarget(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    cohortId: string;
    /** null sets the cohort default; a user id sets a per-intern override. */
    userId: string | null;
    weekNumber: number;
    emailTarget: number;
    linkedinTarget: number;
    emailDailyPace: number;
    linkedinDailyPace: number;
    reason?: string | null;
  },
): Promise<void> {
  if (input.emailTarget < 0 || input.linkedinTarget < 0) {
    throw new AdminError('Targets cannot be negative.', 'invalid_input');
  }

  const [before] = await tx<{ email_target: number; linkedin_target: number }[]>`
    SELECT email_target, linkedin_target FROM weekly_targets
    WHERE cohort_id = ${input.cohortId} AND week_number = ${input.weekNumber}
      AND user_id IS NOT DISTINCT FROM ${input.userId}`;

  if (input.userId === null) {
    await tx`
      INSERT INTO weekly_targets
        (cohort_id, user_id, week_number, email_target, linkedin_target,
         email_daily_pace, linkedin_daily_pace, created_by)
      VALUES (${input.cohortId}, NULL, ${input.weekNumber}, ${input.emailTarget},
              ${input.linkedinTarget}, ${input.emailDailyPace}, ${input.linkedinDailyPace},
              ${input.actorUserId})
      ON CONFLICT (cohort_id, week_number) WHERE user_id IS NULL
      DO UPDATE SET email_target = EXCLUDED.email_target,
                    linkedin_target = EXCLUDED.linkedin_target,
                    email_daily_pace = EXCLUDED.email_daily_pace,
                    linkedin_daily_pace = EXCLUDED.linkedin_daily_pace`;
  } else {
    await tx`
      INSERT INTO weekly_targets
        (cohort_id, user_id, week_number, email_target, linkedin_target,
         email_daily_pace, linkedin_daily_pace, created_by)
      VALUES (${input.cohortId}, ${input.userId}, ${input.weekNumber}, ${input.emailTarget},
              ${input.linkedinTarget}, ${input.emailDailyPace}, ${input.linkedinDailyPace},
              ${input.actorUserId})
      ON CONFLICT (cohort_id, user_id, week_number) WHERE user_id IS NOT NULL
      DO UPDATE SET email_target = EXCLUDED.email_target,
                    linkedin_target = EXCLUDED.linkedin_target,
                    email_daily_pace = EXCLUDED.email_daily_pace,
                    linkedin_daily_pace = EXCLUDED.linkedin_daily_pace`;
  }

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.userId === null ? 'target.cohort_default_set' : 'target.intern_override_set',
    entityType: 'weekly_target',
    entityId: `${input.cohortId}:${input.userId ?? 'default'}:${input.weekNumber}`,
    before: before
      ? { emailTarget: before.email_target, linkedinTarget: before.linkedin_target }
      : null,
    after: { emailTarget: input.emailTarget, linkedinTarget: input.linkedinTarget },
    reason: input.reason ?? null,
  });
}

export async function setMetricPolicy(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    cohortId: string;
    emailCountsFollowups: boolean;
    linkedinCountsFirstRequestOnly: boolean;
    notes?: string | null;
  },
): Promise<void> {
  const [latest] = await tx<{ version: number }[]>`
    SELECT version FROM metric_policies WHERE cohort_id = ${input.cohortId}
    ORDER BY version DESC LIMIT 1`;
  const nextVersion = (latest?.version ?? 0) + 1;

  // A new version, never an edit: past weeks keep the rules they were worked
  // under. The change takes effect from now onward.
  await tx`
    INSERT INTO metric_policies
      (cohort_id, version, effective_from, email_counts_followups,
       linkedin_counts_first_request_only, notes, created_by)
    VALUES (${input.cohortId}, ${nextVersion}, now(), ${input.emailCountsFollowups},
            ${input.linkedinCountsFirstRequestOnly}, ${input.notes ?? null}, ${input.actorUserId})`;

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'metric_policy.versioned',
    entityType: 'cohort',
    entityId: input.cohortId,
    after: {
      version: nextVersion,
      emailCountsFollowups: input.emailCountsFollowups,
      linkedinCountsFirstRequestOnly: input.linkedinCountsFirstRequestOnly,
    },
    reason: input.notes ?? null,
  });
}

export async function setTerritoryStates(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    territoryId: string;
    stateCodes: readonly string[];
  },
): Promise<void> {
  for (const code of input.stateCodes) {
    await tx`
      INSERT INTO territory_states (state_code, territory_id, updated_by)
      VALUES (${code}, ${input.territoryId}, ${input.actorUserId})
      ON CONFLICT (state_code)
      DO UPDATE SET territory_id = EXCLUDED.territory_id,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = now()`;
  }
  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'territory.states_mapped',
    entityType: 'territory',
    entityId: input.territoryId,
    after: { stateCodes: [...input.stateCodes] },
  });
}
