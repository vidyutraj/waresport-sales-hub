import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { asSystem, asUser } from '@/lib/db';
import { createUser, ensureTerritory, expectRejection, tag } from './factories';
import { confirmImport, previewImport, rejectedRowsForBatch } from '@/lib/services/import';
import { toCsv } from '@/lib/domain/csv-export';

/**
 * Import pipeline tests.
 *
 * Two halves:
 *  1. Synthetic fixtures for the hard cases (bad URLs, formula injection,
 *     multiline notes, uncertain matches). These are committed.
 *  2. The real supplied lead file, reconciled row-for-row — but only when it
 *     has been placed in ./private, which is git-ignored. Real prospect data is
 *     never committed, and the test reports itself as skipped when absent.
 */

const SUPPLIED_FILE = resolve(process.cwd(), 'private/baseball-club-directors-combined.csv');
const HEADERS = 'club_name,role,contact_name,phone,email,city,state,source_url,notes';

let admin: string;

beforeAll(async () => {
  admin = await createUser({ role: 'admin' });
  await ensureTerritory('EAST', 'East');
  await ensureTerritory('WEST', 'West');
});

/** Each import test runs in its own empty-ish namespace via unique club names. */
async function runImport(csv: string, options: Record<string, unknown> = {}) {
  return asUser(admin, async (tx) => {
    const preview = await previewImport(tx, {
      fileName: `test-${tag()}.csv`,
      content: csv,
      options,
      maxBytes: 10_000_000,
      maxRows: 50_000,
    });
    const result = await confirmImport(tx, {
      actorUserId: admin,
      actorRole: 'admin',
      preview,
      options,
    });
    return { preview, result };
  });
}

describe('import guardrails', () => {
  it('rejects a file over the configured size limit', async () => {
    const error = await expectRejection(
      asUser(admin, (tx) =>
        previewImport(tx, {
          fileName: 'big.csv',
          content: `${HEADERS}\n${'x'.repeat(5000)}`,
          maxBytes: 100,
          maxRows: 100,
        }),
      ),
    );
    expect(String(error)).toMatch(/the limit is/i);
  });

  it('rejects a file over the configured row limit', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => `Club ${i},,,,,,NC,,`).join('\n');
    const error = await expectRejection(
      asUser(admin, (tx) =>
        previewImport(tx, {
          fileName: 'many.csv',
          content: `${HEADERS}\n${rows}`,
          maxBytes: 10_000_000,
          maxRows: 5,
        }),
      ),
    );
    expect(String(error)).toMatch(/rows; the limit is/i);
  });

  it('rejects a file that is not CSV at all', async () => {
    const error = await expectRejection(
      asUser(admin, (tx) =>
        previewImport(tx, {
          fileName: 'empty.csv',
          content: '',
          maxBytes: 10_000_000,
          maxRows: 100,
        }),
      ),
    );
    expect(String(error)).toMatch(/empty/i);
  });
});

