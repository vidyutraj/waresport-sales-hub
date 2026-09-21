import '@/lib/server-guard';
import { asUser, type Tx } from '@/lib/db';
import {
  cohortRange,
  currentProgramWeek,
  rate,
  type Cohort,
  type ProgramWeek,
  type Rate,
} from '@/lib/domain/program';
import type { HalfOpenRange } from '@/lib/domain/time';
import { zonedDateString } from '@/lib/domain/time';
import type { MetricPolicy } from '@/lib/domain/metrics';
import { computeCompensation, type CompensationSummary } from '@/lib/domain/compensation';
import {
  listCohorts,
  metricPolicyAt,
  resolveWeeklyTarget,
  type CohortRow,
  type EffectiveTarget,
} from './program';
import { outreachTotalsByActor, type OutreachTotals } from './metrics';

/**
 * Admin dashboard aggregation.
 *
 * Deliberately one query set for the whole cohort rather than N per intern, so
 * the roster, the charts and the CSV export all read the same numbers from the
 * same definitions.
 */

export type InternSummary = {
  userId: string;
  name: string;
  email: string;
  status: 'invited' | 'active' | 'deactivated';
  territoryCode: string | null;
  joinedOn: string | null;
  totals: OutreachTotals;
  target: EffectiveTarget | null;
  assignedOrganizations: number;
  untouchedOrganizations: number;
  openFollowUps: number;
  overdueFollowUps: number;
  meetingsBooked: number;
  meetingsPending: number;
  verifiedHeld: number;
  compensation: CompensationSummary;
  paidMilestoneIndices: number[];
  lastActivityAt: Date | null;
  trainingCompleted: number;
  trainingTotal: number;
  replyRate: Rate;
};

export type AdminDashboard = {
  cohorts: CohortRow[];
  cohort: CohortRow | null;
  week: ProgramWeek | null;
  policy: MetricPolicy;
  range: HalfOpenRange;
  rangeLabel: string;
  todayReporting: string;
  interns: InternSummary[];
  totals: {
    emails: number;
    linkedinConnections: number;
    verifiedHeld: number;
    pendingVerification: number;
    earnedCents: number;
    paidCents: number;
    assignedOrganizations: number;
    unassignedOrganizations: number;
    totalOrganizations: number;
  };
};

export type DashboardFilters = {
  cohortId?: string | null;
  from?: string | null;
  to?: string | null;
  territoryId?: string | null;
};

export async function loadAdminDashboard(
  actorUserId: string,
  filters: DashboardFilters = {},
  now = new Date(),
): Promise<AdminDashboard> {
  return asUser(actorUserId, async (tx) => {
    const cohorts = await listCohorts(tx);
    const cohort =
      (filters.cohortId ? cohorts.find((c) => c.id === filters.cohortId) : undefined) ??
      cohorts.find((c) => c.isActive) ??
      cohorts[0] ??
      null;

    const week = cohort ? currentProgramWeek(cohort, now) : null;
    const policy = cohort
      ? await metricPolicyAt(tx, cohort.id, now)
      : { version: 1, emailCountsFollowups: true, linkedinCountsFirstRequestOnly: true };

    // The period-specific window: an explicit date filter, else the current
    // program week, else the whole cohort. Compensation deliberately ignores
    // this and always spans the cohort.
    const { range, rangeLabel } = resolveRange(cohort, week, filters);

    const interns = cohort ? await loadInterns(tx, cohort, range, policy, now) : [];

    const [orgCounts] = await tx<{ total: string; assigned: string }[]>`
      SELECT count(*)::text AS total,
             count(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM organization_assignments a
                             WHERE a.organization_id = o.id AND a.unassigned_at IS NULL)
             )::text AS assigned
      FROM organizations o WHERE o.is_archived = false`;

    const totalOrganizations = Number(orgCounts?.total ?? 0);
    const assignedOrganizations = Number(orgCounts?.assigned ?? 0);

    return {
      cohorts,
      cohort,
      week,
      policy,
      range,
      rangeLabel,
      todayReporting: zonedDateString(now, cohort?.reportingTimezone ?? 'UTC'),
      interns,
      totals: {
        emails: interns.reduce((s, i) => s + i.totals.emails, 0),
        linkedinConnections: interns.reduce((s, i) => s + i.totals.linkedinConnections, 0),
        verifiedHeld: interns.reduce((s, i) => s + i.verifiedHeld, 0),
        pendingVerification: interns.reduce((s, i) => s + i.meetingsPending, 0),
        earnedCents: interns.reduce((s, i) => s + i.compensation.earnedCents, 0),
        paidCents: interns.reduce((s, i) => s + i.compensation.paidCents, 0),
        assignedOrganizations,
        unassignedOrganizations: totalOrganizations - assignedOrganizations,
        totalOrganizations,
      },
    };
  });
}

