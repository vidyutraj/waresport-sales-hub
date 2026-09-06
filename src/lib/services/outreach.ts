import '@/lib/server-guard';
import { attempt, isRestrictViolation, isUniqueViolation, type Tx } from '@/lib/db';
import type { ActivityAction } from '@/lib/domain/metrics';
import { recordAudit } from './audit';

/**
 * Outreach logging.
 *
 * Outreach itself happens outside this system — an intern sends the email from
 * their Waresport mailbox or the request from their own LinkedIn account and
 * then records it here. Copying an address, opening a profile or drafting a
 * message is never outreach; only an explicit log entry is.
 *
 * Activity rows are append-only. A mistake is corrected by voiding the
 * original with a reason and logging a replacement that points back at it, so
 * metrics recalculate without any row being silently rewritten or deleted.
 */

export class OutreachError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'future_timestamp'
      | 'suppressed'
      | 'duplicate_request'
      | 'not_owner'
      | 'not_found'
      | 'already_voided'
      | 'outside_cohort',
  ) {
    super(message);
    this.name = 'OutreachError';
  }
}

export type ActivityChannel = 'email' | 'linkedin' | 'phone' | 'other';

export type ActivityOutcome =
  | 'sent'
  | 'no_response'
  | 'replied'
  | 'positive_reply'
  | 'not_interested'
  | 'bounced'
  | 'invalid_contact'
  | 'do_not_contact'
  | 'meeting_booked'
  | 'logged';

const CHANNEL_FOR_ACTION: Record<ActivityAction, ActivityChannel> = {
  email_initial: 'email',
  email_followup: 'email',
  linkedin_connection_request: 'linkedin',
  linkedin_message: 'linkedin',
  linkedin_followup: 'linkedin',
  phone_call: 'phone',
  research_note: 'other',
};

export function channelForAction(action: ActivityAction): ActivityChannel {
  return CHANNEL_FOR_ACTION[action];
}

/** Outcomes that automatically create a suppression. */
const SUPPRESSING_OUTCOMES: Partial<Record<ActivityOutcome, { channel: string; reason: string }>> =
  {
    bounced: { channel: 'email', reason: 'Email bounced' },
    invalid_contact: { channel: 'all', reason: 'Contact details are invalid' },
    do_not_contact: { channel: 'all', reason: 'Recipient asked not to be contacted' },
  };

export type LogActivityInput = {
  actorUserId: string;
  actorRole: 'owner' | 'admin' | 'intern';
  organizationId: string;
  contactId?: string | null;
  prospectId?: string | null;
  cohortId?: string | null;
  actionType: ActivityAction;
  occurredAt: Date;
  outcome: ActivityOutcome;
  notes?: string | null;
  evidenceUrl?: string | null;
  followUpOn?: string | null;
  policyVersion?: number | null;
  /** Stable per-submission id; a retried POST returns the original row. */
  clientRequestId?: string | null;
  correctedFromId?: string | null;
  /** Half-open cohort window; backdating is allowed only inside it. */
  cohortRange?: { start: Date; end: Date } | null;
  now?: Date;
};

export type LogActivityResult = {
  activityId: string;
  followUpId: string | null;
  deduplicated: boolean;
  suppressionCreated: boolean;
};

