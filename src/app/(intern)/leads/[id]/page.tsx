import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { getOrganizationDetail } from '@/lib/queries/leads';
import { recentActivity } from '@/lib/queries/metrics';
import { loadInternContext } from '@/lib/queries/intern-context';
import { listMeetings } from '@/lib/services/meetings';
import { ORG_STATUS_LABELS } from '@/lib/services/outreach';
import { analysePhone, formatPhone, telHref } from '@/lib/domain/phone';
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
import { LogOutreachPanel } from '@/components/client/log-outreach-panel';
import { StatusPicker } from '@/components/client/status-picker';
import { VoidActivityButton } from '@/components/client/void-activity-button';
import { CopyButton } from '@/components/client/copy-button';
import { BookMeetingForm } from '@/components/client/book-meeting-form';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireIntern();
  const org = await asUser(user.id, (tx) => getOrganizationDetail(tx, id, user.id));
  return { title: org?.name ?? 'Club' };
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireIntern();

  const data = await asUser(user.id, async (tx) => {
    const org = await getOrganizationDetail(tx, id, user.id);
    if (org === null) return null;
    return {
      org,
      timeline: await recentActivity(tx, { organizationId: id, limit: 50 }),
      meetings: await listMeetings(tx, { creditedUserId: user.id, limit: 20 }),
      context: await loadInternContext(tx, user.id),
    };
  });

  // RLS returns nothing for a club this intern neither owns nor worked on, so a
  // forged id is indistinguishable from a club that does not exist.
  if (data === null) notFound();
  const { org, timeline, meetings, context } = data;

  const owned = org.assigneeId === user.id;
  const orgMeetings = meetings.filter((m) => m.organizationId === org.id);
  const sourceUrl = analyseUrl(org.sourceUrl);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/leads" className="hover:text-brand-600">
            ← My leads
          </Link>
        }
        title={org.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{[org.city, org.state].filter(Boolean).join(', ') || 'Location unknown'}</span>
            {org.territoryCode ? <Badge tone="neutral">{org.territoryCode}</Badge> : null}
            {org.sport ? <Badge tone="neutral">{org.sport}</Badge> : null}
            <StatusBadge
              status={org.status}
              label={ORG_STATUS_LABELS[org.status as keyof typeof ORG_STATUS_LABELS] ?? org.status}
            />
          </span>
        }
      />

      {!owned ? (
        <Alert tone="caution" className="mb-5" title="You no longer own this club">
          Another intern is responsible for it now. Your own past contributions stay visible below
          and still count toward your totals, but the club&apos;s current contact details are not
          available to you.
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="grid gap-5 lg:col-span-2">
          {/* ---- Log outreach: the most prominent action on the page ---- */}
          {owned ? (
            <Card>
              <CardHeader
                title="Log outreach"
                description="Send the message from your own Waresport mailbox or LinkedIn first, then record it here."
              />
              <CardBody>
                <LogOutreachPanel
                  organizationId={org.id}
                  contacts={org.contacts.map((c) => ({
                    id: c.id,
                    label: c.fullName ?? c.email ?? c.roleTitle ?? 'Unnamed contact',
                    suppressedChannels: c.suppressedChannels,
                  }))}
                  timezone={user.timezone}
                  inProgram={context.week !== null}
                />
              </CardBody>
            </Card>
          ) : null}

          {/* ---- Timeline ------------------------------------------------ */}
          <Card>
            <CardHeader
              title="Activity timeline"
              description="Every logged action on this club, including work by previous owners. Each entry keeps its original actor."
            />
            {timeline.length === 0 ? (
              <EmptyState
                title="No activity yet"
                description="Nothing has been logged against this club."
              />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Action</Th>
                    <Th>By</Th>
                    <Th>Outcome</Th>
                    <Th>Notes</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((row) => (
                    <tr key={row.id} className={row.voidedAt ? 'bg-ink-50 opacity-70' : undefined}>
                      <Td className="whitespace-nowrap text-ink-600">
                        {formatInstant(row.occurredAt, user.timezone, { timeStyle: 'short' })}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {ACTION_LABELS[row.actionType] ?? row.actionType}
                        {row.voidedAt ? (
                          <Badge tone="caution" className="ml-1">
                            Voided
                          </Badge>
                        ) : null}
                        {row.correctedFromId ? (
                          <Badge tone="info" className="ml-1">
                            Correction
                          </Badge>
                        ) : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {row.actorUserId === user.id ? 'You' : row.actorName}
                      </Td>
                      <Td>{OUTCOME_LABELS[row.outcome] ?? row.outcome}</Td>
                      <Td className="wrap-anywhere max-w-sm">
                        {row.notes ?? <NotAvailable label="—" />}
                        {row.evidenceUrl ? (
                          <span className="mt-1 block">
                            <SafeLink href={analyseUrl(row.evidenceUrl).href}>
                              Reference link
                            </SafeLink>
                          </span>
                        ) : null}
                        {row.voidedAt ? (
                          <span className="mt-1 block text-[12px] font-medium text-caution-700">
                            Voided: {row.voidReason}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        {row.actorUserId === user.id && row.voidedAt === null ? (
                          <VoidActivityButton activityId={row.id} organizationId={org.id} />
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          {/* ---- Meetings ------------------------------------------------- */}
          <Card>
            <CardHeader
              title="Meetings at this club"
              description="Booking a meeting records an intention; only an admin-verified held meeting earns credit."
            />
            {orgMeetings.length === 0 ? (
              <EmptyState title="No meetings yet" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Scheduled</Th>
                    <Th>Status</Th>
                    <Th>Credited to</Th>
                    <Th>Held</Th>
                  </tr>
                </thead>
                <tbody>
                  {orgMeetings.map((m) => (
                    <tr key={m.id}>
                      <Td className="whitespace-nowrap">
                        {formatInstant(m.scheduledStartAt, m.scheduledTimezone)}
                      </Td>
                      <Td>
                        <Badge tone={m.status === 'verified_held' ? 'positive' : 'neutral'}>
                          {m.status.replace(/_/g, ' ')}
                        </Badge>
                      </Td>
                      <Td>{m.creditedUserId === user.id ? 'You' : m.creditedUserName}</Td>
                      <Td className="whitespace-nowrap">
                        {m.heldAt ? (
                          formatInstant(m.heldAt, user.timezone)
                        ) : (
                          <NotAvailable label="—" />
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
            {owned ? (
              <CardBody className="border-t border-ink-100">
                <BookMeetingForm
                  organizationId={org.id}
                  contacts={org.contacts.map((c) => ({
                    id: c.id,
                    label: c.fullName ?? c.email ?? 'Unnamed contact',
                  }))}
                  timezone={user.timezone}
                />
              </CardBody>
            ) : null}
          </Card>
        </div>

        {/* ---- Sidebar --------------------------------------------------- */}
        <div className="grid content-start gap-5">
          <Card>
            <CardHeader title="Contacts" description={`${org.contacts.length} on file`} />
            {org.contacts.length === 0 ? (
              <EmptyState
                title={owned ? 'No contacts recorded' : 'Contacts not available'}
                description={
                  owned
                    ? 'This club was imported without contact details. It is still worth researching.'
                    : 'Only the current owner of a club can see its contact details.'
                }
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {org.contacts.map((c) => {
                  const phone = analysePhone(c.phoneRaw);
                  const tel = telHref(phone);
                  return (
                    <li key={c.id} className="px-4 py-3">
                      <p className="font-medium text-ink-900">
                        {c.fullName ?? <span className="text-ink-500">Name unknown</span>}
                      </p>
                      {c.roleTitle ? (
                        <p className="text-[12px] text-ink-500">{c.roleTitle}</p>
                      ) : null}

                      <div className="mt-2 grid gap-1.5 text-[13px]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-ink-500">Email</span>
                          {c.email && c.emailValid ? (
                            <>
                              <span className="wrap-anywhere text-ink-900">{c.email}</span>
                              <CopyButton value={c.email} label="Copy email" />
                              <a
                                href={`mailto:${encodeURIComponent(c.email)}`}
                                className="text-[12px] text-brand-600 underline"
                              >
                                Compose
                              </a>
                            </>
                          ) : (
                            <NotAvailable />
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-ink-500">Phone</span>
                          {phone.raw ? (
                            <>
                              <span className="text-ink-900">{formatPhone(phone)}</span>
                              <CopyButton value={phone.raw} label="Copy phone" />
                              {tel ? (
                                <a href={tel} className="text-[12px] text-brand-600 underline">
                                  Call
                                </a>
                              ) : (
                                <span className="text-[11px] text-caution-700">
                                  Not verified as dialable
                                </span>
                              )}
                            </>
                          ) : (
                            <NotAvailable />
                          )}
                        </div>
                      </div>

                      {c.suppressedChannels.length > 0 ? (
                        <Alert tone="caution" className="mt-2">
                          Outreach suppressed ({c.suppressedChannels.join(', ')}). An admin must
                          lift this before you can log to this contact again.
                        </Alert>
                      ) : null}

                      <p className="mt-2 text-[11px] text-ink-400">
                        Composing opens your own mail client. Sending is not tracked — log it here
                        afterwards.
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {owned ? (
            <Card>
              <CardHeader title="Workflow status" description="A summary label, not a metric." />
              <CardBody>
                <StatusPicker
                  organizationId={org.id}
                  current={org.status}
                  rowVersion={org.rowVersion}
                />
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Club details" />
            <CardBody className="grid gap-3 text-[13px]">
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
              <Detail label="Assigned to">
                {org.assigneeName ?? <NotAvailable label="Unassigned" />}
              </Detail>
              <Detail label="Notes">
                <span className="wrap-anywhere">{org.notes ?? <NotAvailable label="—" />}</span>
              </Detail>
            </CardBody>
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
