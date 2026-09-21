import { NextResponse } from 'next/server';
import { asUser } from '@/lib/db';
import { currentUser, isAdminRole } from '@/lib/auth/session';
import { listCohorts, resolveAllWeeklyTargets } from '@/lib/queries/program';
import { outreachTotals } from '@/lib/queries/metrics';
import { listPeople } from '@/lib/services/admin';
import { programWeek } from '@/lib/domain/program';
import { DEFAULT_METRIC_POLICY } from '@/lib/domain/metrics';
import { csvFilename, toCsv } from '@/lib/domain/csv-export';

export const dynamic = 'force-dynamic';

/** One intern's week-by-week trend, using the dashboard's own definitions. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse('Sign in required', { status: 401 });
  if (!isAdminRole(user.role)) return new NextResponse('Forbidden', { status: 403 });

  const { id } = await params;
  const now = new Date();

  const data = await asUser(user.id, async (tx) => {
    const people = await listPeople(tx);
    const person = people.find((p) => p.id === id);
    if (person === undefined) return null;
    const cohorts = await listCohorts(tx);
    const cohort = person.cohortId ? cohorts.find((c) => c.id === person.cohortId) : undefined;
    if (cohort === undefined) return { person, rows: [] };

    const targets = await resolveAllWeeklyTargets(tx, cohort, id, now);
    const rows = [];
    for (let week = 1; week <= cohort.weeksCount; week += 1) {
      const w = programWeek(cohort, week);
      const totals = await outreachTotals(tx, {
        actorUserId: id,
        range: w.range,
        policy: DEFAULT_METRIC_POLICY,
      });
      rows.push({ week: w, totals, target: targets[week - 1] });
    }
    return { person, rows };
  });

  if (data === null) return new NextResponse('Not found', { status: 404 });

  const csv = toCsv(
    [
      'week',
      'start_date',
      'end_date',
      'emails',
      'email_target',
      'linkedin_connections',
      'first_touches',
      'follow_ups',
      'unique_organizations',
      'phone_calls',
      'research_notes',
      'target_source',
      'target_frozen',
    ],
    data.rows.map((r) => [
      r.week.weekNumber,
      `${r.week.startDate.year}-${String(r.week.startDate.month).padStart(2, '0')}-${String(r.week.startDate.day).padStart(2, '0')}`,
      `${r.week.endDate.year}-${String(r.week.endDate.month).padStart(2, '0')}-${String(r.week.endDate.day).padStart(2, '0')}`,
      r.totals.emails,
      r.target?.emailTarget ?? '',
      r.totals.linkedinConnections,
      r.totals.firstTouches,
      r.totals.followUps,
      r.totals.uniqueOrganizations,
      r.totals.phoneCalls,
      r.totals.researchNotes,
      r.target?.source ?? '',
      r.target?.frozen ? 'yes' : 'no',
    ]),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(`waresport-${data.person.email.split('@')[0]}`)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
