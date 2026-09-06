import '@/lib/server-guard';
import type { Tx } from '@/lib/db';
import {
  DEFAULT_PROGRAM_WEEKS,
  locateWeek,
  programDefaultTargets,
  programWeek,
  type Cohort,
  type ProgramTargets,
  type ProgramWeek,
} from '@/lib/domain/program';
import { DEFAULT_METRIC_POLICY, type MetricPolicy } from '@/lib/domain/metrics';

/**
 * Cohort, membership, territory and target resolution.
 *
 * Every dashboard, export and API response resolves targets through
 * `resolveWeeklyTarget` so a single definition backs all of them.
 */

export type CohortRow = Cohort & { isActive: boolean };

export async function listCohorts(tx: Tx): Promise<CohortRow[]> {
  const rows = await tx<
    {
      id: string;
      name: string;
      start_date: string;
      weeks_count: number;
      reporting_timezone: string;
      is_active: boolean;
    }[]
  >`
    SELECT id, name, start_date::text AS start_date, weeks_count, reporting_timezone, is_active
    FROM cohorts ORDER BY start_date DESC, name`;
  return rows.map(toCohort);
}

export async function getCohort(tx: Tx, cohortId: string): Promise<CohortRow | null> {
  const [row] = await tx<
    {
      id: string;
      name: string;
      start_date: string;
      weeks_count: number;
      reporting_timezone: string;
      is_active: boolean;
    }[]
  >`
    SELECT id, name, start_date::text AS start_date, weeks_count, reporting_timezone, is_active
    FROM cohorts WHERE id = ${cohortId}`;
  return row ? toCohort(row) : null;
}

function toCohort(row: {
  id: string;
  name: string;
  start_date: string;
  weeks_count: number;
  reporting_timezone: string;
  is_active: boolean;
}): CohortRow {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    weeksCount: row.weeks_count,
    reportingTimezone: row.reporting_timezone,
    isActive: row.is_active,
  };
}

export type Membership = {
  cohort: CohortRow;
  territoryId: string | null;
  territoryCode: string | null;
  territoryName: string | null;
  joinedOn: string;
  leftOn: string | null;
};

/** The intern's current cohort membership, or null if they have none. */
export async function getActiveMembership(tx: Tx, userId: string): Promise<Membership | null> {
  const [row] = await tx<
    {
      id: string;
      name: string;
      start_date: string;
      weeks_count: number;
      reporting_timezone: string;
      is_active: boolean;
      territory_id: string | null;
      territory_code: string | null;
      territory_name: string | null;
      joined_on: string;
      left_on: string | null;
    }[]
  >`
    SELECT c.id, c.name, c.start_date::text AS start_date, c.weeks_count,
           c.reporting_timezone, c.is_active,
           t.id AS territory_id, t.code AS territory_code, t.name AS territory_name,
           m.joined_on::text AS joined_on, m.left_on::text AS left_on
    FROM cohort_memberships m
    JOIN cohorts c ON c.id = m.cohort_id
    LEFT JOIN territories t ON t.id = m.territory_id
    WHERE m.user_id = ${userId} AND m.left_on IS NULL
    LIMIT 1`;
  if (row === undefined) return null;
  return {
    cohort: toCohort(row),
    territoryId: row.territory_id,
    territoryCode: row.territory_code,
    territoryName: row.territory_name,
    joinedOn: row.joined_on,
    leftOn: row.left_on,
  };
}

export type Territory = { id: string; code: string; name: string; description: string | null };

export async function listTerritories(tx: Tx): Promise<Territory[]> {
  return tx<Territory[]>`
    SELECT id, code, name, description FROM territories
    WHERE is_active = true ORDER BY code`;
}

export async function territoryForState(tx: Tx, state: string | null): Promise<string | null> {
  if (!state) return null;
  const [row] = await tx<{ territory_id: string }[]>`
    SELECT territory_id FROM territory_states WHERE state_code = ${state}`;
  return row?.territory_id ?? null;
}

export async function stateTerritoryMap(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx<{ state_code: string; territory_id: string }[]>`
    SELECT state_code, territory_id FROM territory_states`;
  return new Map(rows.map((r) => [r.state_code, r.territory_id]));
}

// ---------------------------------------------------------------------------
// Metric policy
// ---------------------------------------------------------------------------

/** The policy in force at `at`. Falls back to the documented default. */
export async function metricPolicyAt(tx: Tx, cohortId: string, at: Date): Promise<MetricPolicy> {
  const [row] = await tx<
    {
      version: number;
      email_counts_followups: boolean;
      linkedin_counts_first_request_only: boolean;
    }[]
  >`
    SELECT version, email_counts_followups, linkedin_counts_first_request_only
    FROM metric_policies
    WHERE cohort_id = ${cohortId} AND effective_from <= ${at}
    ORDER BY effective_from DESC, version DESC
    LIMIT 1`;
  if (row === undefined) return DEFAULT_METRIC_POLICY;
  return {
    version: row.version,
    emailCountsFollowups: row.email_counts_followups,
    linkedinCountsFirstRequestOnly: row.linkedin_counts_first_request_only,
  };
}

// ---------------------------------------------------------------------------
// Weekly targets
// ---------------------------------------------------------------------------

export type TargetSource = 'intern_override' | 'cohort_default' | 'program_default';

export type EffectiveTarget = ProgramTargets & {
  weekNumber: number;
  source: TargetSource;
  /** True once the week has ended and the values were frozen. */
  frozen: boolean;
};

/**
 * Resolve the target for one intern in one week.
 *
 * Order: frozen snapshot -> per-intern override -> cohort default ->
 * the figures printed in the program guide.
 *
 * Once a week has fully elapsed the resolved values are written to
 * `weekly_target_snapshots`. Later edits to cohort defaults therefore change
 * future weeks only; they never silently rewrite what an intern was working
 * toward at the time.
 */
