'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertUser } from '@/lib/auth/session';
import { fail, ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { loadInternContext } from '@/lib/queries/intern-context';
import {
  bookMeeting,
  OUTREACH_CHANNELS,
  rescheduleMeeting,
  submitHeld,
} from '@/lib/services/meetings';
import { analyseUrl } from '@/lib/domain/url';
import { isValidTimeZone } from '@/lib/domain/time';

/**
 * Intern meeting actions: book, reschedule, submit as held.
 *
 * Approval and verification are deliberately absent. Only an admin or owner
 * can approve a booking or verify a held meeting, and a database trigger
 * rejects either transition even if this file changed.
 */

function instantFromLocal(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];
  const naive = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  const offsetAt = (instant: Date) => {
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
      Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
      ) -
      Math.floor(instant.getTime() / 1000) * 1000
    );
  };
  const first = new Date(naive - offsetAt(new Date(naive)));
  return new Date(naive - offsetAt(first));
}

const bookSchema = z.object({
  organizationId: z.string().uuid(),
  contactId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  scheduledStartLocal: z.string().trim().min(1, 'Choose when the meeting is scheduled.'),
  scheduledTimezone: z.string().trim().min(1),
  notes: z.string().trim().max(1000).optional(),
  referenceUrl: z.string().trim().max(500).optional(),
});

export async function bookMeetingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(bookSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (!isValidTimeZone(input.scheduledTimezone)) {
    return fail('Choose a valid timezone.', { scheduledTimezone: 'Unrecognised timezone.' });
  }
  if (input.referenceUrl && !analyseUrl(input.referenceUrl).safe) {
    return fail('Check the calendar link.', {
      referenceUrl: 'Only http(s) links can be stored.',
    });
  }

  const start = instantFromLocal(input.scheduledStartLocal, input.scheduledTimezone);
  if (start === null) {
    return fail('Enter a valid date and time.', { scheduledStartLocal: 'Invalid date and time.' });
  }

  try {
    await asUser(user.id, async (tx) => {
      const context = await loadInternContext(tx, user.id);
      await bookMeeting(tx, {
        actorUserId: user.id,
        actorRole: user.role,
        organizationId: input.organizationId,
        contactId: input.contactId ?? null,
        // An intern always books for themselves; the server never reads a
        // credited-intern field from the form.
        creditedUserId: user.id,
        cohortId: context.cohort?.id ?? null,
        scheduledStartAt: start,
        scheduledTimezone: input.scheduledTimezone,
        notes: input.notes ?? null,
        referenceUrl: input.referenceUrl ?? null,
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not book that meeting.');
  }

  revalidatePath('/meetings');
  revalidatePath(`/leads/${input.organizationId}`);
  revalidatePath('/overview');
  return ok(
    'Meeting booked and sent to an admin for approval. It earns nothing until it has taken place and an admin verifies it.',
  );
}

const logSchema = z.object({
  contactName: z.string().trim().min(2, 'Enter who the meeting is with.').max(160),
  scheduledStartLocal: z.string().trim().min(1, 'Choose when the meeting is.'),
  scheduledTimezone: z.string().trim().min(1),
  meetingLink: z.string().trim().min(1, 'Paste the Google Meet link.').max(500),
  outreachChannel: z.enum(OUTREACH_CHANNELS, { message: 'Choose how you reached them.' }),
  background: z.string().trim().max(2000).optional(),
});

/**
 * Log a meeting that has just been booked, from the Meetings tab.
 *
 * It goes to the admin approval queue. It is a standalone log: the intern types
 * who it is with, and it is not tied to one of their clubs.
 */
export async function logBookedMeetingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(logSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (!isValidTimeZone(input.scheduledTimezone)) {
    return fail('Choose a valid timezone.', {}, parsed.values);
  }
  if (!analyseUrl(input.meetingLink).safe) {
    return fail(
      'Check the meeting link.',
      { meetingLink: 'Paste the full https:// link.' },
      parsed.values,
    );
  }
  const start = instantFromLocal(input.scheduledStartLocal, input.scheduledTimezone);
  if (start === null) {
    return fail(
      'Enter a valid date and time.',
      { scheduledStartLocal: 'Invalid date and time.' },
      parsed.values,
    );
  }

  try {
    await asUser(user.id, async (tx) => {
      const context = await loadInternContext(tx, user.id);
      await bookMeeting(tx, {
        actorUserId: user.id,
        actorRole: user.role,
        organizationId: null,
        contactName: input.contactName,
        creditedUserId: user.id,
        cohortId: context.cohort?.id ?? null,
        scheduledStartAt: start,
        scheduledTimezone: input.scheduledTimezone,
        meetingLink: input.meetingLink,
        outreachChannel: input.outreachChannel,
        background: input.background ?? null,
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not log that meeting.');
  }

  revalidatePath('/meetings');
  revalidatePath('/admin/meetings');
  return ok(`Meeting with ${input.contactName} logged and sent to an admin for approval.`);
}

const heldSchema = z.object({
  meetingId: z.string().uuid(),
  heldAtLocal: z.string().trim().min(1, 'Enter when the meeting actually took place.'),
  timezone: z.string().trim().min(1),
  notes: z.string().trim().max(1000).optional(),
});

export async function submitHeldAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(heldSchema, formData);
  if (!parsed.ok) return parsed.state;

  const heldAt = instantFromLocal(parsed.data.heldAtLocal, parsed.data.timezone);
  if (heldAt === null) {
    return fail('Enter a valid date and time.', { heldAtLocal: 'Invalid date and time.' });
  }

  try {
    await asUser(user.id, (tx) =>
      submitHeld(tx, {
        actorUserId: user.id,
        meetingId: parsed.data.meetingId,
        heldAt,
        notes: parsed.data.notes ?? null,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not submit that meeting.');
  }

  revalidatePath('/meetings');
  revalidatePath('/overview');
  return ok('Submitted for verification. An admin will confirm it took place.');
}

const rescheduleSchema = z.object({
  meetingId: z.string().uuid(),
  scheduledStartLocal: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  reason: z.string().trim().max(300).optional(),
});

export async function rescheduleMeetingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(rescheduleSchema, formData);
  if (!parsed.ok) return parsed.state;

  const start = instantFromLocal(parsed.data.scheduledStartLocal, parsed.data.timezone);
  if (start === null) {
    return fail('Enter a valid date and time.', { scheduledStartLocal: 'Invalid date and time.' });
  }

  try {
    await asUser(user.id, (tx) =>
      rescheduleMeeting(tx, {
        actorUserId: user.id,
        meetingId: parsed.data.meetingId,
        scheduledStartAt: start,
        scheduledTimezone: parsed.data.timezone,
        reason: parsed.data.reason ?? null,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not reschedule that meeting.');
  }

  revalidatePath('/meetings');
  // Rescheduling updates the same record; it never creates a second payable
  // meeting, so no counter moves here.
  return ok('Meeting rescheduled. This is still the same meeting, not a new one.');
}