export async function logActivity(tx: Tx, input: LogActivityInput): Promise<LogActivityResult> {
  const now = input.now ?? new Date();

  // Outreach cannot be logged in the future. A one-minute grace absorbs clock
  // skew between the browser and the server without allowing real backdating
  // of a send that has not happened yet.
  if (input.occurredAt.getTime() > now.getTime() + 60_000) {
    throw new OutreachError(
      'Outreach cannot be recorded with a future timestamp.',
      'future_timestamp',
    );
  }

  // Auditable backdating: allowed, but only within the cohort window.
  if (input.cohortRange) {
    const t = input.occurredAt.getTime();
    if (t < input.cohortRange.start.getTime() || t >= input.cohortRange.end.getTime()) {
      throw new OutreachError(
        'That date falls outside your cohort. Ask an admin to record it as an exception.',
        'outside_cohort',
      );
    }
  }

  const channel = channelForAction(input.actionType);

  // The INSERT can legitimately fail on a unique index (a retried submit, or a
  // second connection request for the same profile), so it runs in its own
  // savepoint and the surrounding transaction survives.
  const inserted = await attempt(tx, async (sp) => {
    const [row] = await sp<{ id: string }[]>`
      INSERT INTO activity_events (
        organization_id, contact_id, prospect_id, actor_user_id, cohort_id,
        channel, action_type, occurred_at, outcome, notes, evidence_url,
        follow_up_on, policy_version, client_request_id, corrected_from_id
      ) VALUES (
        ${input.organizationId}, ${input.contactId ?? null}, ${input.prospectId ?? null},
        ${input.actorUserId}, ${input.cohortId ?? null},
        ${channel}::activity_channel, ${input.actionType}::activity_action,
        ${input.occurredAt}, ${input.outcome}::activity_outcome,
        ${input.notes ?? null}, ${input.evidenceUrl ?? null},
        ${input.followUpOn ?? null}::date, ${input.policyVersion ?? null},
        ${input.clientRequestId ?? null}, ${input.correctedFromId ?? null}
      )
      RETURNING id`;
    return row;
  });

  if (!inserted.ok) {
    // A double-clicked or retried submit carries the same client request id.
    if (isUniqueViolation(inserted.error) && input.clientRequestId) {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM activity_events
        WHERE actor_user_id = ${input.actorUserId} AND client_request_id = ${input.clientRequestId}`;
      if (existing !== undefined) {
        return {
          activityId: existing.id,
          followUpId: null,
          deduplicated: true,
          suppressionCreated: false,
        };
      }
    }
    // The partial unique index on connection requests per prospect.
    if (isUniqueViolation(inserted.error) && input.actionType === 'linkedin_connection_request') {
      throw new OutreachError(
        'A connection request to this profile is already recorded. It only counts once.',
        'duplicate_request',
      );
    }
    if (isRestrictViolation(inserted.error)) {
      throw new OutreachError(
        'Outreach to this contact is suppressed. An admin must lift the suppression first.',
        'suppressed',
      );
    }
    throw inserted.error;
  }

  const row = inserted.value;
  if (row === undefined) throw new OutreachError('Could not record that activity.', 'not_found');

  const followUpId = input.followUpOn
    ? await createFollowUp(tx, {
        organizationId: input.organizationId,
        contactId: input.contactId ?? null,
        prospectId: input.prospectId ?? null,
        assignedUserId: input.actorUserId,
        dueOn: input.followUpOn,
        createdFrom: row.id,
      })
    : null;

  const suppression = SUPPRESSING_OUTCOMES[input.outcome];
  let suppressionCreated = false;
  if (suppression) {
    suppressionCreated = await applySuppression(tx, {
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      contactId: input.contactId ?? null,
      channel: suppression.channel,
      reason: suppression.reason,
    });
  }

  return { activityId: row.id, followUpId, deduplicated: false, suppressionCreated };
}

/**
 * Void an activity with a reason. The original row stays in the timeline and
 * in the audit trail; it simply stops counting toward any metric.
 */
export async function voidActivity(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'intern';
    activityId: string;
    reason: string;
  },
): Promise<void> {
  const [existing] = await tx<
    { id: string; actor_user_id: string; voided_at: Date | null; action_type: string }[]
  >`
    SELECT id, actor_user_id, voided_at, action_type::text
    FROM activity_events WHERE id = ${input.activityId} FOR UPDATE`;
  if (existing === undefined)
    throw new OutreachError('That log entry no longer exists.', 'not_found');
  if (existing.voided_at !== null) {
    throw new OutreachError('That log entry is already voided.', 'already_voided');
  }
  if (existing.actor_user_id !== input.actorUserId && input.actorRole === 'intern') {
    throw new OutreachError('You can only correct your own log entries.', 'not_owner');
  }

  await tx`
    UPDATE activity_events
    SET voided_at = now(), voided_by = ${input.actorUserId}, void_reason = ${input.reason}
    WHERE id = ${input.activityId}`;

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'activity.voided',
    entityType: 'activity_event',
    entityId: input.activityId,
    before: { voided: false, actionType: existing.action_type },
    after: { voided: true },
    reason: input.reason,
  });
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export async function createFollowUp(
  tx: Tx,
  input: {
    organizationId: string;
    contactId?: string | null;
    prospectId?: string | null;
    assignedUserId: string;
    dueOn: string;
    notes?: string | null;
    createdFrom?: string | null;
  },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO follow_ups
      (organization_id, contact_id, prospect_id, assigned_user_id, due_on, notes, created_from)
    VALUES (${input.organizationId}, ${input.contactId ?? null}, ${input.prospectId ?? null},
            ${input.assignedUserId}, ${input.dueOn}::date, ${input.notes ?? null},
            ${input.createdFrom ?? null})
    RETURNING id`;
  return row!.id;
}

export type FollowUpBucket = 'overdue' | 'due_today' | 'upcoming' | 'snoozed' | 'completed';

export type FollowUpRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  contactId: string | null;
  contactName: string | null;
  dueOn: string;
  status: string;
  snoozedUntil: string | null;
  notes: string | null;
  completedAt: Date | null;
  bucket: FollowUpBucket;
};

export async function listFollowUps(
  tx: Tx,
  input: { assignedUserId: string; today: string; bucket?: FollowUpBucket | null },
): Promise<FollowUpRow[]> {
  const rows = await tx<
    {
      id: string;
      organization_id: string;
      organization_name: string;
      contact_id: string | null;
      contact_name: string | null;
      due_on: string;
      status: string;
      snoozed_until: string | null;
      notes: string | null;
      completed_at: Date | null;
      bucket: FollowUpBucket;
    }[]
  >`
    SELECT f.id, f.organization_id, o.name AS organization_name,
           f.contact_id, c.full_name AS contact_name,
           f.due_on::text AS due_on, f.status::text, f.snoozed_until::text AS snoozed_until,
           f.notes, f.completed_at,
           CASE
             WHEN f.status = 'completed' THEN 'completed'
             WHEN f.status = 'snoozed'   THEN 'snoozed'
             WHEN f.due_on <  ${input.today}::date THEN 'overdue'
             WHEN f.due_on =  ${input.today}::date THEN 'due_today'
             ELSE 'upcoming'
           END AS bucket
    FROM follow_ups f
    JOIN organizations o ON o.id = f.organization_id
    LEFT JOIN contacts c ON c.id = f.contact_id
    WHERE f.assigned_user_id = ${input.assignedUserId}
      AND f.status <> 'cancelled'
    ORDER BY
      CASE f.status WHEN 'open' THEN 0 WHEN 'snoozed' THEN 1 ELSE 2 END,
      f.due_on ASC, o.name ASC`;

  const all = rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    contactId: r.contact_id,
    contactName: r.contact_name,
    dueOn: r.due_on,
    status: r.status,
    snoozedUntil: r.snoozed_until,
    notes: r.notes,
    completedAt: r.completed_at,
    bucket: r.bucket,
  }));
  return input.bucket ? all.filter((r) => r.bucket === input.bucket) : all;
}

