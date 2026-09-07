import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { listPeople } from '@/lib/services/admin';
import { listCohorts, listTerritories } from '@/lib/queries/program';
import { formatDateOnly, formatInstant } from '@/lib/labels';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  NotAvailable,
  PageHeader,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { AddPersonForm } from '@/components/client/add-person-form';
import { PersonActions } from '@/components/client/person-actions';

export const metadata = { title: 'Interns' };
export const dynamic = 'force-dynamic';

export default async function InternsPage() {
  const user = await requireAdmin();

  const data = await asUser(user.id, async (tx) => ({
    people: await listPeople(tx),
    cohorts: await listCohorts(tx),
    territories: await listTerritories(tx),
  }));

  const interns = data.people.filter((p) => p.role === 'intern');
  const staff = data.people.filter((p) => p.role !== 'intern');

  return (
    <>
      <PageHeader
        title="Interns"
        description="Profiles are created here or from the server. People sign in by picking their own name — there is no password."
      />

      {data.cohorts.length === 0 ? (
        <Alert tone="caution" className="mb-5" title="Create a cohort first">
          Interns need a cohort and a territory. Set one up under Targets &amp; Program before
          adding anyone.
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader
            title="Add someone"
            description={
              user.role === 'owner'
                ? 'You can add interns and admins.'
                : 'Admins can add interns. Only the owner can create another admin.'
            }
          />
          <CardBody>
            <AddPersonForm
              canAddAdmin={user.role === 'owner'}
              cohorts={data.cohorts.map((c) => ({ id: c.id, name: c.name }))}
              territories={data.territories.map((t) => ({
                id: t.id,
                label: `${t.code} — ${t.name}`,
              }))}
            />
          </CardBody>
        </Card>

        <div className="grid content-start gap-5 lg:col-span-2">
          <Card>
            <CardHeader
              title={`Interns (${interns.length})`}
              description="Deactivating an account blocks access immediately; historical work stays attributed to them."
            />
            {interns.length === 0 ? (
              <EmptyState
                title="No interns yet"
                description="Add one using the form on the left."
              />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Status</Th>
                    <Th>Cohort / territory</Th>
                    <Th>Outreach address</Th>
                    <Th>Training</Th>
                    <Th>Last sign-in</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {interns.map((p) => (
                    <tr key={p.id}>
                      <Td>
                        <Link
                          href={`/admin/interns/${p.id}`}
                          className="font-medium text-ink-900 hover:text-brand-600"
                        >
                          {p.preferredName ?? p.fullName ?? p.email}
                        </Link>
                        <span className="block wrap-anywhere text-[12px] text-ink-500">
                          {p.email}
                        </span>
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            p.status === 'active'
                              ? 'positive'
                              : p.status === 'invited'
                                ? 'info'
                                : 'caution'
                          }
                        >
                          {p.status}
                        </Badge>
                        {p.onboardingCompletedAt === null ? (
                          <span className="block text-[11px] text-caution-700">
                            Onboarding incomplete
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {p.cohortName ?? <NotAvailable label="None" />}
                        {p.territoryCode ? (
                          <span className="block text-[12px] text-ink-500">
                            {p.territoryCode}
                            {p.joinedOn ? ` · joined ${formatDateOnly(p.joinedOn)}` : ''}
                          </span>
                        ) : null}
                      </Td>
                      <Td className="wrap-anywhere">
                        {p.waresportOutreachEmail ?? <NotAvailable label="Not provisioned" />}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {p.trainingCompleted}/{p.trainingTotal}
                      </Td>
                      <Td className="whitespace-nowrap text-ink-600">
                        {p.lastSignInAt
                          ? formatInstant(p.lastSignInAt, 'UTC', { dateStyle: 'short' })
                          : '—'}
                      </Td>
                      <Td>
                        <PersonActions
                          userId={p.id}
                          active={p.status === 'active'}
                          role="intern"
                          canChangeRole={user.role === 'owner'}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardHeader
              title={`Owners and admins (${staff.length})`}
              description="Only the owner can grant or revoke the admin role."
            />
            <TableScroll>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {staff.map((p) => (
                  <tr key={p.id}>
                    <Td>
                      {p.preferredName ?? p.fullName ?? p.email}
                      <span className="block wrap-anywhere text-[12px] text-ink-500">
                        {p.email}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={p.role === 'owner' ? 'brand' : 'info'}>{p.role}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={p.status === 'active' ? 'positive' : 'caution'}>
                        {p.status}
                      </Badge>
                    </Td>
                    <Td>
                      {p.role === 'owner' ? (
                        <span className="text-[12px] text-ink-500">
                          Owners are managed server-side
                        </span>
                      ) : (
                        <PersonActions
                          userId={p.id}
                          active={p.status === 'active'}
                          role="admin"
                          canChangeRole={user.role === 'owner'}
                        />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          </Card>
        </div>
      </div>
    </>
  );
}
