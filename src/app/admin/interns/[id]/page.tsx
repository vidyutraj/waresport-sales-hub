import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { listPeople } from '@/lib/services/admin';
import { listCohorts, listTerritories, resolveAllWeeklyTargets } from '@/lib/queries/program';
import {
  compensationFor,
  outreachTotals,
  pipelineFor,
  recentActivity,
} from '@/lib/queries/metrics';
import { listMeetings, listPayouts, MEETING_STATUS_LABELS } from '@/lib/services/meetings';
import { listAudit } from '@/lib/services/audit';
import { cohortRange, formatRate, programWeek, rate } from '@/lib/domain/program';
import { formatCents, milestoneHeadline } from '@/lib/domain/compensation';
import { METRIC_DEFINITIONS } from '@/lib/domain/metrics';
import { ACTION_LABELS, formatDateOnly, formatInstant, TARGET_SOURCE_LABELS } from '@/lib/labels';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  DefinitionNote,
  EmptyState,
  LinkButton,
  NotAvailable,
  PageHeader,
  StatTile,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { MembershipForm } from '@/components/client/membership-form';
import { ProvisioningForm } from '@/components/client/provisioning-form';
import { TargetOverrideForm } from '@/components/client/target-override-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireAdmin();
  const people = await asUser(admin.id, (tx) => listPeople(tx));
  const person = people.find((p) => p.id === id);
  return { title: person ? (person.preferredName ?? person.fullName ?? person.email) : 'Intern' };
}

