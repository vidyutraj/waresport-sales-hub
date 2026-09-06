import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { cohortDefaultTargets, listCohorts, metricPolicyAt } from '@/lib/queries/program';
import { allProgramWeeks, currentProgramWeek, PROGRAM_DEFAULT_TARGETS } from '@/lib/domain/program';
import { formatDateRangeHuman } from '@/lib/domain/time';
import { METRIC_DEFINITIONS } from '@/lib/domain/metrics';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  DefinitionNote,
  EmptyState,
  PageHeader,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { CohortForm } from '@/components/client/cohort-form';
import { TargetOverrideForm } from '@/components/client/target-override-form';
import { MetricPolicyForm } from '@/components/client/metric-policy-form';

export const metadata = { title: 'Targets & program' };
export const dynamic = 'force-dynamic';

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohortId?: string }>;
}) {
  const user = await requireAdmin();
  const { cohortId } = await searchParams;
  const now = new Date();

  const data = await asUser(user.id, async (tx) => {
    const cohorts = await listCohorts(tx);
    const cohort =
      (cohortId ? cohorts.find((c) => c.id === cohortId) : undefined) ??
      cohorts.find((c) => c.isActive) ??
      cohorts[0] ??
      null;
    return {
      cohorts,
      cohort,
      defaults: cohort ? await cohortDefaultTargets(tx, cohort.id, cohort.weeksCount) : [],
      policy: cohort ? await metricPolicyAt(tx, cohort.id, now) : null,
      rowVersion: cohort
        ? Number(
            (
              await tx<{ row_version: number }[]>`
                SELECT row_version FROM cohorts WHERE id = ${cohort.id}`
            )[0]?.row_version ?? 1,
          )
        : 1,
    };
  });

  const { cohort } = data;
  const weeks = cohort ? allProgramWeeks(cohort) : [];
  const currentWeek = cohort ? currentProgramWeek(cohort, now) : null;

  return (
    <>
      <PageHeader
        title="Targets & program"
        description="Cohort dates, weekly goals, and how outreach is counted."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="grid content-start gap-5">
          <Card>
            <CardHeader
              title={cohort ? 'Edit cohort' : 'Create your first cohort'}
              description="Start date and reporting timezone define every week boundary."
            />
            <CardBody>
              <CohortForm
                cohorts={data.cohorts.map((c) => ({ id: c.id, name: c.name }))}
                current={
                  cohort
                    ? {
                        cohortId: cohort.id,
                        name: cohort.name,
                        startDate: cohort.startDate,
                        weeksCount: cohort.weeksCount,
                        reportingTimezone: cohort.reportingTimezone,
                        rowVersion: data.rowVersion,
                      }
                    : null
                }
              />
            </CardBody>
          </Card>

          {cohort ? (
            <Card>
              <CardHeader
                title="Set a cohort default target"
                description="Applies to every intern who has no personal override."
              />
              <CardBody>
                <TargetOverrideForm cohortId={cohort.id} weeksCount={cohort.weeksCount} />
              </CardBody>
            </Card>
          ) : null}

          {cohort && data.policy ? (
            <Card>
              <CardHeader
                title="Metric policy"
                description="Versioned. A change applies from now onward only."
              />
              <CardBody>
                <MetricPolicyForm
                  cohortId={cohort.id}
                  current={{
                    emailCountsFollowups: data.policy.emailCountsFollowups,
                    linkedinCountsFirstRequestOnly: data.policy.linkedinCountsFirstRequestOnly,
                    version: data.policy.version,
                  }}
                />
              </CardBody>
            </Card>
          ) : null}
        </div>

        <div className="grid content-start gap-5 lg:col-span-2">
          {cohort === null ? (
            <Card>
              <EmptyState
                title="No cohort yet"
                description="Create one on the left. It will be seeded with the targets printed in the program guide: 75 emails / 50 requests in week 1, then 150 / 100."
              />
            </Card>
          ) : (
            <>
              <Alert tone="info">
                <p>
                  <strong>Week model:</strong> week 1 is the first seven calendar days from the
                  cohort start date; weeks 2–{cohort.weeksCount} follow consecutively. Boundaries
                  are computed in <strong>{cohort.reportingTimezone}</strong> as half-open ranges,
                  so a week that crosses a daylight-saving change is still exactly seven local days.
                  The program guide does not define this, so it is a documented implementation
                  default.
                </p>
              </Alert>

              <Card>
                <CardHeader
                  title="Weekly targets"
                  description="Bold rows differ from the program guide's printed figures."
                />
                <TableScroll>
                  <thead>
                    <tr>
                      <Th>Week</Th>
                      <Th>Dates</Th>
                      <Th numeric>Emails</Th>
                      <Th numeric>Requests</Th>
                      <Th numeric>Emails/day</Th>
                      <Th numeric>Requests/day</Th>
                      <Th>Source</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.defaults.map((t, index) => {
                      const week = weeks[index];
                      const guide =
                        t.weekNumber === 1
                          ? PROGRAM_DEFAULT_TARGETS.week1
                          : PROGRAM_DEFAULT_TARGETS.laterWeeks;
                      const differs =
                        t.emailTarget !== guide.emails || t.linkedinTarget !== guide.linkedin;
                      return (
                        <tr
                          key={t.weekNumber}
                          data-testid={`target-week-${t.weekNumber}`}
                          className={
                            currentWeek?.weekNumber === t.weekNumber ? 'bg-brand-50/40' : undefined
                          }
                        >
                          <Td>
                            {t.weekNumber}
                            {currentWeek?.weekNumber === t.weekNumber ? (
                              <Badge tone="brand" className="ml-2">
                                Current
                              </Badge>
                            ) : null}
                          </Td>
                          <Td className="whitespace-nowrap text-ink-600">
                            {week ? formatDateRangeHuman(week.startDate, week.endDate) : '—'}
                          </Td>
                          <Td numeric className={differs ? 'font-semibold' : undefined}>
                            {t.emailTarget}
                          </Td>
                          <Td numeric className={differs ? 'font-semibold' : undefined}>
                            {t.linkedinTarget}
                          </Td>
                          <Td numeric className="text-ink-500">
                            {t.emailDailyPace}
                          </Td>
                          <Td numeric className="text-ink-500">
                            {t.linkedinDailyPace}
                          </Td>
                          <Td className="text-[12px] text-ink-500">
                            {t.configured ? 'Cohort default' : 'Program guide'}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </TableScroll>
                <CardBody className="border-t border-ink-100">
                  <DefinitionNote>
                    The suggested per-day figures are advisory. They never create an attendance
                    rule, and a zero target is handled without dividing by zero. Editing a target
                    does not change a week that has already ended: those are frozen per intern the
                    first time they are read after the week closes.
                  </DefinitionNote>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="How outreach is counted" />
                <CardBody className="grid gap-3 text-[13px]">
                  <Definition term="Emails" text={METRIC_DEFINITIONS.emails} />
                  <Definition term="LinkedIn requests" text={METRIC_DEFINITIONS.linkedinRequests} />
                  <Definition term="Reply rate" text={METRIC_DEFINITIONS.replyRate} />
                  <Definition term="Meeting rate" text={METRIC_DEFINITIONS.meetingRate} />
                  <Definition term="Verified held" text={METRIC_DEFINITIONS.verifiedHeld} />
                  <DefinitionNote>
                    The program guide does not settle whether a follow-up email counts toward the
                    weekly email number. The default here is that it does; an admin can change that
                    prospectively, and past weeks keep the rule they were measured under.
                  </DefinitionNote>
                </CardBody>
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Definition({ term, text }: { term: string; text: string }) {
  return (
    <div>
      <p className="font-medium text-ink-900">{term}</p>
      <p className="text-ink-600">{text}</p>
    </div>
  );
}
