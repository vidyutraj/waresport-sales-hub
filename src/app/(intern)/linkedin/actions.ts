'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertUser } from '@/lib/auth/session';
import { fail, ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { logLinkedInConnection, updateProspectNotes } from '@/lib/services/prospects';

/**
 * LinkedIn connection log.
 *
 * One action for the whole intern flow: someone accepted their connection
 * request, and this records who. There is no club to pick (LinkedIn is its own
 * track) and no target: interns keep adding people as they accept.
 *
 * A profile counts once. Logging the same person again says so instead of
 * inflating the count.
 */

const connectionSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter their name.').max(160),
  profileUrl: z.string().trim().min(1, 'Paste their LinkedIn profile link.').max(400),
  notes: z.string().trim().max(1000).optional(),
});

export async function logConnectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(connectionSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  try {
    const outcome = await asUser(user.id, (tx) =>
      logLinkedInConnection(tx, {
        actorUserId: user.id,
        fullName: input.fullName,
        profileUrl: input.profileUrl,
        notes: input.notes ?? null,
      }),
    );

    revalidatePath('/linkedin');
    revalidatePath('/overview');

    if (outcome.status === 'already_logged') {
      return fail(
        `${input.fullName} is already in your list. Each person counts once, so edit their notes instead.`,
        {},
        parsed.values,
      );
    }
    if (outcome.status === 'collision') {
      // Deliberately minimal: another intern's name and notes are never shown.
      return fail(
        'Someone else is already working this profile, so it has not been added.',
        {},
        parsed.values,
      );
    }
    return ok(`${input.fullName} added to your connections.`);
  } catch (error) {
    return toFormState(error, 'Could not log that connection.');
  }
}

const notesSchema = z.object({
  prospectId: z.string().uuid(),
  notes: z.string().trim().max(1000).optional(),
});

export async function saveConnectionNotesAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(notesSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(user.id, (tx) =>
      updateProspectNotes(tx, {
        actorUserId: user.id,
        prospectId: parsed.data.prospectId,
        notes: parsed.data.notes ?? null,
      }),
    );
  } catch (error) {
    return toFormState(error, 'Could not save those notes.');
  }

  revalidatePath('/linkedin');
  return ok('Notes saved.');
}
