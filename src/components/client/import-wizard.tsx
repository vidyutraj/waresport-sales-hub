'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { confirmImportAction, previewImportAction } from '@/app/admin/leads/import/actions';
import { IMPORT_IDLE } from '@/lib/import-preview';
import { FormFeedback, SubmitButton } from '@/components/client/form';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  Input,
  Select,
  StatTile,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { IDLE } from '@/lib/form';
import { IMPORT_OUTCOME_TONES } from '@/lib/labels';

const FIELD_LABELS: Record<string, string> = {
  clubName: 'Club / organization name',
  role: 'Contact role',
  contactName: 'Contact name',
  phone: 'Phone',
  email: 'Email',
  city: 'City',
  state: 'State',
  sourceUrl: 'Source URL',
  notes: 'Notes',
  sport: 'Sport',
  source: 'Source tag',
};

/**
 * Two-step import: upload and preview, then confirm.
 *
 * The preview is advisory only until confirmation; the server re-runs the same
 * classification inside the writing transaction, so what the admin approves is
 * what gets applied.
 */
export function ImportWizard({ territoryCount }: { territoryCount: number }) {
  const [previewState, previewDispatch] = useActionState(previewImportAction, IMPORT_IDLE);
  const [confirmState, confirmDispatch] = useActionState(confirmImportAction, IDLE);

  const preview = previewState.preview;
  const applied = confirmState.status === 'success';

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader title="1. Upload" description="Nothing is written at this step." />
        <CardBody>
          <form action={previewDispatch} className="flex flex-col gap-4">
            <FormFeedback state={previewState} />

            <Field
              label="CSV file"
              htmlFor="file"
              required
              hint="The file is read in memory for the preview and is never stored on the server."
            >
              <input
                id="file"
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
                className="block w-full text-[13px] text-ink-700 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-900 file:px-3 file:py-2 file:text-[13px] file:font-semibold file:text-white"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Default sport"
                htmlFor="defaultSport"
                hint="Applied to rows with no sport of their own."
              >
                <Input
                  id="defaultSport"
                  name="defaultSport"
                  placeholder="Baseball"
                  maxLength={80}
                />
              </Field>
              <Field
                label="Source tag"
                htmlFor="defaultSource"
                hint="Where this list came from, for later filtering."
              >
                <Input
                  id="defaultSource"
                  name="defaultSource"
                  placeholder="SportsEngine directory export"
                  maxLength={120}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Existing records"
                htmlFor="duplicateStrategy"
                hint="Skip is the default; updating never blanks a field that already has a value."
              >
                <Select id="duplicateStrategy" name="duplicateStrategy" defaultValue="skip">
                  <option value="skip">Skip duplicates (recommended)</option>
                  <option value="update">Update matching records</option>
                </Select>
              </Field>
              <div className="flex items-end">
                <Checkbox
                  id="applyTerritoryMap"
                  name="applyTerritoryMap"
                  defaultChecked
                  label="Derive territory from the state map"
                  hint={
                    territoryCount === 0
                      ? 'No territories configured yet.'
                      : 'Unmapped states stay unassigned and are flagged.'
                  }
                />
              </div>
            </div>

            <div>
              <SubmitButton pendingLabel="Parsing…">Preview import</SubmitButton>
            </div>
          </form>
        </CardBody>
      </Card>

      {preview ? (
        <>
          <Card>
            <CardHeader
              title="2. Review"
              description={`${preview.fileName} · ${(preview.fileBytes / 1000).toFixed(0)} KB`}
            />
            <CardBody>
              {preview.missingRequired.length > 0 ? (
                <Alert tone="danger" className="mb-4" title="A required column is missing">
                  Could not find a column for:{' '}
                  {preview.missingRequired.map((f) => FIELD_LABELS[f] ?? f).join(', ')}. Rename the
                  header in your file and upload it again.
                </Alert>
              ) : null}

              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <StatTile
                  label="Data rows parsed"
                  value={preview.summary.totalDataRows.toLocaleString()}
                />
                <StatTile
                  label="Rows with warnings"
                  value={preview.summary.withWarnings.toLocaleString()}
                  tone={preview.summary.withWarnings > 0 ? 'caution' : 'neutral'}
                />
                <StatTile
                  label="Blank lines skipped"
                  value={preview.summary.blankLinesSkipped.toLocaleString()}
                />
              </div>

              <h3 className="mb-2 text-[13px] font-semibold text-ink-800">
                What will happen to each row
              </h3>
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Outcome</Th>
                    <Th numeric>Rows</Th>
                    <Th>Meaning</Th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['organization_created', 'A new club record is created.'],
                      [
                        'contact_added',
                        'The club already exists; this person is added as another contact.',
                      ],
                      ['updated', 'An existing record is updated with new values.'],
                      ['skipped_duplicate', 'Already present. Nothing is written.'],
                      [
                        'needs_review',
                        'An uncertain match. Nothing is written; resolve it manually.',
                      ],
                      ['invalid', 'Unusable (for example, no club name). Nothing is written.'],
                    ] as const
                  ).map(([key, meaning]) => (
                    <tr key={key} data-testid={`import-outcome-${key}`}>
                      <Td>
                        <Badge tone={IMPORT_OUTCOME_TONES[key] ?? 'neutral'}>
                          {key.replace(/_/g, ' ')}
                        </Badge>
                      </Td>
                      <Td numeric>
                        {preview.summary.byOutcome[
                          key as keyof typeof preview.summary.byOutcome
                        ].toLocaleString()}
                      </Td>
                      <Td className="text-ink-600">{meaning}</Td>
                    </tr>
                  ))}
                  <tr className="bg-ink-50 font-semibold">
                    <Td>Total</Td>
                    <Td numeric>{preview.summary.totalDataRows.toLocaleString()}</Td>
                    <Td className="text-ink-600">
                      {preview.summary.reconciled
                        ? 'Every parsed row is accounted for exactly once.'
                        : 'Row accounting did not reconcile — do not confirm; report this.'}
                    </Td>
                  </tr>
                </tbody>
              </TableScroll>

              {preview.unmappedHeaders.length > 0 ? (
                <Alert tone="info" className="mt-4" title="Columns that will be ignored">
                  {preview.unmappedHeaders.join(', ')}
                </Alert>
              ) : null}

              {preview.unmatchedStates.length > 0 ? (
                <Alert tone="caution" className="mt-4" title="States with no territory mapping">
                  {preview.unmatchedStates.join(', ')} — clubs in these states will import with no
                  territory and appear as unassigned.
                </Alert>
              ) : null}

              {preview.parseWarnings.length > 0 ? (
                <Alert
                  tone="caution"
                  className="mt-4"
                  title={`${preview.parseWarnings.length} parse warning(s)`}
                >
                  <ul className="mt-1 grid gap-0.5">
                    {preview.parseWarnings.slice(0, 5).map((w) => (
                      <li key={w.fileLineNumber}>
                        Line {w.fileLineNumber}: {w.message}
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              <h3 className="mt-5 mb-2 text-[13px] font-semibold text-ink-800">
                Sample rows (up to 10 per outcome)
              </h3>
              <TableScroll>
                <thead>
                  <tr>
                    <Th numeric>Row</Th>
                    <Th>Outcome</Th>
                    <Th>Club</Th>
                    <Th>Contact</Th>
                    <Th>Why</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row) => (
                    <tr key={row.sourceRowNumber}>
                      <Td numeric>{row.sourceRowNumber}</Td>
                      <Td>
                        <Badge tone={IMPORT_OUTCOME_TONES[row.outcome] ?? 'neutral'}>
                          {row.outcomeLabel}
                        </Badge>
                      </Td>
                      <Td>
                        <span className="font-medium text-ink-900">{row.clubName}</span>
                        <span className="block text-[12px] text-ink-500">{row.location}</span>
                      </Td>
                      <Td className="wrap-anywhere">{row.contact}</Td>
                      <Td className="wrap-anywhere max-w-md">
                        {row.reasons.map((r) => (
                          <span key={r} className="block text-ink-700">
                            {r}
                          </span>
                        ))}
                        {row.warnings.map((w) => (
                          <span key={w} className="block text-caution-700">
                            {w}
                          </span>
                        ))}
                        {row.reviewCandidates.map((c) => (
                          <span key={c.label} className="block text-[12px] text-ink-500">
                            Possible match: {c.label} — {c.why}
                          </span>
                        ))}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="3. Confirm"
              description="Applies the import in a single transaction. Re-running the same import changes nothing."
            />
            <CardBody>
              <form action={confirmDispatch} className="flex flex-col gap-3">
                <input type="hidden" name="content" value={previewState.content ?? ''} />
                <input type="hidden" name="fileName" value={previewState.fileName ?? ''} />
                <input
                  type="hidden"
                  name="options"
                  value={JSON.stringify(previewState.options ?? {})}
                />
                <FormFeedback state={confirmState} />
                {applied ? (
                  <p className="text-[13px] text-ink-600">
                    Import complete.{' '}
                    <Link href="/admin/leads" className="text-brand-600 underline">
                      Go to leads and allocate them
                    </Link>
                    .
                  </p>
                ) : (
                  <div>
                    <SubmitButton
                      pendingLabel="Importing…"
                      disabled={preview.missingRequired.length > 0 || !preview.summary.reconciled}
                    >
                      Import {preview.summary.totalDataRows.toLocaleString()} rows
                    </SubmitButton>
                  </div>
                )}
              </form>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
