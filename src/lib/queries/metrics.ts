import '@/lib/server-guard';
import type { Tx } from '@/lib/db';
import type { HalfOpenRange } from '@/lib/domain/time';
import type { MetricPolicy } from '@/lib/domain/metrics';
import { computeCompensation, type CompensationSummary } from '@/lib/domain/compensation';
import { rate, type Rate } from '@/lib/domain/program';

/**
 * Authoritative metric aggregation.
 *
 * Every dashboard, intern detail page and CSV export reads from these
 * functions, so a number can never differ between two screens. The counting
 * rules mirror src/lib/domain/metrics.ts exactly; the unit tests there and the
 * integration tests here pin the two implementations together.
 *
 * Nothing below derives a count from an organization's status label. Volume
 * comes only from non-voided activity_events, and held-meeting credit only
 * from meetings an admin moved to `verified_held`.
 */

export type OutreachTotals = {
  emails: number;
  linkedinRequests: number;
  firstTouches: number;
  followUps: number;
  phoneCalls: number;
  researchNotes: number;
  uniqueOrganizations: number;
};

const EMPTY_TOTALS: OutreachTotals = {
  emails: 0,
  linkedinRequests: 0,
  firstTouches: 0,
  followUps: 0,
  phoneCalls: 0,
  researchNotes: 0,
  uniqueOrganizations: 0,
};

/**
 * Outreach volume for one actor in one half-open instant range.
 *
 * `policy` decides whether follow-up emails count toward the email target and
 * whether LinkedIn messages count toward the request target, so a historical
 * week keeps the meaning it had when it was worked.
 */
export async function outreachTotals(
  tx: Tx,
  input: { actorUserId: string; range: HalfOpenRange; policy: MetricPolicy },
): Promise<OutreachTotals> {
  const { actorUserId, range, policy } = input;
  const [row] = await tx<
    {
      emails: string;
      linkedin_requests: string;
      first_touches: string;
      follow_ups: string;
      phone_calls: string;
      research_notes: string;
      unique_organizations: string;
    }[]
  >`
    SELECT
      count(*) FILTER (
        WHERE action_type = 'email_initial'
           OR (action_type = 'email_followup' AND ${policy.emailCountsFollowups})
      ) AS emails,
      count(*) FILTER (
        WHERE action_type = 'linkedin_connection_request'
           OR (action_type IN ('linkedin_message', 'linkedin_followup')
               AND NOT ${policy.linkedinCountsFirstRequestOnly})
      ) AS linkedin_requests,
      count(*) FILTER (
        WHERE action_type IN ('email_initial', 'linkedin_connection_request')
      ) AS first_touches,
      count(*) FILTER (
        WHERE action_type IN ('email_followup', 'linkedin_message', 'linkedin_followup')
      ) AS follow_ups,
      count(*) FILTER (WHERE action_type = 'phone_call') AS phone_calls,
      count(*) FILTER (WHERE action_type = 'research_note') AS research_notes,
      count(DISTINCT organization_id) FILTER (
        WHERE action_type <> 'research_note'
      ) AS unique_organizations
    FROM activity_events
    WHERE actor_user_id = ${actorUserId}
      AND voided_at IS NULL
      AND occurred_at >= ${range.start}
      AND occurred_at <  ${range.end}`;

  if (row === undefined) return EMPTY_TOTALS;
  return {
    emails: Number(row.emails),
    linkedinRequests: Number(row.linkedin_requests),
    firstTouches: Number(row.first_touches),
    followUps: Number(row.follow_ups),
    phoneCalls: Number(row.phone_calls),
    researchNotes: Number(row.research_notes),
    uniqueOrganizations: Number(row.unique_organizations),
  };
}

