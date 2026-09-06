import { NextResponse } from 'next/server';
import { asUser } from '@/lib/db';
import { currentUser, isAdminRole } from '@/lib/auth/session';
import { listPayouts } from '@/lib/services/meetings';
import { csvFilename, toCsv } from '@/lib/domain/csv-export';

export const dynamic = 'force-dynamic';

/** Payout ledger export. These are records of manual payments, not transfers. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new NextResponse('Sign in required', { status: 401 });
  if (!isAdminRole(user.role)) return new NextResponse('Forbidden', { status: 403 });

  const cohortId = new URL(request.url).searchParams.get('cohortId');
  const payouts = await asUser(user.id, (tx) => listPayouts(tx, { cohortId }));

  const csv = toCsv(
    [
      'intern',
      'milestone',
      'amount_usd',
      'currency',
      'paid_on',
      'reference',
      'recorded_by',
      'recorded_at',
      'voided_at',
      'void_reason',
    ],
    payouts.map((p) => [
      p.userName,
      p.milestoneIndex,
      (p.amountCents / 100).toFixed(2),
      'USD',
      p.paidOn,
      p.reference ?? '',
      p.recordedByName,
      p.createdAt.toISOString(),
      p.voidedAt?.toISOString() ?? '',
      p.voidReason ?? '',
    ]),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('waresport-payouts')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
