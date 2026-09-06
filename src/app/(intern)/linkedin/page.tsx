import Link from 'next/link';
import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { listProspects, prospectCounters, PROSPECT_STATUS_LABELS } from '@/lib/services/prospects';
import { formatInstant } from '@/lib/labels';
import { METRIC_DEFINITIONS } from '@/lib/domain/metrics';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  DefinitionNote,
  EmptyState,
  NotAvailable,
  PageHeader,
  SafeLink,
  StatTile,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { AddProspectForm } from '@/components/client/add-prospect-form';
import { ProspectEventButtons } from '@/components/client/prospect-event-buttons';

export const metadata = { title: 'LinkedIn prospects' };
export const dynamic = 'force-dynamic';

export default async function LinkedInPage() {
  const user = await requireIntern();

  const { prospects, counters, assignedOrgs } = await asUser(user.id, async (tx) => ({
    prospects: await listProspects(tx, { createdBy: user.id }),
    counters: await prospectCounters(tx, user.id),
    assignedOrgs: await tx<{ id: string; name: string; state: string | null }[]>`
      SELECT o.id, o.name, o.state
      FROM organization_assignments a
      JOIN organizations o ON o.id = a.organization_id
      WHERE a.intern_user_id = ${user.id} AND a.unassigned_at IS NULL AND o.is_archived = false
      ORDER BY o.name
      LIMIT 500`,
  }));

  return (
    <>
      <PageHeader
        title="LinkedIn prospects"
        description="People you have researched. Adding someone here is research — it is not outreach until you record that you actually sent the request."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="Prospects tracked" value={counters.total} />
        <StatTile
          label="Requests sent"
          value={counters.requestsSent}
          tone="brand"
          definition={METRIC_DEFINITIONS.linkedinRequests}
          sub="Counts once per profile"
        />
        <StatTile label="Connections accepted" value={counters.connected} sub="Not outreach" />
        <StatTile
          label="Messages sent"
          value={counters.messagesSent}
          sub="Separate from requests"
        />
        <StatTile label="Replies" value={counters.replied} />
      </div>

      <Card className="mb-5">
        <CardHeader
          title="Add a prospect"
          description="Requires a full name, a valid LinkedIn profile link, and an organization."
        />
        <CardBody>
          <AddProspectForm
            organizations={assignedOrgs.map((o) => ({
              id: o.id,
              label: `${o.name}${o.state ? ` (${o.state})` : ''}`,
            }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Your prospects"
          description="Each stage is a separate event with its own history."
        />
        {prospects.length === 0 ? (
          <EmptyState
            title="No prospects yet"
            description="Research a decision-maker at one of your clubs, add their profile here, then record the request once you have actually sent it."
          />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Organization</Th>
                <Th>Status</Th>
                <Th numeric>Messages</Th>
                <Th>Request sent</Th>
                <Th>Record</Th>
              </tr>
            </thead>
            <tbody>
              {prospects.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <span className="font-medium text-ink-900">{p.fullName}</span>
                    {p.title ? (
                      <span className="block text-[12px] text-ink-500">{p.title}</span>
                    ) : null}
                    <SafeLink href={p.profileUrl} className="text-[12px]">
                      LinkedIn profile
                    </SafeLink>
                  </Td>
                  <Td>
                    <Link
                      href={`/leads/${p.organizationId}`}
                      className="text-ink-900 hover:text-brand-600"
                    >
                      {p.organizationName}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={p.status === 'not_contacted' ? 'neutral' : 'info'}>
                      {PROSPECT_STATUS_LABELS[p.status]}
                    </Badge>
                  </Td>
                  <Td numeric>{p.messagesSent}</Td>
                  <Td className="whitespace-nowrap">
                    {p.requestSentAt ? (
                      formatInstant(p.requestSentAt, user.timezone, { timeStyle: undefined })
                    ) : (
                      <NotAvailable label="Not sent" />
                    )}
                  </Td>
                  <Td>
                    <ProspectEventButtons
                      prospectId={p.id}
                      requestSent={p.requestSentAt !== null}
                      connected={p.connectedAt !== null}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
        <CardBody className="border-t border-ink-100">
          <DefinitionNote>
            A connection request counts once per profile, ever — recording it twice is rejected.
            Accepted connections and later messages are tracked as their own events and do not add
            to the weekly request target.
          </DefinitionNote>
        </CardBody>
      </Card>
    </>
  );
}
