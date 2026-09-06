'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertUser } from '@/lib/auth/session';
import { fail, ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { loadInternContext } from '@/lib/queries/intern-context';
import {
  completeFollowUp,
  logActivity,
  reopenFollowUp,
  setOrganizationStatus,
  snoozeFollowUp,
  voidActivity,
  type ActivityOutcome,
  type OrgStatus,
} from '@/lib/services/outreach';
import { analyseUrl } from '@/lib/domain/url';
import type { ActivityAction } from '@/lib/domain/metrics';

/**
 * Intern outreach actions.
 *
 * The actor is always taken from the session — never from the form — so a
 * forged `actorUserId` field is impossible. Timestamps are validated against
 * "now" and the cohort window, and every submit carries a client request id so
 * a retry or double-click cannot create two activity rows.
 */

const LOGGABLE = [
  'email_initial',
  'email_followup',
  'linkedin_message',
  'linkedin_followup',
  'phone_call',
  'research_note',
] as const;

const logSchema = z.object({
  organizationId: z.string().uuid('Choose a club.'),
  contactId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  actionType: z.enum(LOGGABLE),
  outcome: z.string().min(1),
  // datetime-local produces "YYYY-MM-DDTHH:mm" with no zone.
  occurredAtLocal: z.string().trim().min(1, 'Enter when this happened.'),
  notes: z.string().trim().max(2000).optional(),
  evidenceUrl: z.string().trim().max(500).optional(),
  followUpOn: z.string().trim().optional(),
  clientRequestId: z.string().trim().min(8).max(64),
});

/**
 * Interpret a wall-clock "YYYY-MM-DDTHH:mm" in a named timezone.
 *
 * The browser sends local wall time with no offset, so the server has to
 * resolve it against the intern's own timezone rather than the server's.
 */
function instantFromLocal(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const probe = new Date(naive);
  const offset = zoneOffset(probe, timeZone);
  const first = new Date(naive - offset);
  return new Date(naive - zoneOffset(first, timeZone));
}

function zoneOffset(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
    Math.floor(instant.getTime() / 1000) * 1000
  );
}

export async function logOutreachAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(logSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (input.evidenceUrl && !analyseUrl(input.evidenceUrl).safe) {
    return fail('Check the reference link.', {
      evidenceUrl: 'Only http(s) links can be stored as a reference.',
    });
  }

  try {
    const result = await asUser(
      user.id,
      async (
        tx,
      ): Promise<
        { error: string; logged: null } | { error: null; logged: { deduplicated: boolean } }
      > => {
        const context = await loadInternContext(tx, user.id);
        const occurredAt = instantFromLocal(input.occurredAtLocal, user.timezone);
        if (occurredAt === null) return { error: 'Enter a valid date and time.', logged: null };

        const logged = await logActivity(tx, {
          actorUserId: user.id,
          actorRole: user.role,
          organizationId: input.organizationId,
          contactId: input.contactId ?? null,
          cohortId: context.cohort?.id ?? null,
          actionType: input.actionType as ActivityAction,
          occurredAt,
          outcome: input.outcome as ActivityOutcome,
          notes: input.notes ?? null,
          evidenceUrl: input.evidenceUrl ?? null,
          followUpOn: input.followUpOn || null,
          policyVersion: context.policy.version,
          clientRequestId: input.clientRequestId,
          cohortRange: context.cohortRange,
        });
        return { error: null, logged };
      },
    );

    if (result.error !== null) {
      return fail(result.error, { occurredAtLocal: result.error });
    }

    revalidatePath('/leads');
    revalidatePath(`/leads/${input.organizationId}`);
    revalidatePath('/overview');
    revalidatePath('/follow-ups');

    return ok(
      result.logged.deduplicated
        ? 'Already logged — this submission was a repeat and did not create a second entry.'
        : input.actionType === 'research_note'
          ? 'Research note saved. It does not count as outreach.'
          : 'Outreach logged.',
    );
  } catch (error) {
    return toFormState(error, 'Could not log that. Try again.');
  }
}

const voidSchema = z.object({
  activityId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Give a short reason for the correction.').max(300),
  organizationId: z.string().uuid(),
});

export async function voidActivityAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(voidSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(user.id, (tx) =>
      voidActivity(tx, {
        actorUserId: user.id,
        actorRole: user.role,
        activityId: parsed.data.activityId,
        reason: parsed.data.reason,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not void that entry.');
  }

  revalidatePath(`/leads/${parsed.data.organizationId}`);
  revalidatePath('/overview');
  return ok('Entry voided. Your weekly totals have been recalculated.');
}

const statusSchema = z.object({
  organizationId: z.string().uuid(),
  status: z.string().min(1),
  expectedRowVersion: z.coerce.number().int().nonnegative(),
});

export async function setStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(statusSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    const result = await asUser(user.id, (tx) =>
      setOrganizationStatus(tx, {
        actorUserId: user.id,
        actorRole: user.role,
        organizationId: parsed.data.organizationId,
        status: parsed.data.status as OrgStatus,
        expectedRowVersion: parsed.data.expectedRowVersion,
      }),
    );
    if (result.status === 'conflict') {
      return fail(
        'This club was changed by someone else while you had it open. Reload to see the current state, then re-apply your change.',
      );
    }
  } catch (error) {
    return toFormState(error, 'Could not update the status.');
  }

  revalidatePath(`/leads/${parsed.data.organizationId}`);
  revalidatePath('/leads');
  return ok('Status updated. This records no outreach and no meeting.');
}

const followUpSchema = z.object({
  followUpId: z.string().uuid(),
  operation: z.enum(['complete', 'snooze', 'reopen']),
  until: z.string().trim().optional(),
});

export async function followUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(followUpSchema, formData);
  if (!parsed.ok) return parsed.state;
  const { followUpId, operation, until } = parsed.data;

  try {
    await asUser(user.id, async (tx) => {
      if (operation === 'complete')
        await completeFollowUp(tx, { actorUserId: user.id, followUpId });
      else if (operation === 'reopen') await reopenFollowUp(tx, followUpId);
      else {
        if (!until) throw new Error('missing date');
        await snoozeFollowUp(tx, { followUpId, until });
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not update that follow-up.');
  }

  revalidatePath('/follow-ups');
  revalidatePath('/overview');
  return ok(
    operation === 'complete'
      ? 'Follow-up completed.'
      : operation === 'snooze'
        ? 'Follow-up snoozed.'
        : 'Follow-up reopened.',
  );
}
