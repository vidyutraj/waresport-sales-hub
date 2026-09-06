import { NextResponse } from 'next/server';
import { asUser } from '@/lib/db';
import { currentUser, isAdminRole } from '@/lib/auth/session';
import { rejectedRowsForBatch } from '@/lib/services/import';
import { csvFilename, toCsv } from '@/lib/domain/csv-export';

export const dynamic = 'force-dynamic';

/**
 * Download the rows an import did not apply, with their reasons, so an admin
 * can fix them and re-upload. Cells are formula-injection escaped.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse('Sign in required', { status: 401 });
  if (!isAdminRole(user.role)) return new NextResponse('Forbidden', { status: 403 });

  const { batchId } = await params;
  const rows = await asUser(user.id, (tx) => rejectedRowsForBatch(tx, batchId));

  // Preserve the original columns so the file can be corrected and re-uploaded.
  const originalColumns = [...new Set(rows.flatMap((r) => Object.keys(r.raw)))];

  const csv = toCsv(
    ['source_row_number', 'outcome', 'reasons', 'warnings', ...originalColumns],
    rows.map((r) => [
      r.sourceRowNumber,
      r.outcome,
      r.reasons.join(' | '),
      r.warnings.join(' | '),
      ...originalColumns.map((c) => r.raw[c] ?? ''),
    ]),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('waresport-import-rejects')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
