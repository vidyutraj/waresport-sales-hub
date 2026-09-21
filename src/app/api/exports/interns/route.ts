import { NextResponse } from 'next/server';
import { currentUser, isAdminRole } from '@/lib/auth/session';
import { loadAdminDashboard } from '@/lib/queries/admin-dashboard';
import { csvFilename, toCsv } from '@/lib/domain/csv-export';
import { formatRate } from '@/lib/domain/program';

export const dynamic = 'force-dynamic';

/**
 * Intern roster export.
 *
 * Reads the same `loadAdminDashboard` aggregation the screen uses, so the
 * exported numbers are the dashboard's numbers by construction rather than by
 * a second, drifting query.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new NextResponse('Sign in required', { status: 401 });
  if (!isAdminRole(user.role)) return new NextResponse('Forbidden', { status: 403 });

  const params = new URL(request.url).searchParams;
  const dashboard = await loadAdminDashboard(user.id, {
    cohortId: params.get('cohortId'),
    from: params.get('from'),
    to: params.get('to'),
  });

  const csv = toCsv(
    [
      'intern',
      'email',
      'status',
      'territory',
      'joined_on',
      'period',
      'emails_period',
      'email_target',
      'linkedin_connections_period',
      'first_touches_period',
      'follow_ups_period',
      'unique_orgs_period',
      'assigned_clubs',
      'untouched_clubs',
      'overdue_follow_ups',
      'reply_rate_percent',
      'reply_rate_denominator',
      'meetings_booked_lifetime',
      'meetings_pending',
      'verified_held_lifetime',
      'earned_usd',
      'paid_usd',
      'balance_usd',
      'overpaid_usd',
      'training_completed',
      'training_total',
      'last_activity_at',
    ],
    dashboard.interns.map((i) => [
      i.name,
      i.email,
      i.status,
      i.territoryCode ?? '',
      i.joinedOn ?? '',
      dashboard.rangeLabel,
      i.totals.emails,
      i.target?.emailTarget ?? '',
      i.totals.linkedinConnections,
      i.totals.firstTouches,
      i.totals.followUps,
      i.totals.uniqueOrganizations,
      i.assignedOrganizations,
      i.untouchedOrganizations,
      i.overdueFollowUps,
      // An em dash on screen; an empty cell in the file, never a fake 0.
      i.replyRate.percent === null ? '' : formatRate(i.replyRate).replace('%', ''),
      i.replyRate.denominator,
      i.meetingsBooked,
      i.meetingsPending,
      i.verifiedHeld,
      (i.compensation.earnedCents / 100).toFixed(2),
      (i.compensation.paidCents / 100).toFixed(2),
      (i.compensation.balanceCents / 100).toFixed(2),
      (i.compensation.overpaidCents / 100).toFixed(2),
      i.trainingCompleted,
      i.trainingTotal,
      i.lastActivityAt?.toISOString() ?? '',
    ]),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename('waresport-interns')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
