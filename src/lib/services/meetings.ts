import '@/lib/server-guard';
import { attempt, isUniqueViolation, type Tx } from '@/lib/db';
import { canRecordPayout, MILESTONE_AMOUNT_CENTS } from '@/lib/domain/compensation';
import { compensationFor } from '@/lib/queries/metrics';
import type { HalfOpenRange } from '@/lib/domain/time';
import { recordAudit } from './audit';

/**
 * Meetings, verification and the payout ledger.
 *
 * Correctness rules enforced here and in the database:
 *  - Only an admin or owner can move a meeting to `verified_held` (database
 *    trigger `meetings_guard_update`).
 *  - A held date can never be in the future.
 *  - Rescheduling updates the same meeting; it never creates a second payable
 *    event.
 *  - A meeting counts once, for exactly one credited intern. Reassigning the
 *    club does not move the credit.
 *  - A payout is a record of a manual payment. Nothing here transfers money.
 *  - A milestone can be paid at most once, guaranteed by a partial unique
 *    index, so two concurrent "mark paid" requests cannot both succeed.
 *  - Reversing a verification recalculates earnings but never deletes a payout.
 */

export class MeetingError extends Error {
  constructor(
    message: string,
    readonly code:
      'not_found' | 'future_held' | 'invalid_transition' | 'not_permitted' | 'conflict',
  ) {
    super(message);
    this.name = 'MeetingError';
  }
}

export class PayoutError extends Error {
  constructor(
    message: string,
    readonly code: 'not_earned' | 'already_paid' | 'not_found' | 'invalid',
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

export type MeetingStatus =
  'scheduled' | 'pending_verification' | 'verified_held' | 'cancelled' | 'no_show';

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  scheduled: 'Scheduled',
  pending_verification: 'Pending verification',
  verified_held: 'Verified held',
  cancelled: 'Cancelled',
  no_show: 'No show',
};

/** Only `verified_held` is worth anything. */
export function isPayable(status: MeetingStatus): boolean {
  return status === 'verified_held';
}

export async function bookMeeting(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'intern';
    organizationId: string;
    contactId?: string | null;
    prospectId?: string | null;
    creditedUserId: string;
    cohortId: string | null;
    scheduledStartAt: Date;
    scheduledTimezone: string;
    notes?: string | null;
    referenceUrl?: string | null;
  },
): Promise<{ meetingId: string }> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO meetings (
      organization_id, contact_id, prospect_id, credited_user_id, booked_by_user_id,
      cohort_id, scheduled_start_at, scheduled_timezone, status, notes, reference_url
    ) VALUES (
      ${input.organizationId}, ${input.contactId ?? null}, ${input.prospectId ?? null},
      ${input.creditedUserId}, ${input.actorUserId}, ${input.cohortId},
      ${input.scheduledStartAt}, ${input.scheduledTimezone}, 'scheduled',
      ${input.notes ?? null}, ${input.referenceUrl ?? null}
    )
    RETURNING id`;
  if (row === undefined) throw new MeetingError('Could not book that meeting.', 'not_found');

  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, to_status)
    VALUES (${row.id}, ${input.actorUserId}, 'booked', 'scheduled')`;

  return { meetingId: row.id };
}