describe('synthetic edge cases', () => {
  it('handles quoted commas, multiline notes, CRLF and a BOM together', async () => {
    const name = `Edge Club ${tag()}`;
    const csv =
      `﻿${HEADERS}\r\n` +
      `"${name}",President,"O""Brien, Pat",919-732-4454,pat-${tag()}@example.test,Cary,NC,https://example.test/x,"line one\nline two, with comma"\r\n`;

    const { preview, result } = await runImport(csv);
    expect(preview.summary.totalDataRows).toBe(1);
    expect(preview.summary.byOutcome.organization_created).toBe(1);
    expect(result.organizationsCreated).toBe(1);

    const [org] = await asUser(
      admin,
      (tx) => tx<{ notes: string | null }[]>`SELECT notes FROM organizations WHERE name = ${name}`,
    );
    expect(org?.notes).toBe('line one\nline two, with comma');
  });

  it('keeps a record with no contact details and flags it', async () => {
    const name = `No Contact Club ${tag()}`;
    const { preview } = await runImport(`${HEADERS}\n${name},,,,,Cary,NC,,Research needed\n`);
    expect(preview.summary.byOutcome.organization_created).toBe(1);
    expect(preview.rows[0]!.warnings.join(' ')).toMatch(/still available for research/i);
  });

  it('preserves a phone exactly as written, including a leading zero', async () => {
    const name = `Zero Phone ${tag()}`;
    await runImport(
      `${HEADERS}\n${name},President,Ann,"0919-732-4454 ext 12",a-${tag()}@example.test,Cary,NC,,n\n`,
    );
    const [contact] = await asUser(
      admin,
      (tx) =>
        tx<{ phone_raw: string; phone_valid: boolean; phone_extension: string | null }[]>`
        SELECT c.phone_raw, c.phone_valid, c.phone_extension
        FROM contacts c JOIN organizations o ON o.id = c.organization_id
        WHERE o.name = ${name}`,
    );
    expect(contact?.phone_raw).toBe('0919-732-4454 ext 12');
    expect(contact?.phone_extension).toBe('12');
  });

  it('stores an unsafe source URL as text and never as a live link', async () => {
    const name = `Unsafe URL Club ${tag()}`;
    const { preview } = await runImport(
      `${HEADERS}\n${name},President,Ann,919-732-4454,a-${tag()}@example.test,Cary,NC,javascript:alert(1),n\n`,
    );
    expect(preview.rows[0]!.organization?.sourceUrlSafe).toBe(false);
    expect(preview.summary.byOutcome.organization_created).toBe(1);

    const [org] = await asUser(
      admin,
      (tx) =>
        tx<
          { source_url: string | null }[]
        >`SELECT source_url FROM organizations WHERE name = ${name}`,
    );
    expect(org?.source_url).toBe('javascript:alert(1)');
  });

  it('rejects a row with no club name and accounts for it', async () => {
    const { preview } = await runImport(
      `${HEADERS}\n,President,Ann,919-732-4454,a-${tag()}@example.test,Cary,NC,,n\n`,
    );
    expect(preview.summary.byOutcome.invalid).toBe(1);
    expect(preview.summary.reconciled).toBe(true);
    expect(preview.rows[0]!.reasons[0]).toMatch(/club name is required/i);
  });

  it('flags an uncertain organization match for review instead of merging', async () => {
    const base = `Ambiguous FC ${tag()}`;
    const { preview } = await runImport(
      `${HEADERS}\n` +
        `${base},President,Ann,919-000-0001,a-${tag()}@example.test,Cary,NC,,n\n` +
        `${base},Director,Bob,919-000-0002,b-${tag()}@example.test,,NC,,n\n`,
    );
    expect(preview.summary.byOutcome.organization_created).toBe(1);
    expect(preview.summary.byOutcome.needs_review).toBe(1);
    expect(preview.rows[1]!.reviewCandidates.length).toBeGreaterThan(0);
  });

  it('never merges two clubs that only share a consumer mail domain', async () => {
    const a = `Gmail Club A ${tag()}`;
    const b = `Gmail Club B ${tag()}`;
    const { preview } = await runImport(
      `${HEADERS}\n` +
        `${a},President,Ann,919-000-0001,${tag()}@gmail.com,Cary,NC,,n\n` +
        `${b},President,Bob,919-000-0002,${tag()}@gmail.com,Apex,NC,,n\n`,
    );
    expect(preview.summary.byOutcome.organization_created).toBe(2);
    expect(preview.summary.byOutcome.needs_review).toBe(0);
  });

  it('maps states to territories and flags unmapped ones', async () => {
    await asSystem(async (tx) => {
      const [east] = await tx<{ id: string }[]>`SELECT id FROM territories WHERE code = 'EAST'`;
      await tx`
        INSERT INTO territory_states (state_code, territory_id) VALUES ('NC', ${east!.id})
        ON CONFLICT (state_code) DO UPDATE SET territory_id = EXCLUDED.territory_id`;
      await tx`DELETE FROM territory_states WHERE state_code = 'WY'`;
    });

    const mapped = `Mapped Club ${tag()}`;
    const unmapped = `Unmapped Club ${tag()}`;
    const { preview, result } = await runImport(
      `${HEADERS}\n` +
        `${mapped},President,Ann,919-000-0001,a-${tag()}@example.test,Cary,NC,,n\n` +
        `${unmapped},President,Bob,307-000-0002,b-${tag()}@example.test,Casper,WY,,n\n`,
      { applyTerritoryMap: true },
    );

    expect(preview.unmatchedStates).toContain('WY');
    expect(result.territoriesAssigned).toBe(1);

    const rows = await asUser(
      admin,
      (tx) =>
        tx<{ name: string; territory_id: string | null }[]>`
        SELECT name, territory_id FROM organizations WHERE name IN (${mapped}, ${unmapped})`,
    );
    expect(rows.find((r) => r.name === mapped)?.territory_id).not.toBeNull();
    expect(rows.find((r) => r.name === unmapped)?.territory_id).toBeNull();
  });

  it('accounts for every parsed row in mutually exclusive buckets', async () => {
    const base = `Recon ${tag()}`;
    const line = `${base} One,President,Ann,919-000-0001,ann-${tag()}@example.test,Cary,NC,,n`;
    const { preview } = await runImport(
      `${HEADERS}\n${line}\n${line}\n,President,X,919-000-0003,x-${tag()}@example.test,Cary,NC,,n\n`,
    );
    const counted = Object.values(preview.summary.byOutcome).reduce((a, b) => a + b, 0);
    expect(counted).toBe(preview.summary.totalDataRows);
    expect(preview.summary.reconciled).toBe(true);
  });
});