function resolveRange(
  cohort: Cohort | null,
  week: ProgramWeek | null,
  filters: DashboardFilters,
): { range: HalfOpenRange; rangeLabel: string } {
  if (filters.from && filters.to) {
    // Half-open: `to` is inclusive for the user, exclusive in the query.
    const start = new Date(`${filters.from}T00:00:00Z`);
    const end = new Date(new Date(`${filters.to}T00:00:00Z`).getTime() + 86_400_000);
    return { range: { start, end }, rangeLabel: `${filters.from} to ${filters.to} (UTC days)` };
  }
  if (week) return { range: week.range, rangeLabel: week.label };
  if (cohort) return { range: cohortRange(cohort), rangeLabel: `${cohort.name} (whole cohort)` };
  return {
    range: { start: new Date(0), end: new Date(0) },
    rangeLabel: 'No cohort configured',
  };
}

async function loadInterns(
  tx: Tx,
  cohort: CohortRow,
  range: HalfOpenRange,
  policy: MetricPolicy,
  now: Date,
): Promise<InternSummary[]> {
  const people = await tx<
    {
      id: string;
      name: string;
      email: string;
      status: 'invited' | 'active' | 'deactivated';
      territory_code: string | null;
      joined_on: string | null;
      assigned_organizations: string;
      untouched_organizations: string;
      open_follow_ups: string;
      overdue_follow_ups: string;
      meetings_booked: string;
      meetings_pending: string;
      verified_held: string;
      paid_cents: string;
      paid_milestones: number[];
      last_activity_at: Date | null;
      training_completed: string;
      training_total: string;
      contacted_organizations: string;
      replied_organizations: string;
    }[]
  >`
    SELECT u.id,
           coalesce(u.preferred_name, u.full_name, u.email::text) AS name,
           u.email::text AS email, u.status,
           t.code AS territory_code, m.joined_on::text AS joined_on,

           (SELECT count(*) FROM organization_assignments a
             WHERE a.intern_user_id = u.id AND a.unassigned_at IS NULL)::text
             AS assigned_organizations,

           (SELECT count(*) FROM organization_assignments a
             WHERE a.intern_user_id = u.id AND a.unassigned_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM activity_events e
                               WHERE e.organization_id = a.organization_id
                                 AND e.voided_at IS NULL AND e.action_type <> 'research_note'))::text
             AS untouched_organizations,

           (SELECT count(*) FROM follow_ups f
             WHERE f.assigned_user_id = u.id AND f.status = 'open')::text AS open_follow_ups,
           (SELECT count(*) FROM follow_ups f
             WHERE f.assigned_user_id = u.id AND f.status = 'open'
               AND f.due_on < (now() AT TIME ZONE ${cohort.reportingTimezone})::date)::text
             AS overdue_follow_ups,

           (SELECT count(*) FROM meetings mt
             WHERE mt.credited_user_id = u.id AND mt.cohort_id = ${cohort.id}
               AND mt.status IN ('scheduled', 'pending_verification', 'verified_held'))::text
             AS meetings_booked,
           (SELECT count(*) FROM meetings mt
             WHERE mt.credited_user_id = u.id AND mt.cohort_id = ${cohort.id}
               AND mt.status = 'pending_verification')::text AS meetings_pending,

           -- Eligible verified-held meetings: held date inside the cohort
           -- window, or an explicitly approved exception.
           (SELECT count(*) FROM meetings mt
             WHERE mt.credited_user_id = u.id AND mt.cohort_id = ${cohort.id}
               AND mt.status = 'verified_held'
               AND ((mt.held_at >= ${cohortRange(cohort).start} AND mt.held_at < ${cohortRange(cohort).end})
                    OR mt.eligibility_override = true))::text AS verified_held,

           (SELECT coalesce(sum(p.amount_cents), 0) FROM payout_ledger p
             WHERE p.user_id = u.id AND p.cohort_id = ${cohort.id} AND p.voided_at IS NULL)::text
             AS paid_cents,
           coalesce((SELECT array_agg(p.milestone_index ORDER BY p.milestone_index)
                     FROM payout_ledger p
                     WHERE p.user_id = u.id AND p.cohort_id = ${cohort.id} AND p.voided_at IS NULL),
                    '{}') AS paid_milestones,

           (SELECT max(e.occurred_at) FROM activity_events e
             WHERE e.actor_user_id = u.id AND e.voided_at IS NULL) AS last_activity_at,

           (SELECT count(*) FROM training_completions tc WHERE tc.user_id = u.id)::text
             AS training_completed,
           (SELECT count(*) FROM training_topics tt WHERE tt.is_active)::text AS training_total,

           (SELECT count(DISTINCT e.organization_id) FROM activity_events e
             WHERE e.actor_user_id = u.id AND e.voided_at IS NULL
               AND e.action_type <> 'research_note'
               AND e.occurred_at >= ${range.start} AND e.occurred_at < ${range.end})::text
             AS contacted_organizations,
           (SELECT count(DISTINCT e.organization_id) FROM activity_events e
             WHERE e.actor_user_id = u.id AND e.voided_at IS NULL
               AND e.outcome IN ('replied', 'positive_reply', 'not_interested', 'meeting_booked')
               AND e.occurred_at >= ${range.start} AND e.occurred_at < ${range.end})::text
             AS replied_organizations

    FROM users u
    JOIN cohort_memberships m ON m.user_id = u.id AND m.cohort_id = ${cohort.id} AND m.left_on IS NULL
    LEFT JOIN territories t ON t.id = m.territory_id
    WHERE u.role = 'intern'
    ORDER BY t.code NULLS LAST, name`;

  const totalsByActor = await outreachTotalsByActor(tx, {
    actorUserIds: people.map((p) => p.id),
    range,
    policy,
  });

  const week = currentProgramWeek(cohort, now);

  const out: InternSummary[] = [];
  for (const p of people) {
    const totals = totalsByActor.get(p.id) ?? {
      emails: 0,
      linkedinConnections: 0,
      firstTouches: 0,
      followUps: 0,
      phoneCalls: 0,
      researchNotes: 0,
      uniqueOrganizations: 0,
    };
    const verifiedHeld = Number(p.verified_held);
    out.push({
      userId: p.id,
      name: p.name,
      email: p.email,
      status: p.status,
      territoryCode: p.territory_code,
      joinedOn: p.joined_on,
      totals,
      target: week ? await resolveWeeklyTarget(tx, cohort, p.id, week.weekNumber, now) : null,
      assignedOrganizations: Number(p.assigned_organizations),
      untouchedOrganizations: Number(p.untouched_organizations),
      openFollowUps: Number(p.open_follow_ups),
      overdueFollowUps: Number(p.overdue_follow_ups),
      meetingsBooked: Number(p.meetings_booked),
      meetingsPending: Number(p.meetings_pending),
      verifiedHeld,
      compensation: computeCompensation({
        verifiedHeldCount: verifiedHeld,
        paidCents: Number(p.paid_cents),
      }),
      paidMilestoneIndices: p.paid_milestones ?? [],
      lastActivityAt: p.last_activity_at,
      trainingCompleted: Number(p.training_completed),
      trainingTotal: Number(p.training_total),
      replyRate: rate(Number(p.replied_organizations), Number(p.contacted_organizations)),
    });
  }
  return out;
}