/** The same aggregation for a whole set of actors at once. */
export async function outreachTotalsByActor(
  tx: Tx,
  input: { actorUserIds: readonly string[]; range: HalfOpenRange; policy: MetricPolicy },
): Promise<Map<string, OutreachTotals>> {
  if (input.actorUserIds.length === 0) return new Map();
  const rows = await tx<
    {
      actor_user_id: string;
      emails: string;
      linkedin_requests: string;
      first_touches: string;
      follow_ups: string;
      phone_calls: string;
      research_notes: string;
      unique_organizations: string;
    }[]
  >`
    SELECT actor_user_id,
      count(*) FILTER (
        WHERE action_type = 'email_initial'
           OR (action_type = 'email_followup' AND ${input.policy.emailCountsFollowups})
      ) AS emails,
      count(*) FILTER (
        WHERE action_type = 'linkedin_connection_request'
           OR (action_type IN ('linkedin_message', 'linkedin_followup')
               AND NOT ${input.policy.linkedinCountsFirstRequestOnly})
      ) AS linkedin_requests,
      count(*) FILTER (WHERE action_type IN ('email_initial', 'linkedin_connection_request')) AS first_touches,
      count(*) FILTER (WHERE action_type IN ('email_followup', 'linkedin_message', 'linkedin_followup')) AS follow_ups,
      count(*) FILTER (WHERE action_type = 'phone_call') AS phone_calls,
      count(*) FILTER (WHERE action_type = 'research_note') AS research_notes,
      count(DISTINCT organization_id) FILTER (WHERE action_type <> 'research_note') AS unique_organizations
    FROM activity_events
    WHERE actor_user_id = ANY(${input.actorUserIds as string[]}::uuid[])
      AND voided_at IS NULL
      AND occurred_at >= ${input.range.start}
      AND occurred_at <  ${input.range.end}
    GROUP BY actor_user_id`;

  const out = new Map<string, OutreachTotals>();
  for (const id of input.actorUserIds) out.set(id, EMPTY_TOTALS);
  for (const row of rows) {
    out.set(row.actor_user_id, {
      emails: Number(row.emails),
      linkedinRequests: Number(row.linkedin_requests),
      firstTouches: Number(row.first_touches),
      followUps: Number(row.follow_ups),
      phoneCalls: Number(row.phone_calls),
      researchNotes: Number(row.research_notes),
      uniqueOrganizations: Number(row.unique_organizations),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compensation
// ---------------------------------------------------------------------------

export type CompensationDetail = CompensationSummary & {
  pendingVerificationCount: number;
  paidMilestoneIndices: number[];
  unresolvedOverpaymentCents: number;
};

/**
 * Eligible verified-held meetings are those whose HELD date falls inside the
 * intern's cohort window, regardless of when an admin approved them, plus any
 * an admin explicitly marked as an approved exception.
 *
 * Compensation is cumulative across the whole cohort and is deliberately not
 * filtered by any dashboard date range.
 */
export async function compensationFor(
  tx: Tx,
  input: { userId: string; cohortId: string; cohortRange: HalfOpenRange },
): Promise<CompensationDetail> {
  const [counts] = await tx<{ verified_held: string; pending: string }[]>`
    SELECT
      count(*) FILTER (
        WHERE status = 'verified_held'
          AND (
            (held_at >= ${input.cohortRange.start} AND held_at < ${input.cohortRange.end})
            OR eligibility_override = true
          )
      ) AS verified_held,
      count(*) FILTER (WHERE status = 'pending_verification') AS pending
    FROM meetings
    WHERE credited_user_id = ${input.userId} AND cohort_id = ${input.cohortId}`;

  const payouts = await tx<{ milestone_index: number; amount_cents: number }[]>`
    SELECT milestone_index, amount_cents FROM payout_ledger
    WHERE user_id = ${input.userId} AND cohort_id = ${input.cohortId} AND voided_at IS NULL
    ORDER BY milestone_index`;

  const [adjustments] = await tx<{ total: string | null }[]>`
    SELECT coalesce(sum(amount_cents), 0)::text AS total FROM payout_adjustments
    WHERE user_id = ${input.userId} AND cohort_id = ${input.cohortId} AND resolved_at IS NULL`;

  const summary = computeCompensation({
    verifiedHeldCount: Number(counts?.verified_held ?? 0),
    paidCents: payouts.reduce((sum, p) => sum + p.amount_cents, 0),
  });

  return {
    ...summary,
    pendingVerificationCount: Number(counts?.pending ?? 0),
    paidMilestoneIndices: payouts.map((p) => p.milestone_index),
    unresolvedOverpaymentCents: Number(adjustments?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Pipeline / conversion
// ---------------------------------------------------------------------------

export type PipelineSummary = {
  assignedOrganizations: number;
  untouchedOrganizations: number;
  contactedOrganizations: number;
  repliedOrganizations: number;
  meetingsBooked: number;
  meetingsPendingVerification: number;
  meetingsVerifiedHeld: number;
  overdueFollowUps: number;
  dueTodayFollowUps: number;
  replyRate: Rate;
  meetingRate: Rate;
};

export async function pipelineFor(
  tx: Tx,
  input: { userId: string; range: HalfOpenRange; today: string },
): Promise<PipelineSummary> {
  const [assigned] = await tx<{ total: string; untouched: string }[]>`
    SELECT
      count(*)::text AS total,
      count(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM activity_events e
          WHERE e.organization_id = a.organization_id
            AND e.voided_at IS NULL
            AND e.action_type <> 'research_note'
        )
      )::text AS untouched
    FROM organization_assignments a
    WHERE a.intern_user_id = ${input.userId} AND a.unassigned_at IS NULL`;

  const [engagement] = await tx<{ contacted: string; replied: string }[]>`
    SELECT
      count(DISTINCT organization_id) FILTER (WHERE action_type <> 'research_note')::text AS contacted,
      count(DISTINCT organization_id) FILTER (
        WHERE outcome IN ('replied', 'positive_reply', 'not_interested', 'meeting_booked')
      )::text AS replied
    FROM activity_events
    WHERE actor_user_id = ${input.userId}
      AND voided_at IS NULL
      AND occurred_at >= ${input.range.start}
      AND occurred_at <  ${input.range.end}`;

  const [meetings] = await tx<{ booked: string; pending: string; verified: string }[]>`
    SELECT
      count(*) FILTER (WHERE status IN ('scheduled', 'pending_verification', 'verified_held'))::text AS booked,
      count(*) FILTER (WHERE status = 'pending_verification')::text AS pending,
      count(*) FILTER (WHERE status = 'verified_held')::text AS verified
    FROM meetings
    WHERE credited_user_id = ${input.userId}
      AND created_at >= ${input.range.start}
      AND created_at <  ${input.range.end}`;

  const [followUps] = await tx<{ overdue: string; due_today: string }[]>`
    SELECT
      count(*) FILTER (WHERE due_on < ${input.today}::date)::text AS overdue,
      count(*) FILTER (WHERE due_on = ${input.today}::date)::text AS due_today
    FROM follow_ups
    WHERE assigned_user_id = ${input.userId} AND status = 'open'`;

  const contacted = Number(engagement?.contacted ?? 0);
  const replied = Number(engagement?.replied ?? 0);
  const verified = Number(meetings?.verified ?? 0);

  return {
    assignedOrganizations: Number(assigned?.total ?? 0),
    untouchedOrganizations: Number(assigned?.untouched ?? 0),
    contactedOrganizations: contacted,
    repliedOrganizations: replied,
    meetingsBooked: Number(meetings?.booked ?? 0),
    meetingsPendingVerification: Number(meetings?.pending ?? 0),
    meetingsVerifiedHeld: verified,
    overdueFollowUps: Number(followUps?.overdue ?? 0),
    dueTodayFollowUps: Number(followUps?.due_today ?? 0),
    // Both rates carry their denominator so the UI can show an em dash rather
    // than a fabricated 0% when nobody has been contacted yet.
    replyRate: rate(replied, contacted),
    meetingRate: rate(verified, contacted),
  };
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

export type ActivityRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  contactName: string | null;
  actorUserId: string;
  actorName: string;
  channel: string;
  actionType: string;
  occurredAt: Date;
  outcome: string;
  notes: string | null;
  evidenceUrl: string | null;
  followUpOn: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  correctedFromId: string | null;
};

export async function recentActivity(
  tx: Tx,
  input: { actorUserId?: string; organizationId?: string; limit?: number },
): Promise<ActivityRow[]> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 25));
  const rows = await tx<
    {
      id: string;
      organization_id: string;
      organization_name: string;
      contact_name: string | null;
      actor_user_id: string;
      actor_name: string;
      channel: string;
      action_type: string;
      occurred_at: Date;
      outcome: string;
      notes: string | null;
      evidence_url: string | null;
      follow_up_on: string | null;
      voided_at: Date | null;
      void_reason: string | null;
      corrected_from_id: string | null;
    }[]
  >`
    SELECT e.id, e.organization_id, o.name AS organization_name,
           c.full_name AS contact_name,
           e.actor_user_id,
           -- LEFT JOIN, not JOIN: row level security hides other interns'
           -- profile rows, and an inner join would silently drop their
           -- contributions from a club's timeline. The actor stays attributed;
           -- only the display name falls back.
           coalesce(u.preferred_name, u.full_name, u.email::text, 'Another team member')
             AS actor_name,
           e.channel::text, e.action_type::text, e.occurred_at, e.outcome::text,
           e.notes, e.evidence_url, e.follow_up_on::text AS follow_up_on,
           e.voided_at, e.void_reason, e.corrected_from_id
    FROM activity_events e
    JOIN organizations o ON o.id = e.organization_id
    LEFT JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE (${input.actorUserId ?? null}::uuid IS NULL OR e.actor_user_id = ${input.actorUserId ?? null})
      AND (${input.organizationId ?? null}::uuid IS NULL OR e.organization_id = ${input.organizationId ?? null})
    ORDER BY e.occurred_at DESC, e.created_at DESC
    LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    contactName: r.contact_name,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    channel: r.channel,
    actionType: r.action_type,
    occurredAt: r.occurred_at,
    outcome: r.outcome,
    notes: r.notes,
    evidenceUrl: r.evidence_url,
    followUpOn: r.follow_up_on,
    voidedAt: r.voided_at,
    voidReason: r.void_reason,
    correctedFromId: r.corrected_from_id,
  }));
}
