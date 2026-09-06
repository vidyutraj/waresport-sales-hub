import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { loadInternContext } from '@/lib/queries/intern-context';
import { analyseUrl } from '@/lib/domain/url';
import { formatDateOnly } from '@/lib/labels';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  SafeLink,
} from '@/components/ui';
import { TrainingChecklist } from '@/components/client/training-checklist';
import { ProjectSubmissionForm } from '@/components/client/project-submission-form';
import { ReflectionForm } from '@/components/client/reflection-form';

export const metadata = { title: 'Training & projects' };
export const dynamic = 'force-dynamic';

export default async function TrainingPage() {
  const user = await requireIntern();

  const data = await asUser(user.id, async (tx) => {
    const context = await loadInternContext(tx, user.id);
    return {
      context,
      topics: await tx<{ key: string; title: string; description: string | null; done: boolean }[]>`
        SELECT t.key, t.title, t.description,
               EXISTS (SELECT 1 FROM training_completions c
                       WHERE c.topic_id = t.id AND c.user_id = ${user.id}) AS done
        FROM training_topics t WHERE t.is_active ORDER BY t.sort_order`,
      resources: await tx<
        {
          id: string;
          title: string;
          category: string;
          summary: string | null;
          body_markdown: string | null;
          link_url: string | null;
          file_name: string | null;
          is_starter_example: boolean;
        }[]
      >`
        SELECT id, title, category::text, summary, body_markdown, link_url, file_name, is_starter_example
        FROM resources WHERE is_archived = false ORDER BY category, sort_order, title`,
      projects: await tx<
        {
          id: string;
          title: string;
          description: string | null;
          due_on: string | null;
          status: string;
          feedback: string | null;
          last_submitted_at: Date | null;
        }[]
      >`
        SELECT p.id, p.title, p.description, p.due_on::text AS due_on, pa.status::text,
               (SELECT s.feedback FROM project_submissions s
                 WHERE s.project_id = p.id AND s.user_id = ${user.id} AND s.feedback IS NOT NULL
                 ORDER BY s.feedback_at DESC LIMIT 1) AS feedback,
               (SELECT max(s.submitted_at) FROM project_submissions s
                 WHERE s.project_id = p.id AND s.user_id = ${user.id}) AS last_submitted_at
        FROM project_assignments pa
        JOIN projects p ON p.id = pa.project_id
        WHERE pa.user_id = ${user.id} AND p.status <> 'cancelled'
        ORDER BY p.due_on NULLS LAST, p.title`,
      reflection: (
        await tx<
          {
            what_worked: string | null;
            what_did_not_work: string | null;
            successful_sports: string | null;
            recommendations: string | null;
            submitted_at: Date | null;
          }[]
        >`
          SELECT what_worked, what_did_not_work, successful_sports, recommendations, submitted_at
          FROM reflections WHERE user_id = ${user.id}`
      )[0],
      provisioning: (
        await tx<
          {
            outreach_email_provisioned_at: Date | null;
            linkedin_premium_started_on: string | null;
            linkedin_premium_expires_on: string | null;
          }[]
        >`
          SELECT outreach_email_provisioned_at,
                 linkedin_premium_started_on::text AS linkedin_premium_started_on,
                 linkedin_premium_expires_on::text AS linkedin_premium_expires_on
          FROM intern_provisioning WHERE user_id = ${user.id}`
      )[0],
    };
  });

  const { context, topics, resources, projects, reflection, provisioning } = data;
  const done = topics.filter((t) => t.done).length;
  const inFinalStretch =
    context.week !== null &&
    context.cohort !== null &&
    context.week.weekNumber >= context.cohort.weeksCount - 2;

  return (
    <>
      <PageHeader
        title="Training & projects"
        description="Scripts, guidance and the projects assigned to you. Kept deliberately light — leads and outreach come first."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="grid content-start gap-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Scripts and guidance"
              description="Editable by admins. Examples are clearly labelled."
            />
            {resources.length === 0 ? (
              <EmptyState title="No resources yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {resources.map((r) => {
                  const link = analyseUrl(r.link_url);
                  return (
                    <li key={r.id} className="px-4 py-4 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium text-ink-900">{r.title}</h3>
                        <Badge tone="neutral">{r.category.replace(/_/g, ' ')}</Badge>
                        {r.is_starter_example ? (
                          <Badge tone="caution">Starter example — edit before using</Badge>
                        ) : null}
                      </div>
                      {r.summary ? (
                        <p className="mt-1 text-[13px] text-ink-600">{r.summary}</p>
                      ) : null}
                      {r.body_markdown ? (
                        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-ink-200 bg-ink-50 p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-800">
                          {r.body_markdown}
                        </pre>
                      ) : null}
                      {link.safe ? (
                        <p className="mt-2 text-[13px]">
                          <SafeLink href={link.href}>Open resource</SafeLink>
                        </p>
                      ) : null}
                      {r.file_name ? (
                        <p className="mt-2 text-[13px]">
                          <a
                            href={`/api/resources/${r.id}/file`}
                            className="text-brand-600 underline underline-offset-2"
                          >
                            Download {r.file_name}
                          </a>
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Projects"
              description="Submit notes or a link, then mark it ready for review."
            />
            {projects.length === 0 ? (
              <EmptyState
                title="No projects assigned"
                description="An admin assigns projects alongside your outreach."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {projects.map((p) => (
                  <li key={p.id} className="px-4 py-4 sm:px-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-medium text-ink-900">{p.title}</h3>
                      <div className="flex items-center gap-2">
                        {p.due_on ? (
                          <span className="text-[12px] text-ink-500">
                            Due {formatDateOnly(p.due_on)}
                          </span>
                        ) : null}
                        <Badge tone={p.status === 'completed' ? 'positive' : 'neutral'}>
                          {p.status.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                    </div>
                    {p.description ? (
                      <p className="mt-1 text-[13px] text-ink-600">{p.description}</p>
                    ) : null}
                    {p.feedback ? (
                      <Alert tone="info" className="mt-2" title="Feedback from an admin">
                        {p.feedback}
                      </Alert>
                    ) : null}
                    <div className="mt-3">
                      <ProjectSubmissionForm
                        projectId={p.id}
                        lastSubmittedAt={p.last_submitted_at?.toISOString() ?? null}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="End-of-program reflection"
              description="The four wrap-up questions from the program guide."
            />
            <CardBody>
              {!inFinalStretch && reflection?.submitted_at == null ? (
                <Alert tone="info" className="mb-4">
                  This is usually completed near the end of the internship, but you can start a
                  draft whenever you like.
                </Alert>
              ) : null}
              {reflection?.submitted_at ? (
                <Alert tone="positive" className="mb-4">
                  Submitted {formatDateOnly(reflection.submitted_at.toISOString().slice(0, 10))}.
                  You can still edit and resubmit.
                </Alert>
              ) : null}
              <ReflectionForm
                defaults={{
                  whatWorked: reflection?.what_worked ?? '',
                  whatDidNotWork: reflection?.what_did_not_work ?? '',
                  successfulSports: reflection?.successful_sports ?? '',
                  recommendations: reflection?.recommendations ?? '',
                }}
              />
            </CardBody>
          </Card>
        </div>

        <div className="grid content-start gap-5">
          <Card>
            <CardHeader
              title="Training checklist"
              description={`${done} of ${topics.length} marked complete. Self-reported.`}
            />
            <CardBody>
              <TrainingChecklist
                topics={topics.map((t) => ({ key: t.key, title: t.title, done: t.done }))}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="What you have been provided"
              description="Tracked by an admin. This workspace does not create external accounts."
            />
            <CardBody className="grid gap-3 text-[13px]">
              <div>
                <p className="text-[12px] font-medium text-ink-500">Waresport outreach address</p>
                <p className="mt-0.5 wrap-anywhere text-ink-900">
                  {user.waresportOutreachEmail ?? (
                    <span className="text-ink-400">Not provisioned yet</span>
                  )}
                </p>
                {provisioning?.outreach_email_provisioned_at ? (
                  <p className="text-[12px] text-ink-500">
                    Marked provisioned{' '}
                    {formatDateOnly(
                      provisioning.outreach_email_provisioned_at.toISOString().slice(0, 10),
                    )}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-[12px] font-medium text-ink-500">LinkedIn Premium (2 months)</p>
                <p className="mt-0.5 text-ink-900">
                  {provisioning?.linkedin_premium_started_on ? (
                    <>
                      {formatDateOnly(provisioning.linkedin_premium_started_on)} –{' '}
                      {provisioning.linkedin_premium_expires_on
                        ? formatDateOnly(provisioning.linkedin_premium_expires_on)
                        : 'no end date recorded'}
                    </>
                  ) : (
                    <span className="text-ink-400">Not recorded yet</span>
                  )}
                </p>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
