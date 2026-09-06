import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { assignmentHistory, getOrganizationDetail } from '@/lib/queries/leads';
import { recentActivity } from '@/lib/queries/metrics';
import { listMeetings, MEETING_STATUS_LABELS } from '@/lib/services/meetings';
import { listProspects } from '@/lib/services/prospects';
import { ORG_STATUS_LABELS } from '@/lib/services/outreach';
import { listAudit } from '@/lib/services/audit';
import { analysePhone, formatPhone } from '@/lib/domain/phone';
import { analyseUrl } from '@/lib/domain/url';
import { ACTION_LABELS, formatInstant, OUTCOME_LABELS } from '@/lib/labels';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  NotAvailable,
  PageHeader,
  SafeLink,
  StatusBadge,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Admin view of one club.
 *
 * Read-only by design: an admin oversees and reassigns, but does not log
 * outreach on an intern's behalf. Assignment itself is done from the leads
 * table, where it can be previewed in bulk.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAdmin();
  const org = await asUser(user.id, (tx) => getOrganizationDetail(tx, id, user.id));
  return { title: org?.name ?? 'Club' };
}

export default async function AdminLeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAdmin();

  const data = await asUser(user.id, async (tx) => {
    const org = await getOrganizationDetail(tx, id, user.id);
    if (org === null) return null;
    return {
      org,
      timeline: await recentActivity(tx, { organizationId: id, limit: 100 }),
      history: await assignmentHistory(tx, id),
      meetings: (await listMeetings(tx, { limit: 200 })).filter((m) => m.organizationId === id),
      prospects: await listProspects(tx, { organizationId: id }),
      audit: await listAudit(tx, { entityType: 'organization', entityId: id, limit: 20 }),
    };
  });

  if (data === null) notFound();
  const { org, timeline, history, meetings, prospects } = data;
  const sourceUrl = analyseUrl(org.sourceUrl);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/admin/leads" className="hover:text-brand-600">
            ← Leads &amp; imports
          </Link>
        }
        title={org.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{[org.city, org.state].filter(Boolean).join(', ') || 'Location unknown'}</span>
            {org.territoryCode ? (
              <Badge tone="neutral">{org.territoryCode}</Badge>
            ) : (
              <Badge tone="caution">No territory</Badge>
            )}
            {org.sport ? <Badge tone="neutral">{org.sport}</Badge> : null}
            <StatusBadge
              status={org.status}
              label={ORG_STATUS_LABELS[org.status as keyof typeof ORG_STATUS_LABELS] ?? org.status}
            />
          </span>
        }
      />

      <Alert tone="info" className="mb-5">
        Read-only. Outreach is logged by the assigned intern; assignment is done from the leads
        table so bulk changes can be previewed first.
      </Alert>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="grid content-start gap-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Activity timeline"
              description="Every logged action, with its original actor. Reassignment never changes attribution."
            />
            {timeline.length === 0 ? (
              <EmptyState title="No activity logged yet" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>By</Th>
                    <Th>Action</Th>
                    <Th>Outcome</Th>
                    <Th>Notes</Th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((row) => (
                    <tr key={row.id} className={row.voidedAt ? 'bg-ink-50 opacity-70' : undefined}>
                      <Td className="whitespace-nowrap text-ink-600">
                        {formatInstant(row.occurredAt, 'UTC')}
                      </Td>
                      <Td className="whitespace-nowrap">{row.actorName}</Td>
                      <Td className="whitespace-nowrap">
                        {ACTION_LABELS[row.actionType] ?? row.actionType}
                        {row.voidedAt ? (
                          <Badge tone="caution" className="ml-1">
                            Voided
                          </Badge>
                        ) : null}
                      </Td>
                      <Td>{OUTCOME_LABELS[row.outcome] ?? row.outcome}</Td>
                      <Td className="wrap-anywhere max-w-sm">
                        {row.notes ?? <NotAvailable label="—" />}
                        {row.voidedAt ? (
                          <span className="mt-1 block text-[12px] font-medium text-caution-700">
                            Voided: {row.voidReason}
                          </span>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardHeader title="Assignment history" description="Who was responsible, and when." />
            {history.length === 0 ? (
              <EmptyState title="Never assigned" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Intern</Th>
                    <Th>From</Th>
                    <Th>Until</Th>
                    <Th>By</Th>
                    <Th>Reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <Td>
                        <Link
                          href={`/admin/interns/${h.internUserId}`}
                          className="text-ink-900 hover:text-brand-600"
                        >
                          {h.internName}
                        </Link>
                      </Td>
                      <Td className="whitespace-nowrap">{formatInstant(h.assignedAt, 'UTC')}</Td>
                      <Td className="whitespace-nowrap">
                        {h.unassignedAt ? (
                          formatInstant(h.unassignedAt, 'UTC')
                        ) : (
                          <Badge tone="positive">Current</Badge>
                        )}
                      </Td>
                      <Td>{h.assignedByName}</Td>
                      <Td className="wrap-anywhere max-w-xs">
                        {h.reason ?? <NotAvailable label="—" />}
                        {h.territoryOverrideReason ? (
                          <span className="mt-1 block text-[12px] text-caution-700">
                            Territory override: {h.territoryOverrideReason}
                          </span>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardHeader title="Meetings" />
            {meetings.length === 0 ? (
              <EmptyState title="No meetings at this club" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Scheduled</Th>
                    <Th>Credited to</Th>
                    <Th>Status</Th>
                    <Th>Held</Th>
                  </tr>
                </thead>
                <tbody>
                  {meetings.map((m) => (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap">
                        {formatInstant(m.scheduledStartAt, m.scheduledTimezone)}
                      </Td>
                      <Td>{m.creditedUserName}</Td>
                      <Td>
                        <Badge tone={m.status === 'verified_held' ? 'positive' : 'neutral'}>
                          {MEETING_STATUS_LABELS[m.status]}
                        </Badge>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {m.heldAt ? formatInstant(m.heldAt, 'UTC') : <NotAvailable label="—" />}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>
        </div>

        <div className="grid content-start gap-5">
          <Card>
            <CardHeader title="Contacts" description={`${org.contacts.length} on file`} />
            {org.contacts.length === 0 ? (
              <EmptyState
                title="No contacts recorded"
                description="Imported without contact details. Still worth researching."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {org.contacts.map((c) => {
                  const phone = analysePhone(c.phoneRaw);
                  return (
                    <li key={c.id} className="px-4 py-3">
                      <p className="font-medium text-ink-900">
                        {c.fullName ?? <span className="text-ink-500">Name unknown</span>}
                      </p>
                      {c.roleTitle ? (
                        <p className="text-[12px] text-ink-500">{c.roleTitle}</p>
                      ) : null}
                      <p className="mt-1 wrap-anywhere text-[13px]">
                        {c.email && c.emailValid ? c.email : <NotAvailable />}
                      </p>
                      <p className="text-[13px]">
                        {phone.raw ? formatPhone(phone) : <NotAvailable />}
                        {phone.raw && !phone.valid ? (
                          <span className="ml-1 text-[11px] text-caution-700">(unverified)</span>
                        ) : null}
                      </p>
                      {c.suppressedChannels.length > 0 ? (
                        <Badge tone="caution" className="mt-1">
                          Suppressed: {c.suppressedChannels.join(', ')}
                        </Badge>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Club details" />
            <CardBody className="grid gap-3 text-[13px]">
              <Detail label="Assigned to">
                {org.assigneeName ?? <NotAvailable label="Unassigned" />}
              </Detail>
              <Detail label="Source">{org.source ?? <NotAvailable label="—" />}</Detail>
              <Detail label="Source link">
                {sourceUrl.safe ? (
                  <SafeLink href={sourceUrl.href}>{sourceUrl.hostname}</SafeLink>
                ) : org.sourceUrl ? (
                  <span className="wrap-anywhere text-ink-500">
                    {org.sourceUrl}{' '}
                    <span className="text-[11px] text-caution-700">(not a safe link)</span>
                  </span>
                ) : (
                  <NotAvailable label="—" />
                )}
              </Detail>
              <Detail label="Added">{formatInstant(org.createdAt, 'UTC')}</Detail>
              <Detail label="Notes">
                <span className="wrap-anywhere whitespace-pre-wrap">
                  {org.notes ?? <NotAvailable label="—" />}
                </span>
              </Detail>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="LinkedIn prospects" description={`${prospects.length} tracked`} />
            {prospects.length === 0 ? (
              <EmptyState title="None yet" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {prospects.map((p) => (
                  <li key={p.id} className="px-4 py-2.5">
                    <p className="text-[13px] font-medium text-ink-900">{p.fullName}</p>
                    <p className="text-[12px] text-ink-500">
                      {p.title ?? 'Role unknown'} · {p.status.replace(/_/g, ' ')}
                    </p>
                    <SafeLink href={p.profileUrl} className="text-[12px]">
                      Profile
                    </SafeLink>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Audit trail" description="Changes recorded against this club." />
            {data.audit.length === 0 ? (
              <EmptyState title="No audited changes" />
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

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-ink-500">{label}</p>
      <div className="mt-0.5 text-ink-900">{children}</div>
    </div>
  );
}
