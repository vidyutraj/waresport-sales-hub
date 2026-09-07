import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { listCohorts } from '@/lib/queries/program';
import { listPeople } from '@/lib/services/admin';
import { analyseUrl } from '@/lib/domain/url';
import { formatDateOnly, formatInstant } from '@/lib/labels';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  NotAvailable,
  PageHeader,
  SafeLink,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { ResourceForm } from '@/components/client/resource-form';
import { ProjectForm } from '@/components/client/project-form';
import { SubmissionReviewForm } from '@/components/client/submission-review-form';
import { ActionButton } from '@/components/client/form';
import { archiveResourceAction, cancelProjectAction, restoreResourceAction } from './actions';

export const metadata = { title: 'Resources & projects' };
export const dynamic = 'force-dynamic';

export default async function ResourcesPage() {
  const user = await requireAdmin();

  const data = await asUser(user.id, async (tx) => ({
    resources: await tx<
      {
        id: string;
        title: string;
        category: string;
        audience: string;
        summary: string | null;
        link_url: string | null;
        file_name: string | null;
        is_starter_example: boolean;
      }[]
    >`
      SELECT id, title, category::text, audience::text, summary, link_url, file_name, is_starter_example
      FROM resources WHERE is_archived = false ORDER BY category, sort_order, title`,
    archivedResources: await tx<{ id: string; title: string; category: string }[]>`
      SELECT id, title, category::text
      FROM resources WHERE is_archived = true ORDER BY title`,
    cohorts: await listCohorts(tx),
    interns: (await listPeople(tx, { role: 'intern' })).filter((p) => p.status === 'active'),
    projects: await tx<
      {
        id: string;
        title: string;
        description: string | null;
        due_on: string | null;
        status: string;
        assigned: number;
        ready: number;
      }[]
    >`
      SELECT p.id, p.title, p.description, p.due_on::text AS due_on, p.status::text,
             (SELECT count(*)::int FROM project_assignments pa WHERE pa.project_id = p.id) AS assigned,
             (SELECT count(*)::int FROM project_assignments pa
               WHERE pa.project_id = p.id AND pa.status = 'ready_for_review') AS ready
      FROM projects p WHERE p.status <> 'cancelled'
      ORDER BY p.due_on NULLS LAST, p.created_at DESC`,
    submissions: await tx<
      {
        id: string;
        project_title: string;
        user_name: string;
        notes: string | null;
        link_url: string | null;
        submitted_at: Date;
        feedback: string | null;
      }[]
    >`
      SELECT s.id, p.title AS project_title,
             coalesce(u.preferred_name, u.full_name, u.email::text) AS user_name,
             s.notes, s.link_url, s.submitted_at, s.feedback
      FROM project_submissions s
      JOIN projects p ON p.id = s.project_id
      JOIN users u ON u.id = s.user_id
      ORDER BY s.submitted_at DESC
      LIMIT 40`,
    reflections: await tx<
      {
        user_name: string;
        user_id: string;
        submitted_at: Date | null;
        what_worked: string | null;
        successful_sports: string | null;
      }[]
    >`
      SELECT coalesce(u.preferred_name, u.full_name, u.email::text) AS user_name,
             r.user_id, r.submitted_at, r.what_worked, r.successful_sports
      FROM reflections r JOIN users u ON u.id = r.user_id
      ORDER BY r.submitted_at DESC NULLS LAST`,
  }));

  return (
    <>
      <PageHeader
        title="Resources & projects"
        description="Scripts and guidance for interns, plus the small projects that run alongside outreach."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="grid content-start gap-5">
          <Card>
            <CardHeader
              title="Add a resource"
              description="Scripts, guidance, training links or the program PDF."
            />
            <CardBody>
              <ResourceForm />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Create a project" />
            <CardBody>
              <ProjectForm
                cohorts={data.cohorts.map((c) => ({ id: c.id, name: c.name }))}
                interns={data.interns.map((i) => ({
                  id: i.id,
                  name: i.preferredName ?? i.fullName ?? i.email,
                }))}
              />
            </CardBody>
          </Card>
        </div>

        <div className="grid content-start gap-5 lg:col-span-2">
          <Card>
            <CardHeader
              title={`Resources (${data.resources.length})`}
              description="Example scripts written by this project are labelled as starter examples."
            />
            {data.resources.length === 0 ? (
              <EmptyState title="No resources yet" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Title</Th>
                    <Th>Category</Th>
                    <Th>Audience</Th>
                    <Th>Attachment</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.resources.map((r) => {
                    const link = analyseUrl(r.link_url);
                    return (
                      <tr key={r.id}>
                        <Td>
                          <span className="font-medium text-ink-900">{r.title}</span>
                          {r.is_starter_example ? (
                            <Badge tone="caution" className="ml-2">
                              Starter example
                            </Badge>
                          ) : null}
                          {r.summary ? (
                            <span className="block text-[12px] text-ink-500">{r.summary}</span>
                          ) : null}
                        </Td>
                        <Td className="whitespace-nowrap">{r.category.replace(/_/g, ' ')}</Td>
                        <Td>{r.audience}</Td>
                        <Td>
                          {r.file_name ? (
                            <a
                              href={`/api/resources/${r.id}/file`}
                              className="text-brand-600 underline underline-offset-2"
                            >
                              {r.file_name}
                            </a>
                          ) : link.safe ? (
                            <SafeLink href={link.href}>{link.hostname}</SafeLink>
                          ) : (
                            <NotAvailable label="—" />
                          )}
                        </Td>
                        <Td>
                          <ActionButton
                            action={archiveResourceAction}
                            fields={{ resourceId: r.id }}
                            variant="danger"
                            confirm="Archive this resource?"
                          >
                            Archive
                          </ActionButton>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardHeader title={`Projects (${data.projects.length})`} />
            {data.projects.length === 0 ? (
              <EmptyState title="No projects yet" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Title</Th>
                    <Th>Due</Th>
                    <Th numeric>Assigned</Th>
                    <Th numeric>Ready for review</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((p) => (
                    <tr key={p.id}>
                      <Td>
                        <span className="font-medium text-ink-900">{p.title}</span>
                        {p.description ? (
                          <span className="block text-[12px] text-ink-500">{p.description}</span>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {p.due_on ? formatDateOnly(p.due_on) : <NotAvailable label="—" />}
                      </Td>
                      <Td numeric>{p.assigned}</Td>
                      <Td numeric>
                        {p.ready > 0 ? (
                          <span className="font-medium text-caution-700">{p.ready}</span>
                        ) : (
                          0
                        )}
                      </Td>
                      <Td>
                        <ActionButton
                          action={cancelProjectAction}
                          fields={{ projectId: p.id }}
                          variant="danger"
                          confirm="Cancel this project? Submissions already made are kept."
                          pendingLabel="Cancelling…"
                        >
                          Cancel
                        </ActionButton>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          {data.archivedResources.length > 0 ? (
            <Card>
              <CardHeader
                title={`Archived resources (${data.archivedResources.length})`}
                description="Hidden from interns. Restore one if you archived it by mistake."
              />
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Title</Th>
                    <Th>Category</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.archivedResources.map((r) => (
                    <tr key={r.id}>
                      <Td>{r.title}</Td>
                      <Td className="whitespace-nowrap">{r.category.replace(/_/g, ' ')}</Td>
                      <Td>
                        <ActionButton
                          action={restoreResourceAction}
                          fields={{ resourceId: r.id }}
                          pendingLabel="Restoring…"
                        >
                          Restore
                        </ActionButton>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Submissions" description="Newest first." />
            {data.submissions.length === 0 ? (
              <EmptyState title="No submissions yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {data.submissions.map((s) => {
                  const link = analyseUrl(s.link_url);
                  return (
                    <li key={s.id} className="px-4 py-4 sm:px-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-ink-900">
                          {s.project_title} — {s.user_name}
                        </p>
                        <span className="text-[12px] text-ink-500">
                          {formatInstant(s.submitted_at, 'UTC')}
                        </span>
                      </div>
                      {s.notes ? (
                        <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-700">
                          {s.notes}
                        </p>
                      ) : null}
                      {link.safe ? (
                        <p className="mt-1 text-[13px]">
                          <SafeLink href={link.href}>{link.hostname}</SafeLink>
                        </p>
                      ) : null}
                      <div className="mt-2">
                        <SubmissionReviewForm submissionId={s.id} existingFeedback={s.feedback} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="End-of-program reflections"
              description="The wrap-up questions from the program guide."
            />
            {data.reflections.length === 0 ? (
              <EmptyState title="No reflections yet" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Intern</Th>
                    <Th>Submitted</Th>
                    <Th>Most successful sports</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.reflections.map((r) => (
                    <tr key={r.user_id}>
                      <Td>
                        <a
                          href={`/admin/interns/${r.user_id}`}
                          className="text-ink-900 hover:text-brand-600"
                        >
                          {r.user_name}
                        </a>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {r.submitted_at ? (
                          formatInstant(r.submitted_at, 'UTC', { timeStyle: undefined })
                        ) : (
                          <Badge tone="neutral">Draft</Badge>
                        )}
                      </Td>
                      <Td className="wrap-anywhere max-w-sm">
                        {r.successful_sports ?? <NotAvailable label="—" />}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