/** Rescheduling mutates the existing meeting — never a second payable event. */
export async function rescheduleMeeting(
  tx: Tx,
  input: {
    actorUserId: string;
    meetingId: string;
    scheduledStartAt: Date;
    scheduledTimezone?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const [existing] = await tx<{ id: string; status: MeetingStatus; scheduled_start_at: Date }[]>`
    SELECT id, status, scheduled_start_at FROM meetings WHERE id = ${input.meetingId} FOR UPDATE`;
  if (existing === undefined) throw new MeetingError('That meeting no longer exists.', 'not_found');
  if (existing.status === 'verified_held') {
    throw new MeetingError('A verified meeting cannot be rescheduled.', 'invalid_transition');
  }

  await tx`
    UPDATE meetings
    SET scheduled_start_at = ${input.scheduledStartAt},
        scheduled_timezone = coalesce(${input.scheduledTimezone ?? null}, scheduled_timezone),
        status = CASE WHEN status IN ('cancelled', 'no_show') THEN 'scheduled'::meeting_status ELSE status END
    WHERE id = ${input.meetingId}`;

  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, from_status, to_status, reason, detail)
    VALUES (${input.meetingId}, ${input.actorUserId}, 'rescheduled', ${existing.status}::meeting_status,
            'scheduled', ${input.reason ?? null},
            jsonb_build_object('from', ${existing.scheduled_start_at.toISOString()}::text,
                               'to', ${input.scheduledStartAt.toISOString()}::text))`;
}

/** An intern submits a meeting as held; an admin still has to confirm it. */
export async function submitHeld(
  tx: Tx,
  input: {
    actorUserId: string;
    meetingId: string;
    heldAt: Date;
    notes?: string | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  if (input.heldAt.getTime() > now.getTime() + 60_000) {
    throw new MeetingError('A meeting cannot be recorded as held in the future.', 'future_held');
  }

  const [existing] = await tx<{ status: MeetingStatus }[]>`
    SELECT status FROM meetings WHERE id = ${input.meetingId} FOR UPDATE`;
  if (existing === undefined) throw new MeetingError('That meeting no longer exists.', 'not_found');
  if (existing.status === 'verified_held') {
    throw new MeetingError('That meeting is already verified.', 'invalid_transition');
  }

  await tx`
    UPDATE meetings
    SET status = 'pending_verification', held_at = ${input.heldAt},
        notes = coalesce(${input.notes ?? null}, notes)
    WHERE id = ${input.meetingId}`;

  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, from_status, to_status)
    VALUES (${input.meetingId}, ${input.actorUserId}, 'submitted_for_verification',
            ${existing.status}::meeting_status, 'pending_verification')`;
}

/**
 * Admin verification. Eligibility is by held date inside the credited intern's
 * cohort window; when an admin approves an out-of-window meeting they must
 * supply a reason, which is stored as an explicit exception.
 */
export async function verifyHeld(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    meetingId: string;
    eligibilityOverrideReason?: string | null;
    now?: Date;
  },
): Promise<{ verified: true }> {
  const [existing] = await tx<
    { id: string; status: MeetingStatus; held_at: Date | null; credited_user_id: string }[]
  >`
    SELECT id, status, held_at, credited_user_id FROM meetings
    WHERE id = ${input.meetingId} FOR UPDATE`;
  if (existing === undefined) throw new MeetingError('That meeting no longer exists.', 'not_found');
  // Re-verifying is a no-op *unless* the admin is adding or clearing an
  // eligibility exception, which must still be applicable after the fact.
  if (existing.status === 'verified_held' && !input.eligibilityOverrideReason) {
    return { verified: true };
  }
  if (existing.held_at === null) {
    throw new MeetingError(
      'Record when the meeting actually took place before verifying it.',
      'invalid_transition',
    );
  }

  await tx`
    UPDATE meetings
    SET status = 'verified_held',
        verified_at = now(),
        verified_by = ${input.actorUserId},
        rejection_reason = NULL,
        eligibility_override = ${input.eligibilityOverrideReason ? true : false},
        eligibility_override_reason = ${input.eligibilityOverrideReason ?? null}
    WHERE id = ${input.meetingId}`;

  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, from_status, to_status, reason)
    VALUES (${input.meetingId}, ${input.actorUserId}, 'verified', ${existing.status}::meeting_status,
            'verified_held', ${input.eligibilityOverrideReason ?? null})`;

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'meeting.verified',
    entityType: 'meeting',
    entityId: input.meetingId,
    before: { status: existing.status },
    after: { status: 'verified_held', creditedUserId: existing.credited_user_id },
    reason: input.eligibilityOverrideReason ?? null,
  });

  return { verified: true };
}

export async function rejectHeld(
  tx: Tx,
  input: { actorUserId: string; actorRole: 'owner' | 'admin'; meetingId: string; reason: string },
): Promise<void> {
  const [existing] = await tx<{ status: MeetingStatus }[]>`
    SELECT status FROM meetings WHERE id = ${input.meetingId} FOR UPDATE`;
  if (existing === undefined) throw new MeetingError('That meeting no longer exists.', 'not_found');

  await tx`
    UPDATE meetings
    SET status = 'scheduled', held_at = NULL, rejection_reason = ${input.reason}
    WHERE id = ${input.meetingId}`;
  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, from_status, to_status, reason)
    VALUES (${input.meetingId}, ${input.actorUserId}, 'rejected', ${existing.status}::meeting_status,
            'scheduled', ${input.reason})`;
  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'meeting.rejected',
    entityType: 'meeting',
    entityId: input.meetingId,
    before: { status: existing.status },
    after: { status: 'scheduled' },
    reason: input.reason,
  });
}