describe('idempotency', () => {
  it('creates nothing on a second upload of the same file', async () => {
    const name = `Idempotent Club ${tag()}`;
    const csv = `${HEADERS}\n${name},President,Ann,919-000-0001,idem-${tag()}@example.test,Cary,NC,,n\n`;

    const first = await runImport(csv, { note: 'first' });
    expect(first.result.organizationsCreated).toBe(1);

    // Same content, different batch (a different option set): the per-row
    // source keys still make it a no-op.
    const second = await runImport(csv, { note: 'second' });
    expect(second.preview.summary.byOutcome.skipped_duplicate).toBe(1);
    expect(second.result.organizationsCreated).toBe(0);
    expect(second.result.contactsCreated).toBe(0);

    const [count] = await asUser(
      admin,
      (tx) =>
        tx<{ c: string }[]>`SELECT count(*)::text AS c FROM organizations WHERE name = ${name}`,
    );
    expect(Number(count!.c)).toBe(1);
  });

  it('returns the original result when the same confirmed import is retried', async () => {
    const name = `Retry Club ${tag()}`;
    const csv = `${HEADERS}\n${name},President,Ann,919-000-0001,retry-${tag()}@example.test,Cary,NC,,n\n`;
    const options = { note: `retry-${tag()}` };

    const first = await runImport(csv, options);
    expect(first.result.alreadyApplied).toBe(false);

    const second = await runImport(csv, options);
    expect(second.result.alreadyApplied).toBe(true);
    expect(second.result.batchId).toBe(first.result.batchId);

    const [batches] = await asUser(
      admin,
      (tx) =>
        tx<{ c: string }[]>`
        SELECT count(*)::text AS c FROM import_batches
        WHERE idempotency_key = ${first.preview.idempotencyKey}`,
    );
    expect(Number(batches!.c)).toBe(1);
  });

  it('preserves assignments and suppression across a re-import', async () => {
    const intern = await createUser({ role: 'intern' });
    const name = `Preserve Club ${tag()}`;
    const email = `preserve-${tag()}@example.test`;
    const csv = `${HEADERS}\n${name},President,Ann,919-000-0001,${email},Cary,NC,,n\n`;

    await runImport(csv, { note: `preserve-a-${tag()}` });
    const [org] = await asUser(
      admin,
      (tx) => tx<{ id: string }[]>`SELECT id FROM organizations WHERE name = ${name}`,
    );
    const [contact] = await asUser(
      admin,
      (tx) => tx<{ id: string }[]>`SELECT id FROM contacts WHERE organization_id = ${org!.id}`,
    );

    await asUser(
      admin,
      (tx) =>
        tx`INSERT INTO organization_assignments (organization_id, intern_user_id, assigned_by)
         VALUES (${org!.id}, ${intern}, ${admin})`,
    );
    await asUser(
      admin,
      (tx) =>
        tx`INSERT INTO suppressions (scope, organization_id, contact_id, channel, reason, created_by)
         VALUES ('contact', ${org!.id}, ${contact!.id}, 'email', 'Bounced', ${admin})`,
    );
    await asUser(
      admin,
      (tx) => tx`UPDATE organizations SET status = 'contacted' WHERE id = ${org!.id}`,
    );

    await runImport(csv, { note: `preserve-b-${tag()}` });

    const after = await asUser(admin, async (tx) => ({
      assignments: await tx<{ id: string }[]>`
        SELECT id FROM organization_assignments
        WHERE organization_id = ${org!.id} AND unassigned_at IS NULL`,
      suppressions: await tx<{ id: string }[]>`
        SELECT id FROM suppressions WHERE contact_id = ${contact!.id} AND lifted_at IS NULL`,
      status: (
        await tx<{ status: string }[]>`SELECT status::text FROM organizations WHERE id = ${org!.id}`
      )[0]?.status,
      organizations: await tx<{ id: string }[]>`SELECT id FROM organizations WHERE name = ${name}`,
    }));

    expect(after.assignments).toHaveLength(1);
    expect(after.suppressions).toHaveLength(1);
    expect(after.status).toBe('contacted');
    expect(after.organizations).toHaveLength(1);
  });
});