export async function completeFollowUp(
  tx: Tx,
  input: { actorUserId: string; followUpId: string },
): Promise<void> {
  await tx`
    UPDATE follow_ups
    SET status = 'completed', completed_at = now(), completed_by = ${input.actorUserId}
    WHERE id = ${input.followUpId} AND status <> 'completed'`;
}

export async function snoozeFollowUp(
  tx: Tx,
  input: { followUpId: string; until: string },
): Promise<void> {
  await tx`
    UPDATE follow_ups
    SET status = 'snoozed', snoozed_until = ${input.until}::date, due_on = ${input.until}::date
    WHERE id = ${input.followUpId} AND status IN ('open', 'snoozed')`;
}

export async function reopenFollowUp(tx: Tx, followUpId: string): Promise<void> {
  await tx`
    UPDATE follow_ups SET status = 'open', snoozed_until = NULL
    WHERE id = ${followUpId} AND status = 'snoozed'`;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Record a suppression. It applies across assignees and survives re-imports,
 * because it is attached to the organization/contact rather than to whoever
 * happened to be logging at the time.
 */
export async function applySuppression(
  tx: Tx,
  input: {
    actorUserId: string;
    organizationId: string;
    contactId: string | null;
    channel: string;
    reason: string;
  },
): Promise<boolean> {
  const result = await attempt(tx, async (sp) => {
    if (input.contactId) {
      await sp`
        INSERT INTO suppressions (scope, organization_id, contact_id, channel, reason, created_by)
        VALUES ('contact', ${input.organizationId}, ${input.contactId},
                ${input.channel}::suppression_channel, ${input.reason}, ${input.actorUserId})`;
    } else {
      await sp`
        INSERT INTO suppressions (scope, organization_id, channel, reason, created_by)
        VALUES ('organization', ${input.organizationId},
                ${input.channel}::suppression_channel, ${input.reason}, ${input.actorUserId})`;
    }
  });
  if (result.ok) return true;
  // Already suppressed on that channel — nothing more to do.
  if (isUniqueViolation(result.error)) return false;
  throw result.error;
}

export async function liftSuppression(
  tx: Tx,
  input: { actorUserId: string; suppressionId: string; reason: string },
): Promise<void> {
  await tx`
    UPDATE suppressions
    SET lifted_at = now(), lifted_by = ${input.actorUserId}, lift_reason = ${input.reason}
    WHERE id = ${input.suppressionId} AND lifted_at IS NULL`;
  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    action: 'suppression.lifted',
    entityType: 'suppression',
    entityId: input.suppressionId,
    reason: input.reason,
  });
}