/**
 * Reverse a verification.
 *
 * Earnings recalculate immediately, but any payout already recorded stays in
 * the ledger. If that leaves the intern overpaid, a reconciliation row is
 * written so the shortfall is visible rather than hidden behind a negative
 * balance.
 */
export async function revertVerification(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    meetingId: string;
    reason: string;
    cohortRange: HalfOpenRange;
  },
): Promise<{ overpaymentCents: number }> {
  const [existing] = await tx<
    { status: MeetingStatus; credited_user_id: string; cohort_id: string | null }[]
  >`
    SELECT status, credited_user_id, cohort_id FROM meetings
    WHERE id = ${input.meetingId} FOR UPDATE`;
  if (existing === undefined) throw new MeetingError('That meeting no longer exists.', 'not_found');
  if (existing.status !== 'verified_held') {
    throw new MeetingError('That meeting is not currently verified.', 'invalid_transition');
  }

  await tx`
    UPDATE meetings
    SET status = 'pending_verification', verified_at = NULL, verified_by = NULL,
        eligibility_override = false, eligibility_override_reason = NULL
    WHERE id = ${input.meetingId}`;
  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, from_status, to_status, reason)
    VALUES (${input.meetingId}, ${input.actorUserId}, 'reverted', 'verified_held',
            'pending_verification', ${input.reason})`;

  let overpaymentCents = 0;
  if (existing.cohort_id !== null) {
    const comp = await compensationFor(tx, {
      userId: existing.credited_user_id,
      cohortId: existing.cohort_id,
      cohortRange: input.cohortRange,
    });
    if (comp.overpaidCents > 0) {
      overpaymentCents = comp.overpaidCents;
      await tx`
        INSERT INTO payout_adjustments (user_id, cohort_id, amount_cents, reason, recorded_by)
        VALUES (${existing.credited_user_id}, ${existing.cohort_id}, ${-comp.overpaidCents},
                ${`Verification reversed: ${input.reason}`}, ${input.actorUserId})`;
    }
  }

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'meeting.verification_reverted',
    entityType: 'meeting',
    entityId: input.meetingId,
    before: { status: 'verified_held' },
    after: { status: 'pending_verification', overpaymentCents },
    reason: input.reason,
  });

  return { overpaymentCents };
}

/** Administrative attribution change. Requires a reason; history is kept. */
export async function changeAttribution(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    meetingId: string;
    newCreditedUserId: string;
    reason: string;
  },
): Promise<void> {
  const [existing] = await tx<{ credited_user_id: string }[]>`
    SELECT credited_user_id FROM meetings WHERE id = ${input.meetingId} FOR UPDATE`;
  if (existing === undefined) throw new MeetingError('That meeting no longer exists.', 'not_found');
  if (existing.credited_user_id === input.newCreditedUserId) return;

  await tx`
    UPDATE meetings SET credited_user_id = ${input.newCreditedUserId} WHERE id = ${input.meetingId}`;
  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, reason, detail)
    VALUES (${input.meetingId}, ${input.actorUserId}, 'attribution_changed', ${input.reason},
            jsonb_build_object('from', ${existing.credited_user_id}::text,
                               'to', ${input.newCreditedUserId}::text))`;
  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'meeting.attribution_changed',
    entityType: 'meeting',
    entityId: input.meetingId,
    before: { creditedUserId: existing.credited_user_id },
    after: { creditedUserId: input.newCreditedUserId },
    reason: input.reason,
  });
}

