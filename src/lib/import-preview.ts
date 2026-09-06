import type { ImportOptions, ImportPreview } from '@/lib/services/import';
import type { FormState } from '@/lib/form';

/**
 * Shared types and the initial state for the import wizard.
 *
 * These live outside the `'use server'` module because a server-action file may
 * only export async functions — exporting a plain object from one fails the
 * build with "a 'use server' file can only export async functions".
 */

/** A trimmed preview, safe to serialise into the client component. */
export type SerialisablePreview = {
  fileName: string;
  fileBytes: number;
  headers: string[];
  mapping: Record<string, string>;
  unmappedHeaders: string[];
  missingRequired: string[];
  summary: ImportPreview['summary'];
  unmatchedStates: string[];
  parseWarnings: { fileLineNumber: number; message: string }[];
  sample: {
    sourceRowNumber: number;
    outcome: string;
    outcomeLabel: string;
    clubName: string;
    location: string;
    contact: string;
    reasons: string[];
    warnings: string[];
    reviewCandidates: { label: string; why: string }[];
  }[];
};

export type PreviewState = FormState & {
  preview: SerialisablePreview | null;
  /** The raw file text, round-tripped so confirmation re-parses the same bytes. */
  content: string | null;
  options: ImportOptions | null;
  fileName: string | null;
};

export const IMPORT_IDLE: PreviewState = {
  status: 'idle',
  message: null,
  fieldErrors: {},
  preview: null,
  content: null,
  options: null,
  fileName: null,
};
