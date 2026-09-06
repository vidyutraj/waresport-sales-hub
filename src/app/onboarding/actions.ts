'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertUser } from '@/lib/auth/session';
import { isValidTimeZone } from '@/lib/domain/time';
import { analyseLinkedInProfileUrl } from '@/lib/domain/linkedin';
import { analysePhone } from '@/lib/domain/phone';
import { fail, ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { recordAudit } from '@/lib/services/audit';

const schema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  preferredName: z.string().trim().max(60).optional(),
  timezone: z.string().trim().min(1, 'Choose your timezone.'),
  bio: z.string().trim().max(600).optional(),
  personalLinkedinUrl: z.string().trim().max(300).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  acknowledge: z.string().optional(),
  training: z.union([z.string(), z.array(z.string())]).optional(),
});

/**
 * Complete onboarding.
 *
 * Role, territory, cohort and the Waresport outreach address are deliberately
 * absent: they are admin-assigned and are only ever displayed here. Nothing in
 * this payload can change them, and the database's privilege trigger would
 * reject it even if it tried.
 */
export async function completeOnboardingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(schema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (!isValidTimeZone(input.timezone)) {
    return fail('Choose a valid timezone.', { timezone: 'That is not a recognised timezone.' });
  }

  // This is the intern's OWN profile link, never a prospect's.
  let linkedinUrl: string | null = null;
  if (input.personalLinkedinUrl) {
    const analysis = analyseLinkedInProfileUrl(input.personalLinkedinUrl);
    if (!analysis.ok) {
      return fail('Check your LinkedIn profile link.', { personalLinkedinUrl: analysis.reason });
    }
    linkedinUrl = analysis.url;
  }

  let phone: string | null = null;
  if (input.contactPhone) {
    const analysis = analysePhone(input.contactPhone);
    if (!analysis.valid) {
      return fail('Check your contact phone number.', {
        contactPhone: analysis.warning ?? 'That does not look like a valid phone number.',
      });
    }
    phone = analysis.raw;
  }

  if (input.acknowledge !== 'on') {
    return fail('Acknowledge the program guidance to continue.', {
      acknowledge: 'You need to acknowledge this before continuing.',
    });
  }

  const trainingKeys = Array.isArray(input.training)
    ? input.training
    : input.training
      ? [input.training]
      : [];

  try {
    await asUser(user.id, async (tx) => {
      await tx`
        UPDATE users
        SET full_name = ${input.fullName},
            preferred_name = ${input.preferredName ?? null},
            timezone = ${input.timezone},
            bio = ${input.bio ?? null},
            personal_linkedin_url = ${linkedinUrl},
            contact_phone = ${phone},
            onboarding_completed_at = coalesce(onboarding_completed_at, now()),
            program_acknowledged_at = coalesce(program_acknowledged_at, now())
        WHERE id = ${user.id}`;

      for (const key of trainingKeys) {
        await tx`
          INSERT INTO training_completions (user_id, topic_id)
          SELECT ${user.id}, t.id FROM training_topics t WHERE t.key = ${key}
          ON CONFLICT (user_id, topic_id) DO NOTHING`;
      }

      await recordAudit(tx, {
        actorUserId: user.id,
        actorRole: user.role,
        action: 'user.onboarding_completed',
        entityType: 'user',
        entityId: user.id,
        after: {
          fullName: input.fullName,
          timezone: input.timezone,
          trainingMarked: trainingKeys.length,
        },
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not save your profile. Try again.');
  }

  redirect(user.role === 'intern' ? '/overview' : '/admin');
}

export async function updateProfileAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(schema.omit({ acknowledge: true, training: true }), formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (!isValidTimeZone(input.timezone)) {
    return fail('Choose a valid timezone.', { timezone: 'That is not a recognised timezone.' });
  }

  let linkedinUrl: string | null = null;
  if (input.personalLinkedinUrl) {
    const analysis = analyseLinkedInProfileUrl(input.personalLinkedinUrl);
    if (!analysis.ok) {
      return fail('Check your LinkedIn profile link.', { personalLinkedinUrl: analysis.reason });
    }
    linkedinUrl = analysis.url;
  }

  let phone: string | null = null;
  if (input.contactPhone) {
    const analysis = analysePhone(input.contactPhone);
    if (!analysis.valid) {
      return fail('Check your contact phone number.', {
        contactPhone: analysis.warning ?? 'That does not look like a valid phone number.',
      });
    }
    phone = analysis.raw;
  }

  try {
    await asUser(user.id, async (tx) => {
      await tx`
        UPDATE users
        SET full_name = ${input.fullName},
            preferred_name = ${input.preferredName ?? null},
            timezone = ${input.timezone},
            bio = ${input.bio ?? null},
            personal_linkedin_url = ${linkedinUrl},
            contact_phone = ${phone}
        WHERE id = ${user.id}`;
    });
  } catch (error) {
    return toFormState(error, 'Could not save your profile. Try again.');
  }

  return ok('Profile saved.');
}

export async function toggleTrainingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const key = String(formData.get('topicKey') ?? '');
  const complete = String(formData.get('complete') ?? '') === 'true';
  if (key === '') return fail('Unknown training topic.');

  try {
    await asUser(user.id, async (tx) => {
      if (complete) {
        await tx`
          INSERT INTO training_completions (user_id, topic_id)
          SELECT ${user.id}, t.id FROM training_topics t WHERE t.key = ${key}
          ON CONFLICT (user_id, topic_id) DO NOTHING`;
      } else {
        // Un-ticking is allowed and audited; it is self-reported either way.
        await tx`
          DELETE FROM training_completions
          WHERE user_id = ${user.id}
            AND topic_id = (SELECT id FROM training_topics WHERE key = ${key})`;
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not update that training item.');
  }
  return ok(complete ? 'Marked complete.' : 'Marked incomplete.');
}
