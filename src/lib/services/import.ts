import '@/lib/server-guard';
import { createHash } from 'node:crypto';
import type { Tx } from '@/lib/db';
import {
  autoMapColumns,
  classifyRows,
  parseCsv,
  prepareRow,
  summariseClassification,
  type ClassifiedRow,
  type ClassifyContext,
  type ColumnMapping,
  type ExistingContact,
  type ExistingOrganization,
  type ImportSummary,
  type ParsedCsv,
} from '@/lib/domain/csv-import';
import { organizationCandidateKey, organizationIdentityKey } from '@/lib/domain/normalize';
import { recordAudit } from './audit';

/**
 * CSV import pipeline.
 *
 * Two phases share one implementation:
 *   preview()  — parse, normalise, classify, and report, touching nothing.
 *   confirm()  — re-run the same classification inside a transaction and apply
 *                only what the preview promised.
 *
 * Idempotency has two layers:
 *   1. `import_batches.idempotency_key` — retrying the same confirmed import
 *      returns the original result instead of importing twice.
 *   2. `import_source_keys` — a per-row key recorded on first import, so
 *      re-uploading the same file later is classified as duplicates and
 *      creates nothing.
 */

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: 'too_large' | 'too_many_rows' | 'parse_failed' | 'mapping' | 'not_found',
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export type ImportOptions = {
  defaultSport?: string | null;
  defaultSource?: string | null;
  /** How to treat a row that matches an existing record. */
  duplicateStrategy?: 'skip' | 'update';
  /** Derive organization territory from the admin's state map. */
  applyTerritoryMap?: boolean;
};

export type ImportPreview = {
  fileName: string;
  fileHash: string;
  fileBytes: number;
  headers: string[];
  mapping: ColumnMapping;
  unmappedHeaders: string[];
  missingRequired: string[];
  summary: ImportSummary;
  rows: ClassifiedRow[];
  /** A representative slice for the on-screen preview table. */
  sample: ClassifiedRow[];
  parseWarnings: ParsedCsv['parseWarnings'];
  unmatchedStates: string[];
  idempotencyKey: string;
};

export function fileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function idempotencyKeyFor(input: {
  fileHash: string;
  mapping: ColumnMapping;
  options: ImportOptions;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        fileHash: input.fileHash,
        mapping: Object.entries(input.mapping).sort(),
        options: Object.entries(input.options).sort(),
      }),
    )
    .digest('hex');
}

/** Build the "what already exists" context used to classify rows. */
async function loadContext(
  tx: Tx,
  rows: ReturnType<typeof prepareRow>[],
): Promise<ClassifyContext> {
  const identityKeys = new Set<string>();
  const candidateKeys = new Set<string>();
  const emails = new Set<string>();

  for (const row of rows) {
    if (row.organization) {
      identityKeys.add(row.organization.identityKey);
      candidateKeys.add(row.organization.candidateKey);
    }
    if (row.contact?.email) emails.add(row.contact.email);
  }

  const orgRows =
    candidateKeys.size === 0
      ? []
      : await tx<
          {
            id: string;
            name: string;
            city: string | null;
            state: string | null;
            has_assignment: boolean;
          }[]
        >`
          SELECT o.id, o.name, o.city, o.state,
                 EXISTS (SELECT 1 FROM organization_assignments a
                         WHERE a.organization_id = o.id AND a.unassigned_at IS NULL) AS has_assignment
          FROM organizations o
          WHERE o.is_archived = false
            AND (app.normalize_name(o.name) || '|' || coalesce(o.state, ''))
                = ANY(${[...candidateKeys]}::text[])`;

  const organizationsByIdentity = new Map<string, ExistingOrganization>();
  const organizationsByCandidate = new Map<string, ExistingOrganization[]>();
  for (const r of orgRows) {
    const entry: ExistingOrganization = {
      id: r.id,
      name: r.name,
      identityKey: organizationIdentityKey({ name: r.name, state: r.state, city: r.city }),
      candidateKey: organizationCandidateKey({ name: r.name, state: r.state }),
      city: r.city,
      state: r.state,
      hasAssignment: r.has_assignment,
    };
    organizationsByIdentity.set(entry.identityKey, entry);
    const list = organizationsByCandidate.get(entry.candidateKey) ?? [];
    list.push(entry);
    organizationsByCandidate.set(entry.candidateKey, list);
  }

  const contactRows =
    emails.size === 0
      ? []
      : await tx<
          {
            id: string;
            organization_id: string;
            email: string | null;
            phone_digits: string | null;
          }[]
        >`
          SELECT id, organization_id, email_normalized AS email, phone_digits
          FROM contacts
          WHERE is_archived = false AND email_normalized = ANY(${[...emails]}::text[])`;

  const contactsByEmail = new Map<string, ExistingContact[]>();
  for (const r of contactRows) {
    if (r.email === null) continue;
    const list = contactsByEmail.get(r.email) ?? [];
    list.push({
      id: r.id,
      organizationId: r.organization_id,
      email: r.email,
      phoneDigits: r.phone_digits,
    });
    contactsByEmail.set(r.email, list);
  }

  const keyRows = await tx<{ dedupe_key: string }[]>`
    SELECT dedupe_key FROM import_source_keys`;

  return {
    organizationsByIdentity,
    organizationsByCandidate,
    contactsByEmail,
    knownSourceKeys: new Set(keyRows.map((r) => r.dedupe_key)),
  };
}

