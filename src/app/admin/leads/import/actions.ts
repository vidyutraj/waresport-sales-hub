'use server';

import { revalidatePath } from 'next/cache';
import { asUser } from '@/lib/db';
import { assertAdmin } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { fail, ok, toFormState, type FormState } from '@/lib/form';
import {
  confirmImport,
  previewImport,
  type ImportOptions,
  type ImportPreview,
} from '@/lib/services/import';
import { IMPORT_IDLE, type PreviewState, type SerialisablePreview } from '@/lib/import-preview';
import { OUTCOME_LABELS } from '@/lib/domain/csv-import';

/**
 * Import wizard actions.
 *
 * The uploaded file is held in the form between preview and confirmation and
 * is never written to disk. Confirmation re-runs the identical classification
 * inside one transaction, so the admin approves exactly what gets applied.
 */

export async function previewImportAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const actor = await assertAdmin();
  const file = formData.get('file');

  if (!(file instanceof File) || file.size === 0) {
    return { ...IMPORT_IDLE, status: 'error', message: 'Choose a CSV file to upload.' };
  }
  const e = env();
  if (file.size > e.IMPORT_MAX_FILE_BYTES) {
    return {
      ...IMPORT_IDLE,
      status: 'error',
      message: `That file is ${(file.size / 1_000_000).toFixed(1)} MB; the limit is ${(e.IMPORT_MAX_FILE_BYTES / 1_000_000).toFixed(1)} MB.`,
    };
  }

  const content = await file.text();
  const options: ImportOptions = {
    defaultSport: String(formData.get('defaultSport') ?? '').trim() || null,
    defaultSource: String(formData.get('defaultSource') ?? '').trim() || null,
    duplicateStrategy: formData.get('duplicateStrategy') === 'update' ? 'update' : 'skip',
    applyTerritoryMap: formData.get('applyTerritoryMap') === 'on',
  };

  try {
    const preview = await asUser(actor.id, (tx) =>
      previewImport(tx, {
        fileName: file.name,
        content,
        options,
        maxBytes: e.IMPORT_MAX_FILE_BYTES,
        maxRows: e.IMPORT_MAX_ROWS,
      }),
    );

    return {
      status: 'success',
      message: `Parsed ${preview.summary.totalDataRows.toLocaleString()} data rows. Nothing has been imported yet.`,
      fieldErrors: {},
      preview: serialise(preview),
      content,
      options,
      fileName: file.name,
    };
  } catch (error) {
    return { ...IMPORT_IDLE, ...toFormState(error, 'Could not read that file.') };
  }
}

function serialise(preview: ImportPreview): SerialisablePreview {
  return {
    fileName: preview.fileName,
    fileBytes: preview.fileBytes,
    headers: preview.headers,
    mapping: Object.fromEntries(
      Object.entries(preview.mapping).filter(([, v]) => v !== undefined) as [string, string][],
    ),
    unmappedHeaders: preview.unmappedHeaders,
    missingRequired: preview.missingRequired,
    summary: preview.summary,
    unmatchedStates: preview.unmatchedStates,
    parseWarnings: preview.parseWarnings,
    sample: preview.sample.map((row) => ({
      sourceRowNumber: row.sourceRowNumber,
      outcome: row.outcome,
      outcomeLabel: OUTCOME_LABELS[row.outcome],
      clubName: row.organization?.name ?? '(missing club name)',
      location: [row.organization?.city, row.organization?.state].filter(Boolean).join(', ') || '—',
      contact:
        row.contact?.fullName ??
        row.contact?.email ??
        row.contact?.phone.raw ??
        'No contact details',
      reasons: row.reasons,
      warnings: row.warnings,
      reviewCandidates: row.reviewCandidates.map((c) => ({ label: c.label, why: c.why })),
    })),
  };
}

export async function confirmImportAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await assertAdmin();
  const content = String(formData.get('content') ?? '');
  const fileName = String(formData.get('fileName') ?? 'import.csv');
  if (content === '') return fail('The upload expired. Choose the file again.');

  let options: ImportOptions;
  try {
    options = JSON.parse(String(formData.get('options') ?? '{}')) as ImportOptions;
  } catch {
    return fail('The import options could not be read. Start the upload again.');
  }

  const e = env();
  try {
    const result = await asUser(actor.id, async (tx) => {
      // Re-run the identical classification inside the transaction that will
      // apply it, so the preview and the write can never diverge.
      const preview = await previewImport(tx, {
        fileName,
        content,
        options,
        maxBytes: e.IMPORT_MAX_FILE_BYTES,
        maxRows: e.IMPORT_MAX_ROWS,
      });
      return confirmImport(tx, {
        actorUserId: actor.id,
        actorRole: actor.role as 'owner' | 'admin',
        preview,
        options,
      });
    });

    revalidatePath('/admin/leads');
    revalidatePath('/admin');

    if (result.alreadyApplied) {
      return ok(
        'This exact import was already applied, so nothing changed. Its original result is unchanged.',
      );
    }

    return ok(
      `Imported. ${result.organizationsCreated} new club${result.organizationsCreated === 1 ? '' : 's'}, ` +
        `${result.contactsCreated} contact${result.contactsCreated === 1 ? '' : 's'}, ` +
        `${result.summary.byOutcome.skipped_duplicate} duplicate${result.summary.byOutcome.skipped_duplicate === 1 ? '' : 's'} skipped, ` +
        `${result.summary.byOutcome.needs_review} held for review, ` +
        `${result.summary.byOutcome.invalid} invalid.` +
        (result.unmatchedStates.length > 0
          ? ` States with no territory mapping: ${result.unmatchedStates.join(', ')}.`
          : ''),
      { batchId: result.batchId },
    );
  } catch (error) {
    return toFormState(error, 'The import failed and nothing was changed.');
  }
}
