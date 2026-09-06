import './_bootstrap-env';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { asSystem, asUser, closeConnections } from '@/lib/db';
import { env } from '@/lib/env';
import { confirmImport, previewImport } from '@/lib/services/import';
import { OUTCOME_LABELS } from '@/lib/domain/csv-import';

/**
 * Command-line lead import. Same pipeline as the admin wizard, and it runs
 * through the RLS-enforced connection as a real admin/owner account.
 *
 *   npm run import:csv -- --file ./private/leads.csv --as owner@waresport.local
 *   npm run import:csv -- --file ./private/leads.csv --as owner@... --confirm
 *
 * Without --confirm it only previews. Real prospect data belongs in ./private,
 * which is git-ignored; nothing here uploads anything anywhere.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      as: { type: 'string' },
      confirm: { type: 'boolean', default: false },
      sport: { type: 'string' },
      source: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values.file || !values.as) {
    console.error(
      'Usage: npm run import:csv -- --file <path.csv> --as <admin email> [--confirm] [--sport Baseball] [--source "..."]',
    );
    process.exit(1);
  }

  const path = resolve(process.cwd(), values.file);
  const content = readFileSync(path, 'utf8');

  const actor = await asSystem(async (tx) => {
    const [row] = await tx<{ id: string; role: 'owner' | 'admin' | 'intern' }[]>`
      SELECT id, role FROM users WHERE email = ${values.as!.toLowerCase()} AND status = 'active'`;
    return row ?? null;
  });

  if (actor === null) throw new Error(`No active account found for ${values.as}.`);
  if (actor.role === 'intern') throw new Error('Imports are an admin-only operation.');

  const options = {
    defaultSport: values.sport ?? null,
    defaultSource: values.source ?? null,
    duplicateStrategy: 'skip' as const,
    applyTerritoryMap: true,
  };

  const e = env();
  const outcome = await asUser(actor.id, async (tx) => {
    const preview = await previewImport(tx, {
      fileName: basename(path),
      content,
      options,
      maxBytes: e.IMPORT_MAX_FILE_BYTES,
      maxRows: e.IMPORT_MAX_ROWS,
    });

    if (!values.confirm) return { preview, result: null };

    const result = await confirmImport(tx, {
      actorUserId: actor.id,
      actorRole: actor.role as 'owner' | 'admin',
      preview,
      options,
    });
    return { preview, result };
  });

  const { preview, result } = outcome;

  if (values.json) {
    console.info(
      JSON.stringify(
        {
          totalDataRows: preview.summary.totalDataRows,
          byOutcome: preview.summary.byOutcome,
          reconciled: preview.summary.reconciled,
          blankLinesSkipped: preview.summary.blankLinesSkipped,
          parseWarnings: preview.summary.parseWarnings,
          withWarnings: preview.summary.withWarnings,
          unmatchedStates: preview.unmatchedStates,
          applied: result,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.info(`\nFile:            ${preview.fileName}`);
  console.info(`Parsed rows:     ${preview.summary.totalDataRows.toLocaleString()}`);
  console.info(`Blank lines:     ${preview.summary.blankLinesSkipped}`);
  console.info(`Parse warnings:  ${preview.summary.parseWarnings}`);
  console.info(
    `Mapped columns:  ${Object.entries(preview.mapping)
      .map(([k, v]) => `${k}<-${v}`)
      .join(', ')}`,
  );
  if (preview.unmappedHeaders.length > 0) {
    console.info(`Unmapped:        ${preview.unmappedHeaders.join(', ')}`);
  }
  console.info('\nOutcomes:');
  let total = 0;
  for (const [outcomeKey, count] of Object.entries(preview.summary.byOutcome)) {
    total += count;
    console.info(
      `  ${OUTCOME_LABELS[outcomeKey as keyof typeof OUTCOME_LABELS].padEnd(34)} ${String(count).padStart(6)}`,
    );
  }
  console.info(`  ${'TOTAL'.padEnd(34)} ${String(total).padStart(6)}`);
  console.info(
    `  Reconciled with parsed rows: ${preview.summary.reconciled ? 'yes' : 'NO — investigate'}`,
  );
  console.info(`  Rows carrying warnings:      ${preview.summary.withWarnings}`);
  if (preview.unmatchedStates.length > 0) {
    console.info(`\nStates with no territory mapping: ${preview.unmatchedStates.join(', ')}`);
  }

  if (result) {
    console.info(
      `\nApplied (batch ${result.batchId}${result.alreadyApplied ? ', already applied — no changes' : ''}):`,
    );
    console.info(`  organizations created: ${result.organizationsCreated}`);
    console.info(`  contacts created:      ${result.contactsCreated}`);
    console.info(`  territories assigned:  ${result.territoriesAssigned}`);
  } else {
    console.info('\nPreview only. Re-run with --confirm to apply.');
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeConnections());