export async function previewImport(
  tx: Tx,
  input: {
    fileName: string;
    content: string;
    mapping?: ColumnMapping | null;
    options?: ImportOptions;
    maxBytes: number;
    maxRows: number;
  },
): Promise<ImportPreview> {
  const bytes = Buffer.byteLength(input.content, 'utf8');
  if (bytes > input.maxBytes) {
    throw new ImportError(
      `That file is ${(bytes / 1_000_000).toFixed(1)} MB; the limit is ${(input.maxBytes / 1_000_000).toFixed(1)} MB.`,
      'too_large',
    );
  }

  let parsed: ParsedCsv;
  try {
    parsed = parseCsv(input.content);
  } catch (error) {
    throw new ImportError(
      error instanceof Error ? error.message : 'The file could not be parsed as CSV.',
      'parse_failed',
    );
  }

  if (parsed.rows.length > input.maxRows) {
    throw new ImportError(
      `That file has ${parsed.rows.length.toLocaleString()} rows; the limit is ${input.maxRows.toLocaleString()}.`,
      'too_many_rows',
    );
  }

  const auto = autoMapColumns(parsed.headers);
  const mapping = input.mapping ?? auto.mapping;
  const missingRequired = input.mapping
    ? mapping.clubName
      ? []
      : ['clubName']
    : auto.missingRequired;

  const options = input.options ?? {};
  const prepared = parsed.rows.map((row) =>
    prepareRow(row, mapping, {
      defaultSport: options.defaultSport ?? null,
      defaultSource: options.defaultSource ?? null,
    }),
  );

  const context = await loadContext(tx, prepared);
  const classified = classifyRows(prepared, context);
  const summary = summariseClassification(classified, parsed);

  // States present in the file with no territory mapping — flagged, not fixed.
  const stateMap = await tx<{ state_code: string }[]>`SELECT state_code FROM territory_states`;
  const mapped = new Set(stateMap.map((r) => r.state_code));
  const unmatchedStates = [
    ...new Set(
      classified
        .map((r) => r.organization?.state)
        .filter((s): s is string => typeof s === 'string' && !mapped.has(s)),
    ),
  ].sort();

  const hash = fileHash(input.content);

  return {
    fileName: input.fileName,
    fileHash: hash,
    fileBytes: bytes,
    headers: parsed.headers,
    mapping,
    unmappedHeaders: auto.unmappedHeaders,
    missingRequired,
    summary,
    rows: classified,
    sample: buildSample(classified),
    parseWarnings: parsed.parseWarnings,
    unmatchedStates,
    idempotencyKey: idempotencyKeyFor({ fileHash: hash, mapping, options }),
  };
}

/** Up to 10 examples of each outcome, so the preview shows the hard cases. */
function buildSample(rows: readonly ClassifiedRow[]): ClassifiedRow[] {
  const perOutcome = new Map<string, ClassifiedRow[]>();
  for (const row of rows) {
    const list = perOutcome.get(row.outcome) ?? [];
    if (list.length < 10) list.push(row);
    perOutcome.set(row.outcome, list);
  }
  return [...perOutcome.values()].flat().sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
}

export type ImportResult = {
  batchId: string;
  alreadyApplied: boolean;
  summary: ImportSummary;
  organizationsCreated: number;
  contactsCreated: number;
  organizationsUpdated: number;
  territoriesAssigned: number;
  unmatchedStates: string[];
};

/**
 * Apply a previewed import.
 *
 * Runs inside the caller's transaction: either the batch, all of its rows and
 * every organization/contact it creates commit together, or nothing does.
 */