export default async function InternDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireAdmin();
  const now = new Date();

  const data = await asUser(admin.id, async (tx) => {
    const people = await listPeople(tx);
    const person = people.find((p) => p.id === id);
    if (person === undefined) return null;

    const cohorts = await listCohorts(tx);
    const cohort = person.cohortId ? (cohorts.find((c) => c.id === person.cohortId) ?? null) : null;
    const range = cohort ? cohortRange(cohort) : null;

    return {
      person,
      cohorts,
      cohort,
      territories: await listTerritories(tx),
      targets: cohort ? await resolveAllWeeklyTargets(tx, cohort, id, now) : [],
      compensation:
        cohort && range
          ? await compensationFor(tx, { userId: id, cohortId: cohort.id, cohortRange: range })
          : null,
      lifetimeTotals: range
        ? await outreachTotals(tx, {
            actorUserId: id,
            range,
            policy: {
              version: 1,
              emailCountsFollowups: true,
              linkedinCountsFirstRequestOnly: true,
            },
          })
        : null,
      pipeline: range
        ? await pipelineFor(tx, { userId: id, range, today: new Date().toISOString().slice(0, 10) })
        : null,
      weekly: cohort
        ? await Promise.all(
            Array.from({ length: cohort.weeksCount }, async (_, i) => {
              const week = programWeek(cohort, i + 1);
              return {
                week,
                totals: await outreachTotals(tx, {
                  actorUserId: id,
                  range: week.range,
                  policy: {
                    version: 1,
                    emailCountsFollowups: true,
                    linkedinCountsFirstRequestOnly: true,
                  },
                }),
              };
            }),
          )
        : [],
      activity: await recentActivity(tx, { actorUserId: id, limit: 25 }),
      meetings: await listMeetings(tx, { creditedUserId: id, limit: 100 }),
      payouts: await listPayouts(tx, { userId: id, cohortId: person.cohortId }),
      assignments: await tx<{ id: string; name: string; state: string | null; status: string }[]>`
        SELECT o.id, o.name, o.state, o.status::text
        FROM organization_assignments a
        JOIN organizations o ON o.id = a.organization_id
        WHERE a.intern_user_id = ${id} AND a.unassigned_at IS NULL
        ORDER BY o.name
        LIMIT 200`,
      training: await tx<{ title: string; done: boolean }[]>`
        SELECT t.title,
               EXISTS (SELECT 1 FROM training_completions c
                       WHERE c.topic_id = t.id AND c.user_id = ${id}) AS done
        FROM training_topics t WHERE t.is_active ORDER BY t.sort_order`,
      projects: await tx<{ title: string; status: string; due_on: string | null }[]>`
        SELECT p.title, pa.status::text, p.due_on::text AS due_on
        FROM project_assignments pa JOIN projects p ON p.id = pa.project_id
        WHERE pa.user_id = ${id} ORDER BY p.due_on NULLS LAST`,
      reflection: (
        await tx<
          {
            what_worked: string | null;
            what_did_not_work: string | null;
            successful_sports: string | null;
            recommendations: string | null;
            submitted_at: Date | null;
          }[]
        >`SELECT what_worked, what_did_not_work, successful_sports, recommendations, submitted_at
          FROM reflections WHERE user_id = ${id}`
      )[0],
      provisioning: (
        await tx<
          {
            outreach_email_provisioned_at: Date | null;
            linkedin_premium_started_on: string | null;
            linkedin_premium_expires_on: string | null;
          }[]
        >`SELECT outreach_email_provisioned_at,
                 linkedin_premium_started_on::text AS linkedin_premium_started_on,
                 linkedin_premium_expires_on::text AS linkedin_premium_expires_on
          FROM intern_provisioning WHERE user_id = ${id}`
      )[0],
      audit: await listAudit(tx, { entityType: 'user', entityId: id, limit: 20 }),
    };
  });

  if (data === null) notFound();
  const { person, cohort, compensation, pipeline, weekly } = data;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/admin/interns" className="hover:text-brand-600">
            ← Interns
          </Link>
        }
        title={person.preferredName ?? person.fullName ?? person.email}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="wrap-anywhere">{person.email}</span>
            <Badge tone={person.status === 'active' ? 'positive' : 'caution'}>
              {person.status}
            </Badge>
            {person.territoryCode ? <Badge tone="neutral">{person.territoryCode}</Badge> : null}
            {cohort ? <Badge tone="neutral">{cohort.name}</Badge> : null}
          </span>
        }
        actions={<LinkButton href={`/api/exports/intern/${person.id}`}>Export CSV</LinkButton>}
      />

      {compensation ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Verified held meetings"
            value={compensation.verifiedHeldCount}
            definition={METRIC_DEFINITIONS.verifiedHeld}
            sub={`${compensation.pendingVerificationCount} pending`}
          />
          <StatTile
            label="Earned (cohort lifetime)"
            value={formatCents(compensation.earnedCents)}
            tone="positive"
            sub={milestoneHeadline(compensation)}
          />
          <StatTile label="Recorded as paid" value={formatCents(compensation.paidCents)} />
          <StatTile
            label={compensation.overpaidCents > 0 ? 'Overpaid' : 'Unpaid balance'}
            value={
              compensation.overpaidCents > 0
                ? formatCents(-compensation.overpaidCents)
                : formatCents(compensation.balanceCents)
            }
            tone={compensation.overpaidCents > 0 ? 'caution' : 'brand'}
          />
        </div>
      ) : (
        <Alert tone="caution" className="mb-5">
          This intern is not in a cohort, so there are no weekly targets and nothing to earn
          against. Assign a cohort below.
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="grid content-start gap-5 lg:col-span-2">
          {cohort ? (
            <Card>
              <CardHeader
                title="Weekly trend"
                description={`Targets resolve per week; a frozen week keeps the target it was worked under. Times in ${cohort.reportingTimezone}.`}
              />
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Week</Th>
                    <Th>Dates</Th>
                    <Th numeric>Emails</Th>
                    <Th numeric>Target</Th>
                    <Th numeric>Requests</Th>
                    <Th numeric>Target</Th>
                    <Th numeric>Unique clubs</Th>
                    <Th>Target source</Th>
                  </tr>
                </thead>
                <tbody>
                  {weekly.map(({ week, totals }, index) => {
                    const target = data.targets[index];
                    return (
                      <tr key={week.weekNumber}>
                        <Td>{week.weekNumber}</Td>
                        <Td className="whitespace-nowrap text-ink-600">
                          {week.label.replace(/^Week \d+ · /, '')}
                        </Td>
                        <Td numeric>{totals.emails}</Td>
                        <Td numeric className="text-ink-500">
                          {target?.emailTarget ?? '—'}
                        </Td>
                        <Td numeric>{totals.linkedinRequests}</Td>
                        <Td numeric className="text-ink-500">
                          {target?.linkedinTarget ?? '—'}
                        </Td>
                        <Td numeric>{totals.uniqueOrganizations}</Td>
                        <Td className="text-[12px] text-ink-500">
                          {target ? (TARGET_SOURCE_LABELS[target.source] ?? target.source) : '—'}
                          {target?.frozen ? ' (frozen)' : ''}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableScroll>
              <CardBody className="border-t border-ink-100">
                <DefinitionNote>
                  Emails count explicitly logged initial and follow-up sends. Requests count
                  first-time LinkedIn connection requests only. All figures are self-reported.
                </DefinitionNote>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title={`Assigned clubs (${data.assignments.length})`}
              description="Current responsibility. Past contributions stay with this intern regardless."
              actions={
                <LinkButton href={`/admin/leads?assigneeId=${person.id}`} size="sm">
                  Manage
                </LinkButton>
              }
            />
            {data.assignments.length === 0 ? (
              <EmptyState title="No clubs assigned" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Club</Th>
                    <Th>State</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.assignments.slice(0, 50).map((a) => (
                    <tr key={a.id}>
                      <Td>
                        <Link
                          href={`/admin/leads/${a.id}`}
                          className="text-ink-900 hover:text-brand-600"
                        >
                          {a.name}
                        </Link>
                      </Td>
                      <Td>{a.state ?? <NotAvailable label="—" />}</Td>
                      <Td>{a.status.replace(/_/g, ' ')}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardHeader title="Activity timeline" description="This intern's own logged work." />
            {data.activity.length === 0 ? (
              <EmptyState title="Nothing logged yet" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Club</Th>
                    <Th>Action</Th>
                    <Th>Outcome</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.activity.map((a) => (
                    <tr key={a.id} className={a.voidedAt ? 'opacity-60' : undefined}>
                      <Td className="whitespace-nowrap text-ink-600">
                        {formatInstant(a.occurredAt, cohort?.reportingTimezone ?? 'UTC')}
                      </Td>
                      <Td>{a.organizationName}</Td>
                      <Td>
                        {ACTION_LABELS[a.actionType] ?? a.actionType}
                        {a.voidedAt ? (
                          <Badge tone="caution" className="ml-1">
                            Voided
                          </Badge>
                        ) : null}
                      </Td>
                      <Td>{a.outcome.replace(/_/g, ' ')}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardHeader title="Meetings" />
            {data.meetings.length === 0 ? (
              <EmptyState title="No meetings" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Club</Th>
                    <Th>Scheduled</Th>
                    <Th>Held</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.meetings.map((m) => (
                    <tr key={m.id}>
                      <Td>{m.organizationName}</Td>
                      <Td className="whitespace-nowrap">
                        {formatInstant(m.scheduledStartAt, m.scheduledTimezone)}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {m.heldAt ? formatInstant(m.heldAt, 'UTC') : <NotAvailable label="—" />}
                      </Td>
                      <Td>
                        <Badge tone={m.status === 'verified_held' ? 'positive' : 'neutral'}>
                          {MEETING_STATUS_LABELS[m.status]}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          {data.reflection ? (
            <Card>
              <CardHeader
                title="End-of-program reflection"
                description={
                  data.reflection.submitted_at
                    ? `Submitted ${formatDateOnly(data.reflection.submitted_at.toISOString().slice(0, 10))}`
                    : 'Draft — not yet submitted'
                }
              />
              <CardBody className="grid gap-3 text-[13px]">
                <Reflection label="What worked" value={data.reflection.what_worked} />
                <Reflection label="What didn't work" value={data.reflection.what_did_not_work} />
                <Reflection
                  label="Most successful sports"
                  value={data.reflection.successful_sports}
                />
                <Reflection label="Recommendations" value={data.reflection.recommendations} />
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="grid content-start gap-5">
          <Card>
            <CardHeader title="Cohort and territory" description="Admin-assigned." />
            <CardBody>
              <MembershipForm
                userId={person.id}
                cohorts={data.cohorts.map((c) => ({
                  id: c.id,
                  name: c.name,
                  startDate: c.startDate,
                }))}
                territories={data.territories.map((t) => ({
                  id: t.id,
                  label: `${t.code} — ${t.name}`,
                }))}
                current={{
                  cohortId: person.cohortId ?? '',
                  territoryId: person.territoryId ?? '',
                  joinedOn: person.joinedOn ?? new Date().toISOString().slice(0, 10),
                  outreachEmail: person.waresportOutreachEmail ?? '',
                }}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Provisioning checklist"
              description="What you set up outside this system."
            />
            <CardBody>
              <ProvisioningForm
                userId={person.id}
                current={{
                  outreachEmailProvisioned:
                    data.provisioning?.outreach_email_provisioned_at != null,
                  linkedinPremiumStartedOn: data.provisioning?.linkedin_premium_started_on ?? '',
                  linkedinPremiumExpiresOn: data.provisioning?.linkedin_premium_expires_on ?? '',
                }}
              />
            </CardBody>
          </Card>

          {cohort ? (
            <Card>
              <CardHeader
                title="Per-intern target override"
                description="Applies from the chosen week onward; elapsed weeks are frozen."
              />
              <CardBody>
                <TargetOverrideForm
                  cohortId={cohort.id}
                  userId={person.id}
                  weeksCount={cohort.weeksCount}
                />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Training" description={`Self-reported.`} />
            <CardBody>
              <ul className="grid gap-1.5 text-[13px]">
                {data.training.map((t) => (
                  <li key={t.title} className="flex items-start gap-2">
                    <span
                      aria-hidden="true"
                      className={t.done ? 'text-positive-600' : 'text-ink-300'}
                    >
                      {t.done ? '✓' : '○'}
                    </span>
                    <span className={t.done ? 'text-ink-500' : 'text-ink-800'}>{t.title}</span>
                    <span className="sr-only">{t.done ? 'complete' : 'not complete'}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Projects" />
            {data.projects.length === 0 ? (
              <EmptyState title="None assigned" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.projects.map((p) => (
                  <li key={p.title} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span className="text-[13px] text-ink-800">{p.title}</span>
                    <Badge tone="neutral">{p.status.replace(/_/g, ' ')}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {pipeline ? (
            <Card>
              <CardHeader title="Conversion" description="Across the whole cohort window." />
              <CardBody className="grid gap-2 text-[13px]">
                <Row label="Clubs contacted" value={String(pipeline.contactedOrganizations)} />
                <Row label="Clubs that replied" value={String(pipeline.repliedOrganizations)} />
                <Row
                  label="Reply rate"
                  value={`${formatRate(pipeline.replyRate)} of ${pipeline.replyRate.denominator}`}
                />
                <Row
                  label="Meeting rate"
                  value={`${formatRate(rate(pipeline.meetingsVerifiedHeld, pipeline.contactedOrganizations))} of ${pipeline.contactedOrganizations}`}
                />
                <DefinitionNote>
                  {METRIC_DEFINITIONS.replyRate} An em dash means nothing was contacted yet.
                </DefinitionNote>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Recent admin changes" description="From the audit trail." />
            {data.audit.length === 0 ? (
              <EmptyState title="No changes recorded" />
            ) : (
              <ul className="divide-y divide-ink-100 text-[12px]">
                {data.audit.map((a) => (
                  <li key={a.id} className="px-4 py-2">
                    <span className="font-medium text-ink-800">{a.action}</span>
                    <span className="block text-ink-500">
                      {a.actorName ?? 'system'} · {formatInstant(a.createdAt, 'UTC')}
                    </span>
                    {a.reason ? <span className="block text-ink-600">{a.reason}</span> : null}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-500">{label}</span>
      <span className="tabular font-medium text-ink-900">{value}</span>
    </div>
  );
}

function Reflection({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-ink-500">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-ink-800">
        {value ?? <span className="text-ink-400">Not answered</span>}
      </p>
    </div>
  );
}
