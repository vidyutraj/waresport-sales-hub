'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertUser } from '@/lib/auth/session';
import { fail, ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { loadInternContext } from '@/lib/queries/intern-context';
import { territoryForState } from '@/lib/queries/program';
import {
  createProspect,
  createResearchedOrganization,
  recordConnectionRequest,
  recordProspectEvent,
} from '@/lib/services/prospects';
import { claimResearchedOrganization } from '@/lib/services/assignment';
import { normalizeStateCode } from '@/lib/domain/normalize';

/**
 * LinkedIn prospect tracker actions.
 *
 * Adding a prospect is research and moves no counter. Sending the request is a
 * separate, explicit action, and only its first occurrence per profile counts.
 */

const prospectSchema = z.object({
  mode: z.enum(['existing_org', 'new_org']),
  organizationId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  newOrgName: z.string().trim().max(300).optional(),
  newOrgCity: z.string().trim().max(120).optional(),
  newOrgState: z.string().trim().max(60).optional(),
  fullName: z.string().trim().min(2, "Enter the prospect's full name.").max(160),
  profileUrl: z.string().trim().min(1, 'A LinkedIn profile URL is required.').max(400),
  title: z.string().trim().max(160).optional(),
  sport: z.string().trim().max(80).optional(),
  email: z.string().trim().max(254).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export async function addProspectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(prospectSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (input.mode === 'existing_org' && !input.organizationId) {
    return fail(
      'Choose the club this person belongs to.',
      { organizationId: 'Choose one of your assigned clubs, or add a new organization.' },
      parsed.values,
    );
  }
  if (input.mode === 'new_org' && !input.newOrgName) {
    return fail(
      'Name the organization you researched.',
      { newOrgName: 'An organization name is required.' },
      parsed.values,
    );
  }

  try {
    const outcome = await asUser(user.id, async (tx) => {
      const context = await loadInternContext(tx, user.id);
      let organizationId = input.organizationId ?? null;

      if (input.mode === 'new_org') {
        const state = normalizeStateCode(input.newOrgState ?? null);
        const territoryId = await territoryForState(tx, state);

        // The server always checks for an existing organization before
        // creating one, so two interns cannot silently create the same club.
        const created = await createResearchedOrganization(tx, {
          actorUserId: user.id,
          name: input.newOrgName!,
          city: input.newOrgCity ?? null,
          state,
          sport: input.sport ?? null,
          territoryId,
        });

        if (created.status === 'exists') {
          return {
            kind: 'org_collision' as const,
            // No name, no owner, no notes: a minimal collision notice only.
            visible: created.organizationId !== null,
          };
        }

        organizationId = created.organizationId;
        const claim = await claimResearchedOrganization(tx, {
          actorUserId: user.id,
          organizationId,
        });
        if (claim.status === 'collision') {
          return { kind: 'org_collision' as const, visible: false };
        }
      }

      if (organizationId === null) return { kind: 'missing_org' as const };

      const result = await createProspect(tx, {
        actorUserId: user.id,
        organizationId,
        fullName: input.fullName,
        profileUrl: input.profileUrl,
        title: input.title ?? null,
        territoryId: context.membership?.territoryId ?? null,
        sport: input.sport ?? null,
        email: input.email ?? null,
        notes: input.notes ?? null,
      });
      return { kind: 'prospect' as const, result };
    });

    if (outcome.kind === 'org_collision') {
      return fail(
        'Another intern is already working that organization. Nothing was created. Ask an admin to review it if you think it should be yours.',
        {},
        parsed.values,
      );
    }
    if (outcome.kind === 'missing_org') {
      return fail('Could not resolve the organization for this prospect.', {}, parsed.values);
    }

    revalidatePath('/linkedin');
    revalidatePath('/overview');

    if (outcome.result.status === 'collision') {
      return fail(
        'That LinkedIn profile is already being tracked by someone else. Nothing was created, and no details about their work are shown here.',
        {},
        parsed.values,
      );
    }
    if (outcome.result.status === 'already_yours') {
      return ok('You already track that profile — nothing was duplicated.');
    }
    return ok('Prospect added. Adding a prospect is research; it does not count as outreach yet.');
  } catch (error) {
    return { ...toFormState(error, 'Could not add that prospect.'), values: parsed.values };
  }
}

const eventSchema = z.object({
  prospectId: z.string().uuid(),
  eventType: z.enum([
    'request_sent',
    'connected',
    'message_sent',
    'replied',
    'interested',
    'not_interested',
  ]),
  notes: z.string().trim().max(1000).optional(),
  clientRequestId: z.string().trim().min(8).max(64),
});

export async function recordProspectEventAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(eventSchema, formData);
  if (!parsed.ok) return parsed.state;
  const { prospectId, eventType, notes, clientRequestId } = parsed.data;

  try {
    await asUser(user.id, async (tx) => {
      const context = await loadInternContext(tx, user.id);
      const now = new Date();

      if (eventType === 'request_sent') {
        await recordConnectionRequest(tx, {
          actorUserId: user.id,
          actorRole: user.role,
          prospectId,
          occurredAt: now,
          notes: notes ?? null,
          cohortId: context.cohort?.id ?? null,
          cohortRange: context.cohortRange,
          clientRequestId,
        });
        return;
      }

      await recordProspectEvent(tx, {
        actorUserId: user.id,
        actorRole: user.role,
        prospectId,
        eventType,
        occurredAt: now,
        notes: notes ?? null,
        cohortId: context.cohort?.id ?? null,
        cohortRange: context.cohortRange,
        clientRequestId,
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not record that.');
  }

  revalidatePath('/linkedin');
  revalidatePath('/overview');

  const messages: Record<typeof eventType, string> = {
    request_sent:
      "Connection request recorded. It counts once toward this week's LinkedIn request target.",
    connected: 'Connection recorded. Accepting a connection is not outreach and counts nothing.',
    message_sent: 'Message recorded. It does not count again toward the request target.',
    replied: 'Reply recorded.',
    interested: 'Marked interested.',
    not_interested: 'Marked not interested.',
  };
  return ok(messages[eventType]);
}