export async function resolveWeeklyTarget(
  tx: Tx,
  cohort: Cohort,
  userId: string,
  weekNumber: number,
  now: Date,
): Promise<EffectiveTarget> {
  const [snapshot] = await tx<
    {
      email_target: number;
      linkedin_target: number;
      email_daily_pace: number;
      linkedin_daily_pace: number;
      source: TargetSource;
    }[]
  >`
    SELECT email_target, linkedin_target, email_daily_pace, linkedin_daily_pace, source
    FROM weekly_target_snapshots
    WHERE cohort_id = ${cohort.id} AND user_id = ${userId} AND week_number = ${weekNumber}`;

  if (snapshot !== undefined) {
    return {
      weekNumber,
      emailTarget: snapshot.email_target,
      linkedinTarget: snapshot.linkedin_target,
      emailDailyPace: snapshot.email_daily_pace,
      linkedinDailyPace: snapshot.linkedin_daily_pace,
      source: snapshot.source,
      frozen: true,
    };
  }

  const rows = await tx<
    {
      user_id: string | null;
      email_target: number;
      linkedin_target: number;
      email_daily_pace: number;
      linkedin_daily_pace: number;
    }[]
  >`
    SELECT user_id, email_target, linkedin_target, email_daily_pace, linkedin_daily_pace
    FROM weekly_targets
    WHERE cohort_id = ${cohort.id}
      AND week_number = ${weekNumber}
      AND (user_id = ${userId} OR user_id IS NULL)`;

  const override = rows.find((r) => r.user_id !== null);
  const cohortDefault = rows.find((r) => r.user_id === null);
  const chosen = override ?? cohortDefault;

  const resolved: EffectiveTarget = chosen
    ? {
        weekNumber,
        emailTarget: chosen.email_target,
        linkedinTarget: chosen.linkedin_target,
        emailDailyPace: chosen.email_daily_pace,
        linkedinDailyPace: chosen.linkedin_daily_pace,
        source: override ? 'intern_override' : 'cohort_default',
        frozen: false,
      }
    : {
        weekNumber,
        ...programDefaultTargets(weekNumber),
        source: 'program_default',
        frozen: false,
      };

  // Freeze the week once it is entirely in the past.
  const week = programWeek(cohort, weekNumber);
  if (week.range.end.getTime() <= now.getTime()) {
    await tx`
      INSERT INTO weekly_target_snapshots
        (cohort_id, user_id, week_number, email_target, linkedin_target,
         email_daily_pace, linkedin_daily_pace, source)
      VALUES (${cohort.id}, ${userId}, ${weekNumber}, ${resolved.emailTarget},
              ${resolved.linkedinTarget}, ${resolved.emailDailyPace},
              ${resolved.linkedinDailyPace}, ${resolved.source})
      ON CONFLICT (cohort_id, user_id, week_number) DO NOTHING`;
    return { ...resolved, frozen: true };
  }

  return resolved;
}

/** Every week's target for one intern, used by the weekly-trend table. */
export async function resolveAllWeeklyTargets(
  tx: Tx,
  cohort: Cohort,
  userId: string,
  now: Date,
): Promise<EffectiveTarget[]> {
  const out: EffectiveTarget[] = [];
  for (let week = 1; week <= cohort.weeksCount; week += 1) {
    out.push(await resolveWeeklyTarget(tx, cohort, userId, week, now));
  }
  return out;
}

/** Cohort defaults as configured (not per-intern), for the target editor. */
export async function cohortDefaultTargets(
  tx: Tx,
  cohortId: string,
  weeksCount: number,
): Promise<(ProgramTargets & { weekNumber: number; configured: boolean })[]> {
  const rows = await tx<
    {
      week_number: number;
      email_target: number;
      linkedin_target: number;
      email_daily_pace: number;
      linkedin_daily_pace: number;
    }[]
  >`
    SELECT week_number, email_target, linkedin_target, email_daily_pace, linkedin_daily_pace
    FROM weekly_targets WHERE cohort_id = ${cohortId} AND user_id IS NULL
    ORDER BY week_number`;
  const byWeek = new Map(rows.map((r) => [r.week_number, r]));
  return Array.from({ length: weeksCount }, (_, i) => {
    const week = i + 1;
    const row = byWeek.get(week);
    return row
      ? {
          weekNumber: week,
          emailTarget: row.email_target,
          linkedinTarget: row.linkedin_target,
          emailDailyPace: row.email_daily_pace,
          linkedinDailyPace: row.linkedin_daily_pace,
          configured: true,
        }
      : { weekNumber: week, ...programDefaultTargets(week), configured: false };
  });
}

/**
 * Seed a new cohort's defaults straight from the program guide so the target
 * editor starts populated rather than empty.
 */
export async function seedCohortDefaultTargets(
  tx: Tx,
  cohortId: string,
  weeksCount: number,
  createdBy: string,
): Promise<void> {
  for (let week = 1; week <= weeksCount; week += 1) {
    const t = programDefaultTargets(week);
    await tx`
      INSERT INTO weekly_targets
        (cohort_id, user_id, week_number, email_target, linkedin_target,
         email_daily_pace, linkedin_daily_pace, created_by)
      VALUES (${cohortId}, NULL, ${week}, ${t.emailTarget}, ${t.linkedinTarget},
              ${t.emailDailyPace}, ${t.linkedinDailyPace}, ${createdBy})
      ON CONFLICT (cohort_id, week_number) WHERE user_id IS NULL DO NOTHING`;
  }
}

export { DEFAULT_PROGRAM_WEEKS, locateWeek, programWeek };
export type { ProgramWeek };
