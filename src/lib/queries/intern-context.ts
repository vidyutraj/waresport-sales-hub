import '@/lib/server-guard';
import { asUser, type Tx } from '@/lib/db';
import {
  cohortRange,
  locateWeek,
  suggestedRemainingPace,
  SUGGESTED_WORKING_DAYS_PER_WEEK,
  type Cohort,
  type ProgramWeek,
  type WeekLocation,
} from '@/lib/domain/program';
import { zonedDateString, type HalfOpenRange } from '@/lib/domain/time';
import { DEFAULT_METRIC_POLICY, type MetricPolicy } from '@/lib/domain/metrics';
import {
  getActiveMembership,
  metricPolicyAt,
  resolveWeeklyTarget,
  type EffectiveTarget,
  type Membership,
} from './program';
import {
  compensationFor,
  outreachTotals,
  pipelineFor,
  type CompensationDetail,
  type OutreachTotals,
  type PipelineSummary,
} from './metrics';

/**
 * Everything an intern screen needs about "where am I in the program".
 *
 * Resolved once per request and reused, so the weekly numbers on the overview,
 * the follow-up queue and any export are computed from one set of boundaries.
 */

export type InternContext = {
  userId: string;
  membership: Membership | null;
  cohort: Cohort | null;
  location: WeekLocation | null;
  week: ProgramWeek | null;
  cohortRange: HalfOpenRange | null;
  /** Today's date in the cohort's reporting timezone. */
  todayReporting: string;
  policy: MetricPolicy;
  target: EffectiveTarget | null;
};

export async function loadInternContext(
  tx: Tx,
  userId: string,
  now = new Date(),
): Promise<InternContext> {
  const membership = await getActiveMembership(tx, userId);
  if (membership === null) {
    return {
      userId,
      membership: null,
      cohort: null,
      location: null,
      week: null,
      cohortRange: null,
      todayReporting: zonedDateString(now, 'UTC'),
      policy: DEFAULT_METRIC_POLICY,
      target: null,
    };
  }

  const cohort = membership.cohort;
  const location = locateWeek(cohort, now);
  const week = location.kind === 'in' ? location.week : null;
  const policy = await metricPolicyAt(tx, cohort.id, now);
  // Outside the 12 weeks there is no current week, and therefore no target —
  // the app never silently generates one.
  const target = week ? await resolveWeeklyTarget(tx, cohort, userId, week.weekNumber, now) : null;

  return {
    userId,
    membership,
    cohort,
    location,
    week,
    cohortRange: cohortRange(cohort),
    todayReporting: zonedDateString(now, cohort.reportingTimezone),
    policy,
    target,
  };
}

export type InternDashboard = {
  context: InternContext;
  weekTotals: OutreachTotals;
  pipeline: PipelineSummary;
  compensation: CompensationDetail | null;
  emailPace: number | null;
  workingDaysRemaining: number;
};

export async function loadInternDashboard(
  userId: string,
  now = new Date(),
): Promise<InternDashboard> {
  return asUser(userId, async (tx) => {
    const context = await loadInternContext(tx, userId, now);

    const range: HalfOpenRange = context.week?.range ?? {
      // With no cohort there is nothing to measure; an empty range keeps every
      // downstream count at zero rather than inventing a window.
      start: new Date(0),
      end: new Date(0),
    };

    const [weekTotals, pipeline] = await Promise.all([
      outreachTotals(tx, { actorUserId: userId, range, policy: context.policy }),
      pipelineFor(tx, { userId, range, today: context.todayReporting }),
    ]);

    const compensation =
      context.cohort && context.cohortRange
        ? await compensationFor(tx, {
            userId,
            cohortId: context.cohort.id,
            cohortRange: context.cohortRange,
          })
        : null;

    const workingDaysRemaining = context.week
      ? remainingWorkingDays(context.week, context.todayReporting)
      : 0;

    return {
      context,
      weekTotals,
      pipeline,
      compensation,
      emailPace: context.target
        ? suggestedRemainingPace(
            context.target.emailTarget,
            weekTotals.emails,
            workingDaysRemaining,
          )
        : null,
      workingDaysRemaining,
    };
  });
}

/**
 * Days left in the week for the informational pace hint.
 *
 * The guide's daily figures spread the weekly goal over five working days.
 * This is advisory only — it never creates an attendance requirement.
 */
export function remainingWorkingDays(week: ProgramWeek, todayReporting: string): number {
  const startMs = Date.UTC(week.startDate.year, week.startDate.month - 1, week.startDate.day);
  const [y, m, d] = todayReporting.split('-').map(Number);
  const todayMs = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const dayIndex = Math.round((todayMs - startMs) / 86_400_000);
  if (dayIndex < 0) return SUGGESTED_WORKING_DAYS_PER_WEEK;
  return Math.max(0, SUGGESTED_WORKING_DAYS_PER_WEEK - dayIndex);
}