export async function confirmImport(
  tx: Tx,
  input: {
    actorUserId: string;
    actorRole: 'owner' | 'admin';
    preview: ImportPreview;
    options?: ImportOptions;
  },
): Promise<ImportResult> {
  const options = input.options ?? {};
  const { preview } = input;

  // Layer 1 idempotency: the same confirmed import cannot be applied twice.
  const [existingBatch] = await tx<{ id: string; result: ImportResult | null; status: string }[]>`
    SELECT id, result, status::text FROM import_batches
    WHERE idempotency_key = ${preview.idempotencyKey}`;
  if (existingBatch !== undefined && existingBatch.status === 'confirmed') {
    return {
      ...(existingBatch.result ?? {
        summary: preview.summary,
        organizationsCreated: 0,
        contactsCreated: 0,
        organizationsUpdated: 0,
        territoriesAssigned: 0,
        unmatchedStates: preview.unmatchedStates,
      }),
      batchId: existingBatch.id,
      alreadyApplied: true,
    };
  }

  const [batch] = await tx<{ id: string }[]>`
    INSERT INTO import_batches
      (filename, file_hash, file_bytes, uploaded_by, status, idempotency_key,
       options, column_mapping, parsed_row_count)
    VALUES (${preview.fileName}, ${preview.fileHash}, ${preview.fileBytes}, ${input.actorUserId},
            'draft', ${preview.idempotencyKey},
            ${options as never}::jsonb, ${preview.mapping as never}::jsonb,
            ${preview.summary.totalDataRows})
    RETURNING id`;
  if (batch === undefined) throw new ImportError('Could not start that import.', 'not_found');

  const territoryMap =
    options.applyTerritoryMap === false ? new Map<string, string>() : await loadStateMap(tx);

  let organizationsCreated = 0;
  let contactsCreated = 0;
  let organizationsUpdated = 0;
  let territoriesAssigned = 0;

  // Identity -> id for organizations created earlier in this same batch.
  const createdByIdentity = new Map<string, string>();

  for (const row of preview.rows) {
    let organizationId: string | null = null;
    let contactId: string | null = null;
    const org = row.organization;

    if (
      org !== null &&
      (row.outcome === 'organization_created' ||
        row.outcome === 'contact_added' ||
        row.outcome === 'updated')
    ) {
      const territoryId = org.state ? (territoryMap.get(org.state) ?? null) : null;

      if (row.outcome === 'organization_created') {
        const known = createdByIdentity.get(org.identityKey);
        if (known !== undefined) {
          organizationId = known;
        } else {
          const [created] = await tx<{ id: string; inserted: boolean }[]>`
            INSERT INTO organizations
              (name, city, state, sport, source, source_url, notes, territory_id,
               territory_source, created_by)
            VALUES (${org.name}, ${org.city}, ${org.state}, ${org.sport},
                    ${org.source ?? 'csv_import'}, ${org.sourceUrl}, ${org.notes},
                    ${territoryId}, ${territoryId ? 'state_map' : 'unassigned'},
                    ${input.actorUserId})
            ON CONFLICT (name_normalized, coalesce(state, ''), city_normalized)
              WHERE is_archived = false
            DO UPDATE SET updated_at = now()
            RETURNING id, (xmax = 0) AS inserted`;
          organizationId = created?.id ?? null;
          if (organizationId !== null) {
            createdByIdentity.set(org.identityKey, organizationId);
            // `xmax = 0` distinguishes a real insert from an ON CONFLICT update,
            // so the report never claims to have created a row it only touched.
            if (created?.inserted === true) {
              organizationsCreated += 1;
              if (territoryId !== null) territoriesAssigned += 1;
            }
          }
        }
      } else {
        organizationId =
          row.matchedOrganizationId?.startsWith('new:') === true
            ? (createdByIdentity.get(org.identityKey) ?? null)
            : row.matchedOrganizationId;

        // An explicit update never blanks an existing value with an empty one,
        // and never touches assignment, status or history.
        if (row.outcome === 'updated' && organizationId !== null) {
          await tx`
            UPDATE organizations
            SET city       = coalesce(${org.city}, city),
                sport      = coalesce(${org.sport}, sport),
                source_url = coalesce(${org.sourceUrl}, source_url),
                notes      = coalesce(${org.notes}, notes)
            WHERE id = ${organizationId}`;
          organizationsUpdated += 1;
        }
      }

      if (organizationId !== null && row.contact !== null) {
        const [contact] = await tx<{ id: string; inserted: boolean }[]>`
          INSERT INTO contacts
            (organization_id, full_name, role_title, email, email_valid,
             phone_raw, phone_e164, phone_valid, phone_extension, source_url, created_by)
          VALUES (${organizationId}, ${row.contact.fullName}, ${row.contact.roleTitle},
                  ${row.contact.email}, ${row.contact.emailValid},
                  ${row.contact.phone.raw}, ${row.contact.phone.e164}, ${row.contact.phone.valid},
                  ${row.contact.phone.extension}, ${row.contact.sourceUrl}, ${input.actorUserId})
          ON CONFLICT (organization_id, email_normalized)
            WHERE email_normalized IS NOT NULL AND is_archived = false
          DO UPDATE SET updated_at = now()
          RETURNING id, (xmax = 0) AS inserted`;
        contactId = contact?.id ?? null;
        if (contactId !== null && contact?.inserted === true) contactsCreated += 1;
      }

      // Layer 2 idempotency: remember this row so a re-upload is a no-op.
      if (organizationId !== null) {
        await tx`
          INSERT INTO import_source_keys (dedupe_key, organization_id, contact_id, first_batch_id)
          VALUES (${row.sourceKey}, ${organizationId}, ${contactId}, ${batch.id})
          ON CONFLICT (dedupe_key) DO NOTHING`;
      }
    }

    await tx`
      INSERT INTO import_rows
        (batch_id, source_row_number, raw, outcome, reasons, warnings, organization_id, contact_id)
      VALUES (${batch.id}, ${row.sourceRowNumber}, ${row.raw as never}::jsonb,
              ${row.outcome}::import_outcome, ${row.reasons}, ${row.warnings},
              ${organizationId}, ${contactId})`;
  }

  const result: Omit<ImportResult, 'batchId' | 'alreadyApplied'> = {
    summary: preview.summary,
    organizationsCreated,
    contactsCreated,
    organizationsUpdated,
    territoriesAssigned,
    unmatchedStates: preview.unmatchedStates,
  };

  await tx`
    UPDATE import_batches
    SET status = 'confirmed', confirmed_at = now(), result = ${result as never}::jsonb
    WHERE id = ${batch.id}`;

  await recordAudit(tx, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: 'import.confirmed',
    entityType: 'import_batch',
    entityId: batch.id,
    after: {
      fileName: preview.fileName,
      ...result.summary.byOutcome,
      organizationsCreated,
      contactsCreated,
    },
  });

  return { ...result, batchId: batch.id, alreadyApplied: false };
}