export async function setMeetingOutcome(
  tx: Tx,
  input: {
    actorUserId: string;
    meetingId: string;
    status: 'cancelled' | 'no_show';
    reason?: string | null;
  },
): Promise<void> {
  const [existing] = await tx<{ status: MeetingStatus }[]>`
    SELECT status FROM meetings WHERE id = ${input.meetingId} FOR UPDATE`;
  if (existing === undefined) throw new MeetingError('That meeting no longer exists.', 'not_found');
  if (existing.status === 'verified_held') {
    throw new MeetingError(
      'Revert the verification before cancelling a verified meeting.',
      'invalid_transition',
    );
  }
  await tx`
    UPDATE meetings SET status = ${input.status}::meeting_status, held_at = NULL
    WHERE id = ${input.meetingId}`;
  await tx`
    INSERT INTO meeting_events (meeting_id, actor_user_id, event_type, from_status, to_status, reason)
    VALUES (${input.meetingId}, ${input.actorUserId},
            ${input.status === 'cancelled' ? 'cancelled' : 'no_show'}::meeting_event_type,
            ${existing.status}::meeting_status, ${input.status}::meeting_status, ${input.reason ?? null})`;
}

// ---------------------------------------------------------------------------
// Payout ledger
// ---------------------------------------------------------------------------

/**
 * Record that a $100 milestone was paid outside this system.
 *
 * Two guards, belt and braces: the domain check refuses an unearned or
 * already-paid milestone, and the partial unique index makes a concurrent
 * duplicate impossible even if two requests pass the check simultaneously.
 */
export async function recordPayout(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    userId: string;
    cohortId: string;
    cohortRange: HalfOpenRange;
    milestoneIndex: number;
    paidOn: string;
    reference?: string | null;
    notes?: string | null;
  },
): Promise<{ payoutId: string; amountCents: number }> {
  const comp = await compensationFor(tx, {
    userId: input.userId,
    cohortId: input.cohortId,
    cohortRange: input.cohortRange,
  });

  const check = canRecordPayout(
    comp.earnedMilestones,
    input.milestoneIndex,
    comp.paidMilestoneIndices,
  );
  if (!check.ok) {
    throw new PayoutError(
      check.reason,
      check.reason.includes('already') ? 'already_paid' : 'not_earned',
    );
  }

  // The domain check above and the partial unique index below are independent
  // guards. Two concurrent requests can both pass the check; only one can win
  // the index, and the loser rolls back to this savepoint rather than aborting
  // the transaction.
  const inserted = await attempt(tx, async (sp) => {
    const [row] = await sp<{ id: string }[]>`
      INSERT INTO payout_ledger
        (user_id, cohort_id, milestone_index, amount_cents, currency, paid_on, reference, notes, recorded_by)
      VALUES (${input.userId}, ${input.cohortId}, ${input.milestoneIndex},
              ${MILESTONE_AMOUNT_CENTS}, 'USD', ${input.paidOn}::date,
              ${input.reference ?? null}, ${input.notes ?? null}, ${input.actorUserId})
      RETURNING id`;
    return row;
  });

  if (!inserted.ok) {
    if (isUniqueViolation(inserted.error)) {
      throw new PayoutError(
        `Milestone ${input.milestoneIndex} is already recorded as paid.`,
        'already_paid',
      );
    }
    throw inserted.error;
  }

  const row = inserted.value;
  if (row === undefined) throw new PayoutError('Could not record that payout.', 'invalid');

  {
    await recordAudit(tx, {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: 'payout.recorded',
      entityType: 'payout',
      entityId: row.id,
      after: {
        userId: input.userId,
        milestoneIndex: input.milestoneIndex,
        amountCents: MILESTONE_AMOUNT_CENTS,
        paidOn: input.paidOn,
      },
      reason: input.notes ?? null,
    });
  }

  return { payoutId: row.id, amountCents: MILESTONE_AMOUNT_CENTS };
}

