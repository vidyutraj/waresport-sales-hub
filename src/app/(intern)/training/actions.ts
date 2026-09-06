'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertUser } from '@/lib/auth/session';
import { ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { loadInternContext } from '@/lib/queries/intern-context';
import { analyseUrl } from '@/lib/domain/url';
import { fail } from '@/lib/form';

/** Training completion, project submissions, and the end-of-program reflection. */

const trainingSchema = z.object({
  topicKey: z.string().trim().min(1),
  complete: z.enum(['true', 'false']),
});

export async function toggleTrainingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(trainingSchema, formData);
  if (!parsed.ok) return parsed.state;
  const complete = parsed.data.complete === 'true';

  try {
    await asUser(user.id, async (tx) => {
      if (complete) {
        await tx`
          INSERT INTO training_completions (user_id, topic_id)
          SELECT ${user.id}, t.id FROM training_topics t WHERE t.key = ${parsed.data.topicKey}
          ON CONFLICT (user_id, topic_id) DO NOTHING`;
      } else {
        await tx`
          DELETE FROM training_completions
          WHERE user_id = ${user.id}
            AND topic_id = (SELECT id FROM training_topics WHERE key = ${parsed.data.topicKey})`;
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not update that training item.');
  }

  revalidatePath('/training');
  revalidatePath('/overview');
  return ok(complete ? 'Marked complete.' : 'Marked incomplete.');
}

const submissionSchema = z.object({
  projectId: z.string().uuid(),
  notes: z.string().trim().max(4000).optional(),
  linkUrl: z.string().trim().max(500).optional(),
  markReady: z.string().optional(),
});

export async function submitProjectAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(submissionSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (input.linkUrl && !analyseUrl(input.linkUrl).safe) {
    return fail('Check the link.', { linkUrl: 'Only http(s) links can be stored.' });
  }
  if (!input.notes && !input.linkUrl) {
    return fail('Add notes or a link before submitting.', {
      notes: 'Add something for the reviewer to look at.',
    });
  }

  try {
    await asUser(user.id, async (tx) => {
      await tx`
        INSERT INTO project_submissions (project_id, user_id, notes, link_url)
        VALUES (${input.projectId}, ${user.id}, ${input.notes ?? null}, ${input.linkUrl ?? null})`;
      if (input.markReady === 'on') {
        await tx`
          UPDATE project_assignments SET status = 'ready_for_review'
          WHERE project_id = ${input.projectId} AND user_id = ${user.id}`;
      } else {
        await tx`
          UPDATE project_assignments SET status = 'in_progress'
          WHERE project_id = ${input.projectId} AND user_id = ${user.id} AND status = 'assigned'`;
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not save that submission.');
  }

  revalidatePath('/training');
  return ok(input.markReady === 'on' ? 'Submitted for review.' : 'Progress saved.');
}

const reflectionSchema = z.object({
  whatWorked: z.string().trim().max(4000).optional(),
  whatDidNotWork: z.string().trim().max(4000).optional(),
  successfulSports: z.string().trim().max(4000).optional(),
  recommendations: z.string().trim().max(4000).optional(),
  submit: z.string().optional(),
});

export async function saveReflectionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await assertUser();
  const parsed = parseForm(reflectionSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;
  const submitting = input.submit === 'on';

  try {
    const outcome = await asUser(user.id, async (tx) => {
      const context = await loadInternContext(tx, user.id);
      if (context.cohort === null) return 'no_cohort' as const;
      await tx`
        INSERT INTO reflections
          (user_id, cohort_id, what_worked, what_did_not_work, successful_sports, recommendations, submitted_at)
        VALUES (${user.id}, ${context.cohort.id}, ${input.whatWorked ?? null},
                ${input.whatDidNotWork ?? null}, ${input.successfulSports ?? null},
                ${input.recommendations ?? null}, ${submitting ? new Date() : null})
        ON CONFLICT (user_id, cohort_id) DO UPDATE
          SET what_worked = EXCLUDED.what_worked,
              what_did_not_work = EXCLUDED.what_did_not_work,
              successful_sports = EXCLUDED.successful_sports,
              recommendations = EXCLUDED.recommendations,
              submitted_at = coalesce(EXCLUDED.submitted_at, reflections.submitted_at)`;
      return 'saved' as const;
    });
    if (outcome === 'no_cohort') return fail('You are not in a cohort yet.');
  } catch (error) {
    return toFormState(error, 'Could not save your reflection.');
  }

  revalidatePath('/training');
  return ok(submitting ? 'Reflection submitted. Thank you.' : 'Draft saved.');
}