async function loadStateMap(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx<{ state_code: string; territory_id: string }[]>`
    SELECT state_code, territory_id FROM territory_states`;
  return new Map(rows.map((r) => [r.state_code, r.territory_id]));
}

export type BatchSummaryRow = {
  id: string;
  filename: string;
  uploadedByName: string;
  status: string;
  parsedRowCount: number;
  createdAt: Date;
  confirmedAt: Date | null;
  result: ImportResult | null;
};

export async function listImportBatches(tx: Tx, limit = 25): Promise<BatchSummaryRow[]> {
  const rows = await tx<
    {
      id: string;
      filename: string;
      uploaded_by_name: string;
      status: string;
      parsed_row_count: number;
      created_at: Date;
      confirmed_at: Date | null;
      result: ImportResult | null;
    }[]
  >`
    SELECT b.id, b.filename,
           coalesce(u.preferred_name, u.full_name, u.email::text) AS uploaded_by_name,
           b.status::text, b.parsed_row_count, b.created_at, b.confirmed_at, b.result
    FROM import_batches b
    JOIN users u ON u.id = b.uploaded_by
    ORDER BY b.created_at DESC
    LIMIT ${Math.min(100, Math.max(1, limit))}`;
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    uploadedByName: r.uploaded_by_name,
    status: r.status,
    parsedRowCount: r.parsed_row_count,
    createdAt: r.created_at,
    confirmedAt: r.confirmed_at,
    result: r.result,
  }));
}

export type RejectedRow = {
  sourceRowNumber: number;
  outcome: string;
  reasons: string[];
  warnings: string[];
  raw: Record<string, string>;
};

/** Rows an admin may want to fix and re-upload, for the CSV download. */
export async function rejectedRowsForBatch(tx: Tx, batchId: string): Promise<RejectedRow[]> {
  const rows = await tx<
    {
      source_row_number: number;
      outcome: string;
      reasons: string[];
      warnings: string[];
      raw: Record<string, string>;
    }[]
  >`
    SELECT source_row_number, outcome::text, reasons, warnings, raw
    FROM import_rows
    WHERE batch_id = ${batchId} AND outcome IN ('invalid', 'needs_review')
    ORDER BY source_row_number`;
  return rows.map((r) => ({
    sourceRowNumber: r.source_row_number,
    outcome: r.outcome,
    reasons: r.reasons,
    warnings: r.warnings,
    raw: r.raw,
  }));
}