export async function voidPayout(
  tx: Tx,
  input: { actorUserId: string; actorRole: 'owner' | 'admin'; payoutId: string; reason: string },
): Promise<void> {
  const [row] = await tx<{ id: string; user_id: string; milestone_index: number }[]>`
    UPDATE payout_ledger
    SET voided_at = now(), voided_by = ${input.actorUserId}, void_reason = ${input.reason}
    WHERE id = ${input.payoutId} AND voided_at IS NULL
    RETURNING id, user_id, milestone_index`;
  if (row === undefined)
    throw new PayoutError('That payout was not found or is already void.', 'not_found');

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'payout.voided',
    entityType: 'payout',
    entityId: input.payoutId,
    before: { userId: row.user_id, milestoneIndex: row.milestone_index, voided: false },
    after: { voided: true },
    reason: input.reason,
  });
}

export async function resolveAdjustment(
  tx: Tx,
  input: { actorUserId: string; adjustmentId: string; note: string },
): Promise<void> {
  await tx`
    UPDATE payout_adjustments
    SET resolved_at = now(), resolved_by = ${input.actorUserId}, resolution_note = ${input.note}
    WHERE id = ${input.adjustmentId} AND resolved_at IS NULL`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type MeetingRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  contactName: string | null;
  creditedUserId: string;
  creditedUserName: string;
  bookedByName: string;
  scheduledStartAt: Date;
  scheduledTimezone: string;
  status: MeetingStatus;
  heldAt: Date | null;
  verifiedAt: Date | null;
  verifiedByName: string | null;
  rejectionReason: string | null;
  eligibilityOverride: boolean;
  notes: string | null;
  referenceUrl: string | null;
  /** Flagged for review when the same club already has a verified meeting. */
  duplicateClubFlag: boolean;
};

