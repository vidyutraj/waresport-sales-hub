import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { loadAdminDashboard } from '@/lib/queries/admin-dashboard';
import {
  listMeetings,
  listPayouts,
  MEETING_STATUS_LABELS,
  OUTREACH_CHANNEL_LABELS,
} from '@/lib/services/meetings';
import {
  formatCents,
  MEETINGS_PER_MILESTONE,
  unpaidMilestoneIndices,
} from '@/lib/domain/compensation';
import { METRIC_DEFINITIONS } from '@/lib/domain/metrics';
import { formatDateOnly, formatInstant } from '@/lib/labels';
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
  SafeLink,
  StatTile,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { MeetingReviewControls } from '@/components/client/meeting-review-controls';
import { BookingApprovalControls } from '@/components/client/booking-approval-controls';
import { PayoutForm } from '@/components/client/payout-form';

export const metadata = { title: 'Meetings & payouts' };
export const dynamic = 'force-dynamic';

export default async function AdminMeetingsPage() {
  const user = await requireAdmin();
  const dashboard = await loadAdminDashboard(user.id);

  const { approvals, pending, scheduled, settled, payouts, adjustments } = await asUser(
    user.id,
    async (tx) => ({
      approvals: await listMeetings(tx, { status: 'pending_approval', limit: 200 }),
      pending: await listMeetings(tx, { status: 'pending_verification', limit: 200 }),
      scheduled: await listMeetings(tx, { status: 'scheduled', limit: 100 }),
      settled: await listMeetings(tx, { status: 'verified_held', limit: 100 }),
      payouts: await listPayouts(tx, { cohortId: dashboard.cohort?.id ?? null }),
      adjustments: await tx<
        { id: string; user_name: string; amount_cents: number; reason: string; created_at: Date }[]
      >`
      SELECT a.id, coalesce(u.preferred_name, u.full_name, u.email::text) AS user_name,
             a.amount_cents, a.reason, a.created_at
      FROM payout_adjustments a
      JOIN users u ON u.id = a.user_id
      WHERE a.resolved_at IS NULL
      ORDER BY a.created_at DESC`,
    }),
  );

  const interns = dashboard.interns;

  return (
    <>
      <PageHeader
        title="Meetings & payouts"
        description="Approve meetings interns have booked, verify that they actually took place, then record the manual payments you have made."
        actions={<LinkButton href="/api/exports/payouts">Export payout ledger</LinkButton>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Awaiting approval"
          value={approvals.length}
          tone={approvals.length > 0 ? 'caution' : 'positive'}
        />
        <StatTile
          label="Awaiting verification"
          value={pending.length}
          tone={pending.length > 0 ? 'caution' : 'positive'}
        />
        <StatTile
          label="Verified held (cohort)"
          value={dashboard.totals.verifiedHeld}
          definition={METRIC_DEFINITIONS.verifiedHeld}
        />
        <StatTile
          label="Earned across cohort"
          value={formatCents(dashboard.totals.earnedCents)}
          tone="positive"
        />
        <StatTile label="Recorded as paid" value={formatCents(dashboard.totals.paidCents)} />
      </div>

      {adjustments.length > 0 ? (
        <Alert tone="caution" className="mb-5" title="Reconciliation needed">
          <p className="mb-1">
            A verification was reversed after a payout had already been recorded. The payment record
            is intentionally preserved; settle the difference outside this system, then note it.
          </p>
          <ul className="mt-1 grid gap-0.5">
            {adjustments.map((a) => (
              <li key={a.id}>
                {a.user_name}: {formatCents(a.amount_cents)} — {a.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card className="mb-5">
        <CardHeader
          title={`Booking approvals (${approvals.length})`}
          description="Meetings interns have logged as booked. Approving schedules them; they still earn nothing until held and verified."
        />
        {approvals.length === 0 ? (
          <EmptyState
            title="Nothing to approve"
            description="Meetings interns log as booked appear here."
          />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Meeting with</Th>
                <Th>Intern</Th>
                <Th>When</Th>
                <Th>Reached via</Th>
                <Th>What they know</Th>
                <Th>Decision</Th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <span className="font-medium text-ink-900">
                      {m.contactName ?? m.organizationName}
                    </span>
                    {m.organizationId && m.contactName ? (
                      <Link
                        href={`/admin/leads/${m.organizationId}`}
                        className="block text-[12px] text-ink-500 hover:text-brand-600"
                      >
                        {m.organizationName}
                      </Link>
                    ) : null}
                    {m.meetingLink ? (
                      <SafeLink
                        href={m.meetingLink}
                        className="block text-[12px] text-brand-600 underline"
                      >
                        Meeting link
                      </SafeLink>
                    ) : null}
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/interns/${m.creditedUserId}`}
                      className="text-ink-900 hover:text-brand-600"
                    >
                      {m.creditedUserName}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatInstant(m.scheduledStartAt, m.scheduledTimezone)}
                  </Td>
                  <Td>
                    {m.outreachChannel ? (
                      OUTREACH_CHANNEL_LABELS[m.outreachChannel]
                    ) : (
                      <NotAvailable label="—" />
                    )}
                  </Td>
                  <Td className="wrap-anywhere max-w-sm">
                    {m.background ?? m.notes ?? <NotAvailable label="—" />}
                  </Td>
                  <Td>
                    <BookingApprovalControls meetingId={m.id} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Card>

      <Card className="mb-5">
        <CardHeader
          title={`Verification queue (${pending.length})`}
          description="An intern has submitted these as held. Only an admin or owner can confirm."
        />
        {pending.length === 0 ? (
          <EmptyState
            title="Nothing to review"
            description="Submitted meetings appear here for confirmation."
          />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Meeting with</Th>
                <Th>Credited intern</Th>
                <Th>Held at</Th>
                <Th>Notes</Th>
                <Th>Decision</Th>
              </tr>
            </thead>
            <tbody>
              {pending.map((m) => (
                <tr key={m.id}>
                  <Td>
                    {m.organizationId ? (
                      <Link
                        href={`/admin/leads/${m.organizationId}`}
                        className="font-medium text-ink-900 hover:text-brand-600"
                      >
                        {m.organizationName}
                      </Link>
                    ) : (
                      <span className="font-medium text-ink-900">{m.contactName}</span>
                    )}
                    {m.duplicateClubFlag ? (
                      <Badge tone="caution" className="mt-1 block w-fit">
                        This club already has a verified meeting — check it is not a duplicate
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/interns/${m.creditedUserId}`}
                      className="text-ink-900 hover:text-brand-600"
                    >
                      {m.creditedUserName}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {m.heldAt
                      ? formatInstant(m.heldAt, dashboard.cohort?.reportingTimezone ?? 'UTC')
                      : '—'}
                  </Td>
                  <Td className="wrap-anywhere max-w-sm">
                    {m.notes ?? <NotAvailable label="—" />}
                  </Td>
                  <Td>
                    <MeetingReviewControls
                      meetingId={m.id}
                      interns={interns.map((i) => ({ id: i.userId, name: i.name }))}
                      canRevert={false}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
        <CardBody className="border-t border-ink-100">
          <DefinitionNote>
            Verifying counts the meeting toward the credited intern&apos;s $100 milestones when its
            held date falls inside their cohort. Approving a meeting held outside that window
            requires an explicit reason, which is stored as an exception.
          </DefinitionNote>
        </CardBody>
      </Card>

      <Card className="mb-5">
        <CardHeader
          title="Payout ledger"
          description="Records of manual payments. Nothing here transfers money."
        />
        {interns.length === 0 ? (
          <EmptyState title="No interns in this cohort" />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Intern</Th>
                <Th numeric>Verified held</Th>
                <Th numeric>Earned</Th>
                <Th numeric>Paid</Th>
                <Th numeric>Balance</Th>
                <Th>Record a payment</Th>
              </tr>
            </thead>
            <tbody>
              {interns.map((i) => {
                const unpaid = unpaidMilestoneIndices(
                  i.compensation.earnedMilestones,
                  i.paidMilestoneIndices,
                );
                return (
                  <tr key={i.userId}>
                    <Td>
                      <Link
                        href={`/admin/interns/${i.userId}`}
                        className="font-medium text-ink-900 hover:text-brand-600"
                      >
                        {i.name}
                      </Link>
                    </Td>
                    <Td numeric>
                      {i.verifiedHeld}
                      <span className="block text-[11px] text-ink-500">
                        {i.compensation.progressTowardNext}/{MEETINGS_PER_MILESTONE} to next
                      </span>
                    </Td>
                    <Td numeric>{formatCents(i.compensation.earnedCents)}</Td>
                    <Td numeric>{formatCents(i.compensation.paidCents)}</Td>
                    <Td numeric>
                      {i.compensation.overpaidCents > 0 ? (
                        <span className="text-caution-700">
                          {formatCents(-i.compensation.overpaidCents)}
                        </span>
                      ) : (
                        formatCents(i.compensation.balanceCents)
                      )}
                    </Td>
                    <Td>
                      {unpaid.length === 0 ? (
                        <span className="text-[12px] text-ink-500">
                          {i.compensation.earnedMilestones === 0
                            ? 'Nothing earned yet'
                            : 'All earned milestones recorded'}
                        </span>
                      ) : dashboard.cohort ? (
                        <PayoutForm
                          userId={i.userId}
                          cohortId={dashboard.cohort.id}
                          unpaidMilestones={unpaid}
                        />
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableScroll>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={`Verified meetings (${settled.length})`}
            description="Reversible with a reason."
          />
          {settled.length === 0 ? (
            <EmptyState title="None yet" />
          ) : (
            <TableScroll>
              <thead>
                <tr>
                  <Th>Meeting with</Th>
                  <Th>Intern</Th>
                  <Th>Held</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {settled.map((m) => (
                  <tr key={m.id}>
                    <Td>{m.organizationName ?? m.contactName}</Td>
                    <Td>{m.creditedUserName}</Td>
                    <Td className="whitespace-nowrap">
                      {m.heldAt ? formatInstant(m.heldAt, 'UTC', { timeStyle: undefined }) : '—'}
                      {m.eligibilityOverride ? (
                        <Badge tone="caution" className="ml-1">
                          Exception
                        </Badge>
                      ) : null}
                    </Td>
                    <Td>
                      <MeetingReviewControls
                        meetingId={m.id}
                        interns={interns.map((i) => ({ id: i.userId, name: i.name }))}
                        canRevert
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          )}
        </Card>

        <Card>
          <CardHeader title={`Scheduled (${scheduled.length})`} description="Not yet held." />
          {scheduled.length === 0 ? (
            <EmptyState title="None scheduled" />
          ) : (
            <TableScroll>
              <thead>
                <tr>
                  <Th>Meeting with</Th>
                  <Th>Intern</Th>
                  <Th>Scheduled</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {scheduled.map((m) => (
                  <tr key={m.id}>
                    <Td>{m.organizationName ?? m.contactName}</Td>
                    <Td>{m.creditedUserName}</Td>
                    <Td className="whitespace-nowrap">
                      {formatInstant(m.scheduledStartAt, m.scheduledTimezone)}
                    </Td>
                    <Td>
                      <Badge tone="neutral">{MEETING_STATUS_LABELS[m.status]}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          )}
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader title="Recorded payments" description="Every entry, including voided ones." />
        {payouts.length === 0 ? (
          <EmptyState title="No payments recorded" />
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Intern</Th>
                <Th>Milestone</Th>
                <Th numeric>Amount</Th>
                <Th>Paid on</Th>
                <Th>Reference</Th>
                <Th>Recorded by</Th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id} className={p.voidedAt ? 'opacity-60' : undefined}>
                  <Td>{p.userName}</Td>
                  <Td>
                    #{p.milestoneIndex}
                    {p.voidedAt ? (
                      <Badge tone="caution" className="ml-2">
                        Voided
                      </Badge>
                    ) : null}
                  </Td>
                  <Td numeric>{formatCents(p.amountCents)}</Td>
                  <Td className="whitespace-nowrap">{formatDateOnly(p.paidOn)}</Td>
                  <Td>{p.reference ?? <NotAvailable label="—" />}</Td>
                  <Td>{p.recordedByName}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Card>
    </>
  );
}