// ---------------------------------------------------------------------------
// Organization status (a workflow summary, never a metric)
// ---------------------------------------------------------------------------

export type OrgStatus =
  | 'new'
  | 'contacted'
  | 'replied'
  | 'interested'
  | 'meeting_booked'
  | 'meeting_held'
  | 'not_interested'
  | 'unreachable'
  | 'do_not_contact';

export const ORG_STATUS_LABELS: Record<OrgStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  meeting_booked: 'Meeting booked',
  meeting_held: 'Meeting held',
  not_interested: 'Not interested',
  unreachable: 'Unreachable',
  do_not_contact: 'Do not contact',
};

/**
 * Change the workflow status. This records no outreach and no meeting: a stage
 * change can never fabricate activity or payable credit.
 */
export async function setOrganizationStatus(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'intern';
    organizationId: string;
    status: OrgStatus;
    reason?: string | null;
    expectedRowVersion?: number | null;
  },
): Promise<{ status: 'updated' | 'unchanged' | 'conflict' }> {
  const [org] = await tx<{ status: string; row_version: number }[]>`
    SELECT status::text, row_version FROM organizations
    WHERE id = ${input.organizationId} FOR UPDATE`;
  if (org === undefined) throw new OutreachError('That club no longer exists.', 'not_found');

  // Optimistic locking: a stale form submit is rejected, not silently applied.
  if (
    input.expectedRowVersion !== null &&
    input.expectedRowVersion !== undefined &&
    input.expectedRowVersion !== org.row_version
  ) {
    return { status: 'conflict' };
  }
  if (org.status === input.status) return { status: 'unchanged' };

  await tx`UPDATE organizations SET status = ${input.status}::org_status WHERE id = ${input.organizationId}`;
  await tx`
    INSERT INTO organization_status_events (organization_id, actor_user_id, from_status, to_status, reason)
    VALUES (${input.organizationId}, ${input.actorUserId}, ${org.status}::org_status,
            ${input.status}::org_status, ${input.reason ?? null})`;

  return { status: 'updated' };
}