export async function listMeetings(
  tx: Tx,
  input: {
    creditedUserId?: string | null;
    status?: MeetingStatus | null;
    cohortId?: string | null;
    limit?: number;
  },
): Promise<MeetingRow[]> {
  const limit = Math.min(500, Math.max(1, input.limit ?? 100));
  const rows = await tx<
    {
      id: string;
      organization_id: string;
      organization_name: string;
      contact_name: string | null;
      credited_user_id: string;
      credited_user_name: string;
      booked_by_name: string;
      scheduled_start_at: Date;
      scheduled_timezone: string;
      status: MeetingStatus;
      held_at: Date | null;
      verified_at: Date | null;
      verified_by_name: string | null;
      rejection_reason: string | null;
      eligibility_override: boolean;
      notes: string | null;
      reference_url: string | null;
      duplicate_club_flag: boolean;
    }[]
  >`
    SELECT m.id, m.organization_id, o.name AS organization_name, c.full_name AS contact_name,
           m.credited_user_id,
           coalesce(cu.preferred_name, cu.full_name, cu.email::text, 'Another team member')
             AS credited_user_name,
           coalesce(bu.preferred_name, bu.full_name, bu.email::text, 'Another team member')
             AS booked_by_name,
           m.scheduled_start_at, m.scheduled_timezone, m.status, m.held_at,
           m.verified_at,
           coalesce(vu.preferred_name, vu.full_name, vu.email::text) AS verified_by_name,
           m.rejection_reason, m.eligibility_override, m.notes, m.reference_url,
           (SELECT count(*) FROM meetings m2
             WHERE m2.organization_id = m.organization_id
               AND m2.status = 'verified_held' AND m2.id <> m.id) > 0 AS duplicate_club_flag
    FROM meetings m
    JOIN organizations o ON o.id = m.organization_id
    -- LEFT JOIN so a meeting stays visible to the club's current owner even
    -- when the credited intern's profile row is hidden from them by RLS.
    LEFT JOIN users cu ON cu.id = m.credited_user_id
    LEFT JOIN users bu ON bu.id = m.booked_by_user_id
    LEFT JOIN users vu ON vu.id = m.verified_by
    LEFT JOIN contacts c ON c.id = m.contact_id
    WHERE (${input.creditedUserId ?? null}::uuid IS NULL OR m.credited_user_id = ${input.creditedUserId ?? null})
      AND (${input.status ?? null}::text IS NULL OR m.status::text = ${input.status ?? null})
      AND (${input.cohortId ?? null}::uuid IS NULL OR m.cohort_id = ${input.cohortId ?? null})
    ORDER BY
      CASE m.status WHEN 'pending_verification' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
      coalesce(m.held_at, m.scheduled_start_at) DESC
    LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    contactName: r.contact_name,
    creditedUserId: r.credited_user_id,
    creditedUserName: r.credited_user_name,
    bookedByName: r.booked_by_name,
    scheduledStartAt: r.scheduled_start_at,
    scheduledTimezone: r.scheduled_timezone,
    status: r.status,
    heldAt: r.held_at,
    verifiedAt: r.verified_at,
    verifiedByName: r.verified_by_name,
    rejectionReason: r.rejection_reason,
    eligibilityOverride: r.eligibility_override,
    notes: r.notes,
    referenceUrl: r.reference_url,
    duplicateClubFlag: r.duplicate_club_flag,
  }));
}

export type PayoutRow = {
  id: string;
  userId: string;
  userName: string;
  milestoneIndex: number;
  amountCents: number;
  paidOn: string;
  reference: string | null;
  notes: string | null;
  recordedByName: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
};

export async function listPayouts(
  tx: Tx,
  input: { userId?: string | null; cohortId?: string | null },
): Promise<PayoutRow[]> {
  const rows = await tx<
    {
      id: string;
      user_id: string;
      user_name: string;
      milestone_index: number;
      amount_cents: number;
      paid_on: string;
      reference: string | null;
      notes: string | null;
      recorded_by_name: string;
      created_at: Date;
      voided_at: Date | null;
      void_reason: string | null;
    }[]
  >`
    SELECT p.id, p.user_id,
           coalesce(u.preferred_name, u.full_name, u.email::text, 'Another team member')
             AS user_name,
           p.milestone_index, p.amount_cents, p.paid_on::text AS paid_on,
           p.reference, p.notes,
           -- An intern may read their own payouts but not the admin who
           -- recorded them; an inner join here emptied their whole ledger.
           coalesce(r.preferred_name, r.full_name, r.email::text, 'A Waresport admin')
             AS recorded_by_name,
           p.created_at, p.voided_at, p.void_reason
    FROM payout_ledger p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN users r ON r.id = p.recorded_by
    WHERE (${input.userId ?? null}::uuid IS NULL OR p.user_id = ${input.userId ?? null})
      AND (${input.cohortId ?? null}::uuid IS NULL OR p.cohort_id = ${input.cohortId ?? null})
    ORDER BY p.paid_on DESC, p.created_at DESC`;

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    milestoneIndex: r.milestone_index,
    amountCents: r.amount_cents,
    paidOn: r.paid_on,
    reference: r.reference,
    notes: r.notes,
    recordedByName: r.recorded_by_name,
    createdAt: r.created_at,
    voidedAt: r.voided_at,
    voidReason: r.void_reason,
  }));
}
