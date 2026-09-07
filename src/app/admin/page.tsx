import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { loadAdminDashboard } from '@/lib/queries/admin-dashboard';
import { recentActivity } from '@/lib/queries/metrics';
import { formatCents } from '@/lib/domain/compensation';
import { formatRate, progressPercent } from '@/lib/domain/program';
import { METRIC_DEFINITIONS } from '@/lib/domain/metrics';
import { ACTION_LABELS, formatInstant } from '@/lib/labels';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  DefinitionNote,
  EmptyState,
  LinkButton,
  PageHeader,
  ProgressBar,
  StatTile,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { DashboardFilterBar } from '@/components/client/dashboard-filter-bar';

export const metadata = { title: 'Admin overview' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(p: Record<string, string | string[] | undefined>, k: string): string | null {
  const v = Array.isArray(p[k]) ? p[k][0] : p[k];
  return v && v !== '' ? v : null;
}

export default async function AdminOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireAdmin();
  const params = await searchParams;

  const dashboard = await loadAdminDashboard(user.id, {
    cohortId: one(params, 'cohortId'),
    from: one(params, 'from'),
    to: one(params, 'to'),
    territoryId: one(params, 'territoryId'),
  });

  const activity = await asUser(user.id, (tx) => recentActivity(tx, { limit: 12 }));

  const territoryFilter = one(params, 'territory');
  const interns = territoryFilter
    ? dashboard.interns.filter((i) => i.territoryCode === territoryFilter)
    : dashboard.interns;

  const territories = [...new Set(dashboard.interns.map((i) => i.territoryCode).filter(Boolean))];

  return (
    <>
      <PageHeader
        eyebrow={dashboard.cohort?.name ?? 'No cohort'}
        title="Overview"
        description={
          dashboard.cohort ? (
            <>
              Period figures cover <strong>{dashboard.rangeLabel}</strong>. Compensation is
              cumulative across the whole cohort and is never affected by this filter.
            </>
          ) : (
            'Create a cohort to start tracking weekly goals.'
          )
        }
        actions={
          <>
            <LinkButton href="/admin/leads" variant="primary">
              Assign leads
            </LinkButton>
            <LinkButton href="/admin/meetings">Review meetings</LinkButton>
          </>
        }
      />

      {dashboard.cohort === null ? (
        <Alert tone="caution" title="No cohort configured">
          <p className="mb-2">
            Create a cohort with a start date and reporting timezone before adding interns.
          </p>
          <LinkButton href="/admin/targets" variant="primary" size="sm">
            Set up the program
          </LinkButton>
        </Alert>
      ) : (
        <>
          <Card className="mb-5">
            <DashboardFilterBar
              basePath="/admin"
              cohorts={dashboard.cohorts.map((c) => ({ id: c.id, name: c.name }))}
              territories={territories as string[]}
              defaults={{
                cohortId: dashboard.cohort.id,
                from: one(params, 'from') ?? '',
                to: one(params, 'to') ?? '',
                territory: territoryFilter ?? '',
              }}
            />
          </Card>

          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Emails logged (period)"
              value={dashboard.totals.emails}
              definition={METRIC_DEFINITIONS.emails}
            />
            <StatTile
              label="LinkedIn requests (period)"
              value={dashboard.totals.linkedinRequests}
              definition={METRIC_DEFINITIONS.linkedinRequests}
            />
            <StatTile
              label="Awaiting verification"
              value={dashboard.totals.pendingVerification}
              tone={dashboard.totals.pendingVerification > 0 ? 'caution' : 'neutral'}
              sub={
                dashboard.totals.pendingVerification > 0 ? (
                  <Link href="/admin/meetings" className="text-brand-600 underline">
                    Open review queue
                  </Link>
                ) : (
                  'Nothing to review'
                )
              }
            />
            <StatTile
              label="Earned across cohort"
              value={formatCents(dashboard.totals.earnedCents)}
              tone="positive"
              sub={`${formatCents(dashboard.totals.paidCents)} recorded as paid · lifetime, not period`}
            />
          </div>

          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <StatTile label="Clubs in workspace" value={dashboard.totals.totalOrganizations} />
            <StatTile label="Assigned" value={dashboard.totals.assignedOrganizations} />
            <StatTile
              label="Unassigned"
              value={dashboard.totals.unassignedOrganizations}
              tone={dashboard.totals.unassignedOrganizations > 0 ? 'caution' : 'neutral'}
              sub={
                <Link
                  href="/admin/leads?assignment=unassigned"
                  className="text-brand-600 underline"
                >
                  Allocate them
                </Link>
              }
            />
          </div>

          <Card className="mb-5">
            <CardHeader
              title="Interns"
              description={
                dashboard.week
                  ? `Weekly progress for ${dashboard.week.label}.`
                  : 'Outside the program window — no weekly targets apply.'
              }
              actions={
                <LinkButton href="/api/exports/interns" size="sm">
                  Export CSV
                </LinkButton>
              }
            />
            {interns.length === 0 ? (
              <EmptyState
                title="No interns in this cohort yet"
                description="Invite interns and assign them to this cohort and a territory."
                action={
                  <LinkButton href="/admin/interns" variant="primary">
                    Invite an intern
                  </LinkButton>
                }
              />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Intern</Th>
                    <Th>Territory</Th>
                    <Th>Emails / target</Th>
                    <Th>Requests / target</Th>
                    <Th numeric>Clubs</Th>
                    <Th numeric>Overdue</Th>
                    <Th numeric>Verified held</Th>
                    <Th numeric>Earned</Th>
                    <Th>Reply rate</Th>
                    <Th>Last activity</Th>
                  </tr>
                </thead>
                <tbody>
                  {interns.map((i) => (
                    <tr key={i.userId} className="hover:bg-ink-50">
                      <Td>
                        <Link
                          href={`/admin/interns/${i.userId}`}
                          className="font-medium text-ink-900 hover:text-brand-600"
                        >
                          {i.name}
                        </Link>
                        {i.status !== 'active' ? (
                          <Badge tone="caution" className="ml-2">
                            {i.status}
                          </Badge>
                        ) : null}
                      </Td>
                      <Td>{i.territoryCode ?? <span className="text-ink-400">—</span>}</Td>
                      <Td>
                        <GoalCell
                          achieved={i.totals.emails}
                          target={i.target?.emailTarget ?? null}
                        />
                      </Td>
                      <Td>
                        <GoalCell
                          achieved={i.totals.linkedinRequests}
                          target={i.target?.linkedinTarget ?? null}
                        />
                      </Td>
                      <Td numeric>
                        {i.assignedOrganizations}
                        {i.untouchedOrganizations > 0 ? (
                          <span className="block text-[11px] text-caution-700">
                            {i.untouchedOrganizations} untouched
                          </span>
                        ) : null}
                      </Td>
                      <Td numeric>
                        {i.overdueFollowUps > 0 ? (
                          <span className="font-medium text-caution-700">{i.overdueFollowUps}</span>
                        ) : (
                          0
                        )}
                      </Td>
                      <Td numeric>
                        {i.verifiedHeld}
                        {i.meetingsPending > 0 ? (
                          <span className="block text-[11px] text-caution-700">
                            +{i.meetingsPending} pending
                          </span>
                        ) : null}
                      </Td>
                      <Td numeric>
                        {formatCents(i.compensation.earnedCents)}
                        {i.compensation.balanceCents !== 0 ? (
                          <span className="block text-[11px] text-ink-500">
                            {i.compensation.overpaidCents > 0
                              ? `${formatCents(i.compensation.overpaidCents)} overpaid`
                              : `${formatCents(i.compensation.balanceCents)} unpaid`}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {formatRate(i.replyRate)}
                        <span className="block text-[11px] text-ink-400">
                          of {i.replyRate.denominator} contacted
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap text-ink-600">
                        {i.lastActivityAt
                          ? formatInstant(i.lastActivityAt, dashboard.cohort!.reportingTimezone, {
                              timeStyle: undefined,
                            })
                          : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
            <CardBody className="border-t border-ink-100">
              <DefinitionNote>
                <strong>Reply rate</strong> = {METRIC_DEFINITIONS.replyRate} An em dash means no
                club was contacted in this period, so there is no denominator to divide by.{' '}
                <strong>Verified held</strong> = {METRIC_DEFINITIONS.verifiedHeld}
              </DefinitionNote>
            </CardBody>
          </Card>
        </>
      )}

      <Card>
        <CardHeader title="Recent activity across the team" description="Newest first." />
        {activity.length === 0 ? (
          <EmptyState title="No activity logged yet" />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Intern</Th>
                <Th>Club</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {activity.map((a) => (
                <tr key={a.id} className={a.voidedAt ? 'opacity-60' : undefined}>
                  <Td className="whitespace-nowrap text-ink-600">
                    {formatInstant(a.occurredAt, dashboard.cohort?.reportingTimezone ?? 'UTC')}
                  </Td>
                  <Td>{a.actorName}</Td>
                  <Td>{a.organizationName}</Td>
                  <Td>
                    {ACTION_LABELS[a.actionType] ?? a.actionType}
                    {a.voidedAt ? (
                      <Badge tone="caution" className="ml-2">
                        Voided
                      </Badge>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Card>
    </>
  );
}

function GoalCell({ achieved, target }: { achieved: number; target: number | null }) {
  if (target === null) {
    return (
      <span className="tabular">
        {achieved} <span className="text-ink-400">/ no target</span>
      </span>
    );
  }
  return (
    <div className="min-w-[7rem]">
      <span className="tabular">
        {achieved} <span className="text-ink-400">/ {target}</span>
      </span>
      <div className="mt-1">
        <ProgressBar
          value={achieved}
          max={target}
          label={`${achieved} of ${target}`}
          tone={progressPercent(achieved, target) >= 100 ? 'positive' : 'brand'}
        />
      </div>
    </div>
  );
}
