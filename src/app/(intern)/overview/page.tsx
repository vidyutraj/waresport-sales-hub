import Link from 'next/link';
import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { loadInternDashboard } from '@/lib/queries/intern-context';
import { recentActivity } from '@/lib/queries/metrics';
import { listProspects } from '@/lib/services/prospects';
import { formatCents, milestoneHeadline } from '@/lib/domain/compensation';
import { formatRate, PROGRAM_DEFAULT_TARGETS } from '@/lib/domain/program';
import { METRIC_DEFINITIONS } from '@/lib/domain/metrics';
import { formatDateRangeHuman } from '@/lib/domain/time';
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
import { ACTION_LABELS, OUTCOME_LABELS } from '@/lib/labels';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const user = await requireIntern();
  const dashboard = await loadInternDashboard(user.id);
  const { context, weekTotals, pipeline, compensation } = dashboard;

  const [activity, prospects, projects] = await asUser(user.id, async (tx) => [
    await recentActivity(tx, { actorUserId: user.id, limit: 8 }),
    await listProspects(tx, { createdBy: user.id, limit: 5 }),
    await tx<{ id: string; title: string; due_on: string | null; status: string }[]>`
      SELECT p.id, p.title, p.due_on::text AS due_on, pa.status::text
      FROM project_assignments pa
      JOIN projects p ON p.id = pa.project_id
      WHERE pa.user_id = ${user.id} AND p.status = 'active'
      ORDER BY p.due_on NULLS LAST
      LIMIT 5`,
  ]);

  if (context.membership === null) {
    return (
      <>
        <PageHeader title={`Welcome, ${user.preferredName ?? user.fullName ?? 'there'}`} />
        <Alert tone="caution" title="You are not in a cohort yet">
          An admin still needs to add you to a cohort and territory. Until then there are no weekly
          goals and no assigned clubs. Nothing you do here is lost — check back shortly.
        </Alert>
      </>
    );
  }

  const outsideProgram = context.week === null;

  return (
    <>
      <PageHeader
        eyebrow={`${context.membership.territoryName ?? context.membership.territoryCode ?? 'No territory'} group`}
        title={`Welcome, ${user.preferredName ?? user.fullName ?? 'there'}`}
        description={
          context.week ? (
            <>
              <strong>{context.week.label}</strong> — measured in{' '}
              {context.cohort?.reportingTimezone.replace(/_/g, ' ')}.
            </>
          ) : context.location?.kind === 'before' ? (
            `Your cohort starts in ${context.location.daysUntilStart} day${context.location.daysUntilStart === 1 ? '' : 's'}.`
          ) : (
            'Your 12-week program has finished. Historical work stays available below.'
          )
        }
        actions={
          <>
            <LinkButton href="/leads" variant="primary">
              Log outreach
            </LinkButton>
            <LinkButton href="/linkedin">Add LinkedIn prospect</LinkButton>
          </>
        }
      />

      {outsideProgram ? (
        <Alert tone="info" className="mb-5">
          Today falls outside your 12-week program, so no weekly targets are generated. Cumulative
          totals and earnings below are unaffected.
        </Alert>
      ) : null}

      {/* ---- Weekly goals ------------------------------------------------ */}
      <Card className="mb-5">
        <CardHeader
          title="This week"
          description={
            context.target
              ? `Targets from ${targetSourceLabel(context.target.source)}${context.target.frozen ? ' (frozen — week has ended)' : ''}.`
              : 'No target applies outside the program window.'
          }
          actions={
            context.week ? (
              <Badge tone="neutral">
                {formatDateRangeHuman(context.week.startDate, context.week.endDate)}
              </Badge>
            ) : null
          }
        />
        <CardBody className="grid gap-5 sm:grid-cols-2">
          <GoalMeter
            label="Emails sent"
            achieved={weekTotals.emails}
            target={context.target?.emailTarget ?? 0}
            pace={dashboard.emailPace}
            paceLabel={`suggested ${context.target?.emailDailyPace ?? PROGRAM_DEFAULT_TARGETS.laterWeeks.emailsPerDay}/day`}
            daysLeft={dashboard.workingDaysRemaining}
            definition={METRIC_DEFINITIONS.emails}
            disabled={outsideProgram}
          />
          <ConnectionCount
            label="LinkedIn connections accepted"
            thisWeek={weekTotals.linkedinConnections}
            definition={METRIC_DEFINITIONS.linkedinConnections}
          />
        </CardBody>
        <div className="grid grid-cols-2 gap-px border-t border-ink-100 bg-ink-100 sm:grid-cols-3">
          <MiniStat label="First touches" value={weekTotals.firstTouches} />
          <MiniStat label="Follow-ups" value={weekTotals.followUps} />
          <MiniStat label="Unique clubs contacted" value={weekTotals.uniqueOrganizations} />
        </div>
        <CardBody className="border-t border-ink-100 pt-3">
          <DefinitionNote>
            First touches, follow-ups and unique clubs are shown separately so repeated outreach to
            the same club cannot look like new coverage. All figures are self-reported by you and
            are not independently verified.
          </DefinitionNote>
        </CardBody>
      </Card>

      {/* ---- Pipeline ---------------------------------------------------- */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Assigned clubs" value={pipeline.assignedOrganizations} />
        <StatTile
          label="Untouched clubs"
          value={pipeline.untouchedOrganizations}
          tone={pipeline.untouchedOrganizations > 0 ? 'caution' : 'neutral'}
          sub="No outreach logged yet"
        />
        <StatTile
          label="Overdue follow-ups"
          value={pipeline.overdueFollowUps}
          tone={pipeline.overdueFollowUps > 0 ? 'caution' : 'positive'}
          sub={
            <Link href="/follow-ups" className="text-brand-600 underline">
              Open queue
            </Link>
          }
        />
        <StatTile
          label="Replies this week"
          value={pipeline.repliedOrganizations}
          sub={`Reply rate ${formatRate(pipeline.replyRate)} of ${pipeline.replyRate.denominator} contacted`}
          definition={METRIC_DEFINITIONS.replyRate}
        />
      </div>

      {/* ---- Earnings ---------------------------------------------------- */}
      {compensation ? (
        <Card className="mb-5">
          <CardHeader
            title="Meetings and earnings"
            description="Cumulative across your whole cohort. Never reset by a weekly filter, sign-out or reassignment."
            actions={
              <LinkButton href="/meetings" size="sm">
                Open
              </LinkButton>
            }
          />
          <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Verified held meetings"
              value={compensation.verifiedHeldCount}
              definition={METRIC_DEFINITIONS.verifiedHeld}
              sub={
                compensation.pendingVerificationCount > 0
                  ? `${compensation.pendingVerificationCount} awaiting admin verification`
                  : 'Nothing awaiting verification'
              }
            />
            <StatTile
              label="Earned"
              value={formatCents(compensation.earnedCents)}
              tone="positive"
              sub={milestoneHeadline(compensation)}
            />
            <StatTile label="Recorded as paid" value={formatCents(compensation.paidCents)} />
            <StatTile
              label={compensation.overpaidCents > 0 ? 'Reconciliation needed' : 'Unpaid balance'}
              value={
                compensation.overpaidCents > 0
                  ? formatCents(-compensation.overpaidCents)
                  : formatCents(compensation.balanceCents)
              }
              tone={compensation.overpaidCents > 0 ? 'caution' : 'brand'}
              sub={
                compensation.overpaidCents > 0
                  ? 'A verification was reversed after a payout was recorded. An admin will reconcile this.'
                  : 'Earned minus recorded payments'
              }
            />
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ---- Recent activity ------------------------------------------- */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Recent activity"
            description="Everything you have logged, newest first."
            actions={
              <LinkButton href="/leads" size="sm">
                My leads
              </LinkButton>
            }
          />
          {activity.length === 0 ? (
            <EmptyState
              title="Nothing logged yet"
              description="Open one of your assigned clubs, send your outreach from your Waresport mailbox or LinkedIn, then log it here."
              action={
                <LinkButton href="/leads" variant="primary">
                  Go to my leads
                </LinkButton>
              }
            />
          ) : (
            <TableScroll>
              <thead>
                <tr>
                  <Th>Club</Th>
                  <Th>Action</Th>
                  <Th>Outcome</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.id} className={row.voidedAt ? 'opacity-55' : undefined}>
                    <Td>
                      <Link
                        href={`/leads/${row.organizationId}`}
                        className="font-medium text-ink-900 hover:text-brand-600"
                      >
                        {row.organizationName}
                      </Link>
                      {row.contactName ? (
                        <span className="block text-[12px] text-ink-500">{row.contactName}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {ACTION_LABELS[row.actionType] ?? row.actionType}
                      {row.voidedAt ? (
                        <Badge tone="caution" className="ml-2">
                          Voided
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>{OUTCOME_LABELS[row.outcome] ?? row.outcome}</Td>
                    <Td className="whitespace-nowrap text-ink-600">
                      {row.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          )}
        </Card>

        <div className="grid gap-5">
          <Card>
            <CardHeader
              title="Recent LinkedIn connections"
              actions={
                <LinkButton href="/linkedin" size="sm">
                  Open
                </LinkButton>
              }
            />
            {prospects.length === 0 ? (
              <EmptyState
                title="No connections yet"
                description="Connect with someone on LinkedIn, then log them under LinkedIn."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {prospects.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-2 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink-900">{p.fullName}</p>
                      <p className="truncate text-[12px] text-ink-500">
                        {p.organizationName ?? p.profileUrl}
                      </p>
                    </div>
                    <Badge tone="neutral">{p.status.replace(/_/g, ' ')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Your projects"
              actions={
                <LinkButton href="/training" size="sm">
                  Open
                </LinkButton>
              }
            />
            {projects.length === 0 ? (
              <EmptyState title="No active projects" description="An admin will assign these." />
            ) : (
              <ul className="divide-y divide-ink-100">
                {projects.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-2 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-ink-900">{p.title}</p>
                      {p.due_on ? <p className="text-[12px] text-ink-500">Due {p.due_on}</p> : null}
                    </div>
                    <Badge tone="neutral">{p.status.replace(/_/g, ' ')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function targetSourceLabel(source: string): string {
  if (source === 'intern_override') return 'a target set specifically for you';
  if (source === 'cohort_default') return 'your cohort defaults';
  return 'the program guide';
}

/** LinkedIn has no weekly target: it is a running count interns keep adding to. */
function ConnectionCount({
  label,
  thisWeek,
  definition,
}: {
  label: string;
  thisWeek: number;
  definition: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-700" title={definition}>
          {label}
        </p>
        <p className="tabular text-[13px] text-ink-600">
          <span className="text-lg font-semibold text-ink-900">{thisWeek}</span>
        </p>
      </div>
      <p className="mt-2 text-[12px] text-ink-500">
        No target. Keep logging people as they accept.{' '}
        <Link href="/linkedin" className="text-brand-600 underline">
          Log a connection
        </Link>
      </p>
    </div>
  );
}

function GoalMeter({
  label,
  achieved,
  target,
  pace,
  paceLabel,
  daysLeft,
  definition,
  disabled,
}: {
  label: string;
  achieved: number;
  target: number;
  pace: number | null;
  paceLabel: string;
  daysLeft: number;
  definition: string;
  disabled: boolean;
}) {
  const remaining = Math.max(0, target - achieved);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-700" title={definition}>
          {label}
        </p>
        <p className="tabular text-[13px] text-ink-600">
          <span className="text-lg font-semibold text-ink-900">{achieved}</span>
          {disabled ? null : <span className="text-ink-400"> / {target}</span>}
        </p>
      </div>
      {disabled ? (
        <p className="mt-2 text-[12px] text-ink-500">No target outside the program window.</p>
      ) : (
        <>
          <div className="mt-2">
            <ProgressBar
              value={achieved}
              max={target}
              label={`${label}: ${achieved} of ${target}`}
              tone={achieved >= target ? 'positive' : 'brand'}
            />
          </div>
          <p className="mt-1.5 text-[12px] text-ink-500">
            {remaining === 0 ? (
              <span className="font-medium text-positive-600">Weekly target met.</span>
            ) : (
              <>
                {remaining} to go
                {pace !== null && daysLeft > 0
                  ? ` · about ${pace}/day for the ${daysLeft} working day${daysLeft === 1 ? '' : 's'} left`
                  : ''}
              </>
            )}{' '}
            <span className="text-ink-400">({paceLabel})</span>
          </p>
        </>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white px-4 py-3">
      <p className="text-[12px] text-ink-500">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold text-ink-900">{value}</p>
    </div>
  );
}