describe('rejected-row export', () => {
  it('lists invalid and needs-review rows with their reasons, formula-safe', async () => {
    const base = `Reject ${tag()}`;
    const { result } = await runImport(
      `${HEADERS}\n` +
        `${base},President,Ann,919-000-0001,a-${tag()}@example.test,Cary,NC,,n\n` +
        `${base},Director,Bob,919-000-0002,b-${tag()}@example.test,,NC,,"=cmd|' /C calc'!A0"\n` +
        `,President,X,919-000-0003,x-${tag()}@example.test,Cary,NC,,n\n`,
    );

    const rejected = await asUser(admin, (tx) => rejectedRowsForBatch(tx, result.batchId));
    expect(rejected.length).toBe(2);
    expect(rejected.map((r) => r.outcome).sort()).toEqual(['invalid', 'needs_review']);

    const csv = toCsv(
      ['row', 'outcome', 'reasons', 'club_name', 'notes'],
      rejected.map((r) => [
        r.sourceRowNumber,
        r.outcome,
        r.reasons.join('; '),
        r.raw.club_name,
        r.raw.notes,
      ]),
    );
    // The dangerous cell is neutralised in the export.
    expect(csv).toContain("'=cmd|");
    expect(csv).not.toMatch(/(^|,)=cmd/m);
  });
});

/**
 * The supplied 1,231-row file. Only runs against a private local copy; the file
 * itself is never committed and is never uploaded anywhere.
 */
describe.skipIf(!existsSync(SUPPLIED_FILE))('the supplied lead file', () => {
  it('reconciles all 1,231 rows into mutually exclusive outcomes', async () => {
    const content = readFileSync(SUPPLIED_FILE, 'utf8');
    const options = { defaultSport: 'Baseball', defaultSource: `acceptance-${tag()}` };

    const { preview, result } = await asUser(admin, async (tx) => {
      const p = await previewImport(tx, {
        fileName: 'baseball-club-directors-combined.csv',
        content,
        options,
        maxBytes: 10_000_000,
        maxRows: 50_000,
      });
      const r = await confirmImport(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        preview: p,
        options,
      });
      return { preview: p, result: r };
    });

    // The supplied file has exactly 1,231 data rows and 9 columns.
    expect(preview.summary.totalDataRows).toBe(1231);
    expect(preview.headers).toEqual([
      'club_name',
      'role',
      'contact_name',
      'phone',
      'email',
      'city',
      'state',
      'source_url',
      'notes',
    ]);
    expect(preview.missingRequired).toEqual([]);

    // Every parsed row lands in exactly one bucket.
    const counted = Object.values(preview.summary.byOutcome).reduce((a, b) => a + b, 0);
    expect(counted).toBe(1231);
    expect(preview.summary.reconciled).toBe(true);

    // Every row is accounted for in the batch's own row ledger too.
    const [rowCount] = await asUser(
      admin,
      (tx) =>
        tx<{ c: string }[]>`
        SELECT count(*)::text AS c FROM import_rows WHERE batch_id = ${result.batchId}`,
    );
    expect(Number(rowCount!.c)).toBe(1231);

    // The file's shape: 984 rows carry an email, 247 do not.
    const withEmail = preview.rows.filter(
      (r) => r.contact?.email !== null && r.contact?.email !== undefined,
    );
    expect(withEmail.length).toBe(984);

    // Multiple directors at one club become one organization with several
    // contacts, not several conflicting organizations.
    expect(result.contactsCreated).toBeGreaterThan(result.organizationsCreated);
  }, 120_000);

  it('creates nothing when the same file is imported again', async () => {
    const content = readFileSync(SUPPLIED_FILE, 'utf8');
    const options = { defaultSport: 'Baseball', defaultSource: `acceptance-again-${tag()}` };

    const { preview, result } = await asUser(admin, async (tx) => {
      const p = await previewImport(tx, {
        fileName: 'baseball-club-directors-combined.csv',
        content,
        options,
        maxBytes: 10_000_000,
        maxRows: 50_000,
      });
      const r = await confirmImport(tx, {
        actorUserId: admin,
        actorRole: 'admin',
        preview: p,
        options,
      });
      return { preview: p, result: r };
    });

    expect(preview.summary.byOutcome.organization_created).toBe(0);
    expect(preview.summary.byOutcome.contact_added).toBe(0);
    expect(result.organizationsCreated).toBe(0);
    expect(result.contactsCreated).toBe(0);
  }, 120_000);
});
