'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { asUser } from '@/lib/db';
import { assertAdmin } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { fail, ok, parseForm, toFormState, type FormState } from '@/lib/form';
import { analyseUrl } from '@/lib/domain/url';
import { recordAudit } from '@/lib/services/audit';

/**
 * Resource hub and project administration.
 *
 * Uploaded documents are written outside the web root and are only ever
 * served through /api/resources/[id]/file, which checks the session and the
 * resource's audience first. The stored filename is a generated UUID, so a
 * hostile filename can never traverse the storage directory.
 */

const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const MAX_FILE_BYTES = 20_000_000;

const resourceSchema = z.object({
  resourceId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  title: z.string().trim().min(2, 'Give the resource a title.').max(200),
  category: z.enum([
    'email_script',
    'linkedin_script',
    'personalization',
    'training',
    'program_doc',
    'platform',
    'other',
  ]),
  audience: z.enum(['all', 'interns', 'admins']),
  summary: z.string().trim().max(400).optional(),
  bodyMarkdown: z.string().trim().max(20000).optional(),
  linkUrl: z.string().trim().max(500).optional(),
  isStarterExample: z.string().optional(),
});

export async function saveResourceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(resourceSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  if (input.linkUrl && !analyseUrl(input.linkUrl).safe) {
    return fail('Check the link.', { linkUrl: 'Only http(s) links can be stored.' });
  }

  const file = formData.get('file');
  let stored: { path: string; name: string; mime: string; bytes: number } | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_FILE_BYTES) {
      return fail('That file is too large.', {
        file: `The limit is ${(MAX_FILE_BYTES / 1_000_000).toFixed(0)} MB.`,
      });
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return fail('That file type is not supported.', {
        file: 'Upload a PDF, Word, PowerPoint, Markdown, CSV or plain-text file.',
      });
    }
    // A generated name means the user-supplied filename never touches the path.
    // Deployment-configured root; the stored filename is a generated UUID, so
    // no user-supplied text ever reaches the path.
    const storageDir = resolve(
      /* turbopackIgnore: true */ process.cwd(),
      env().STORAGE_DIR,
      'resources',
    );
    const storedName = `${randomUUID()}`;
    await mkdir(storageDir, { recursive: true });
    await writeFile(
      resolve(/* turbopackIgnore: true */ storageDir, storedName),
      Buffer.from(await file.arrayBuffer()),
    );
    stored = {
      path: `resources/${storedName}`,
      name: file.name.slice(0, 200),
      mime: file.type,
      bytes: file.size,
    };
  }

  try {
    await asUser(actor.id, async (tx) => {
      if (input.resourceId) {
        await tx`
          UPDATE resources
          SET title = ${input.title},
              category = ${input.category}::resource_category,
              audience = ${input.audience}::resource_audience,
              summary = ${input.summary ?? null},
              body_markdown = ${input.bodyMarkdown ?? null},
              link_url = ${input.linkUrl ?? null},
              is_starter_example = ${input.isStarterExample === 'on'},
              file_path = coalesce(${stored?.path ?? null}, file_path),
              file_name = coalesce(${stored?.name ?? null}, file_name),
              file_mime = coalesce(${stored?.mime ?? null}, file_mime),
              file_bytes = coalesce(${stored?.bytes ?? null}, file_bytes)
          WHERE id = ${input.resourceId}`;
      } else {
        await tx`
          INSERT INTO resources
            (title, category, audience, summary, body_markdown, link_url, is_starter_example,
             file_path, file_name, file_mime, file_bytes, created_by)
          VALUES (${input.title}, ${input.category}::resource_category,
                  ${input.audience}::resource_audience, ${input.summary ?? null},
                  ${input.bodyMarkdown ?? null}, ${input.linkUrl ?? null},
                  ${input.isStarterExample === 'on'}, ${stored?.path ?? null},
                  ${stored?.name ?? null}, ${stored?.mime ?? null}, ${stored?.bytes ?? null},
                  ${actor.id})`;
      }
      await recordAudit(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        action: input.resourceId ? 'resource.updated' : 'resource.created',
        entityType: 'resource',
        entityId: input.resourceId ?? null,
        after: { title: input.title, category: input.category, hasFile: stored !== null },
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not save that resource.');
  }

  revalidatePath('/admin/resources');
  revalidatePath('/training');
  return ok(input.resourceId ? 'Resource updated.' : 'Resource added.');
}

export async function archiveResourceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const resourceId = String(formData.get('resourceId') ?? '');
  try {
    await asUser(actor.id, async (tx) => {
      await tx`UPDATE resources SET is_archived = true WHERE id = ${resourceId}`;
      await recordAudit(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        action: 'resource.archived',
        entityType: 'resource',
        entityId: resourceId,
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not archive that resource.');
  }
  revalidatePath('/admin/resources');
  revalidatePath('/training');
  return ok('Resource archived. It is hidden from interns but kept for the record.');
}

/**
 * Bring an archived resource back.
 *
 * Possible since migration 0013: before it, an admin could not even see an
 * archived row, because the only SELECT policy filtered them out.
 */
export async function restoreResourceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const resourceId = String(formData.get('resourceId') ?? '');
  try {
    await asUser(actor.id, async (tx) => {
      await tx`UPDATE resources SET is_archived = false WHERE id = ${resourceId}`;
      await recordAudit(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        action: 'resource.restored',
        entityType: 'resource',
        entityId: resourceId,
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not restore that resource.');
  }
  revalidatePath('/admin/resources');
  revalidatePath('/training');
  return ok('Resource restored. Interns can see it again.');
}

/**
 * Cancel a project.
 *
 * Cancelled rather than deleted: interns may already have submitted work
 * against it, and that history stays attached to the project. It drops off the
 * admin list and out of every intern's assignments.
 */
export async function cancelProjectAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const projectId = String(formData.get('projectId') ?? '');
  try {
    await asUser(actor.id, async (tx) => {
      await tx`UPDATE projects SET status = 'cancelled' WHERE id = ${projectId}`;
      await recordAudit(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        action: 'project.cancelled',
        entityType: 'project',
        entityId: projectId,
      });
    });
  } catch (error) {
    return toFormState(error, 'Could not cancel that project.');
  }
  revalidatePath('/admin/resources');
  revalidatePath('/training');
  return ok('Project cancelled. Submissions already made are kept.');
}

const projectSchema = z.object({
  projectId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  title: z.string().trim().min(2, 'Give the project a title.').max(200),
  description: z.string().trim().max(4000).optional(),
  dueOn: z.string().trim().optional(),
  cohortId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  assignees: z.union([z.string(), z.array(z.string())]).optional(),
});

export async function saveProjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(projectSchema, formData);
  if (!parsed.ok) return parsed.state;
  const input = parsed.data;

  const assignees = (
    Array.isArray(input.assignees) ? input.assignees : input.assignees ? [input.assignees] : []
  ).filter((v) => v !== '');

  try {
    await asUser(actor.id, async (tx) => {
      let projectId = input.projectId ?? null;
      if (projectId === null) {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO projects (cohort_id, title, description, due_on, created_by)
          VALUES (${input.cohortId ?? null}, ${input.title}, ${input.description ?? null},
                  ${input.dueOn || null}::date, ${actor.id})
          RETURNING id`;
        projectId = row!.id;
      } else {
        await tx`
          UPDATE projects
          SET title = ${input.title}, description = ${input.description ?? null},
              due_on = ${input.dueOn || null}::date, cohort_id = ${input.cohortId ?? null}
          WHERE id = ${projectId}`;
      }

      for (const userId of assignees) {
        await tx`
          INSERT INTO project_assignments (project_id, user_id)
          VALUES (${projectId}, ${userId})
          ON CONFLICT (project_id, user_id) DO NOTHING`;
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not save that project.');
  }

  revalidatePath('/admin/resources');
  revalidatePath('/training');
  return ok(input.projectId ? 'Project updated.' : 'Project created and assigned.');
}

const feedbackSchema = z.object({
  submissionId: z.string().uuid(),
  feedback: z.string().trim().min(1, 'Write some feedback.').max(4000),
  markComplete: z.string().optional(),
});

export async function reviewSubmissionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const parsed = parseForm(feedbackSchema, formData);
  if (!parsed.ok) return parsed.state;

  try {
    await asUser(actor.id, async (tx) => {
      const [row] = await tx<{ project_id: string; user_id: string }[]>`
        UPDATE project_submissions
        SET feedback = ${parsed.data.feedback}, feedback_by = ${actor.id}, feedback_at = now()
        WHERE id = ${parsed.data.submissionId}
        RETURNING project_id, user_id`;
      if (row !== undefined && parsed.data.markComplete === 'on') {
        await tx`
          UPDATE project_assignments SET status = 'completed'
          WHERE project_id = ${row.project_id} AND user_id = ${row.user_id}`;
      }
    });
  } catch (error) {
    return toFormState(error, 'Could not save that feedback.');
  }

  revalidatePath('/admin/resources');
  revalidatePath('/training');
  return ok('Feedback saved.');
}
