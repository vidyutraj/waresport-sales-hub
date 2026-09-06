import Link from 'next/link';
import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { loadInternContext } from '@/lib/queries/intern-context';
import { compensationFor } from '@/lib/queries/metrics';
import { listMeetings, listPayouts, MEETING_STATUS_LABELS } from '@/lib/services/meetings';
import { formatCents, MEETINGS_PER_MILESTONE, milestoneHeadline } from '@/lib/domain/compensation';
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
  NotAvailable,
  PageHeader,
  ProgressBar,
  StatTile,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { SubmitHeldForm } from '@/components/client/submit-held-form';

export const metadata = { title: 'Meetings & earnings' };
export const dynamic = 'force-dynamic';

export default async function MeetingsPage() {
  const user = await requireIntern();

  const data = await asUser(user.id, async (tx) => {
    const context = await loadInternContext(tx, user.id);
    return {
      context,
      meetings: await listMeetings(tx, { creditedUserId: user.id, limit: 200 }),
      payouts: await listPayouts(tx, { userId: user.id, cohortId: context.cohort?.id ?? null }),
      compensation:
        context.cohort && context.cohortRange
          ? await compensationFor(tx, {
              userId: user.id,
              cohortId: context.cohort.id,
              cohortRange: context.cohortRange,
            })
          : null,
    };
  });

  const { context, meetings, payouts, compensation } = data;
  const upcoming = meetings.filter((m) => m.status === 'scheduled');
  const pending = meetings.filter((m) => m.status === 'pending_verification');
  const settled = meetings.filter(
    (m) => m.status === 'verified_held' || m.status === 'cancelled' || m.status === 'no_show',
  );

  return (
    <>
      <PageHeader
        title="Meetings & earnings"
        description="Every 10 meetings that are booked and actually take place earn $100. Your total builds across the whole internship and never resets."
      />

      {compensation === null ? (
        <Alert tone="caution">
          You are not in a cohort yet, so there is nothing to earn against.
        </Alert>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Verified held meetings"
              value={compensation.verifiedHeldCount}
              definition={METRIC_DEFINITIONS.verifiedHeld}
            />
            <StatTile
              label="Earned"
              value={formatCents(compensation.earnedCents)}
              tone="positive"
              sub={`${compensation.earnedMilestones} milestone${compensation.earnedMilestones === 1 ? '' : 's'} of $100`}
            />
            <StatTile
              label="Recorded as paid"
              value={formatCents(compensation.paidCents)}
              sub="Manual payments recorded by an admin"
            />
            <StatTile
              label={compensation.overpaidCents > 0 ? 'Overpaid — reconciling' : 'Unpaid balance'}
              value={
                compensation.overpaidCents > 0
                  ? formatCents(-compensation.overpaidCents)
                  : formatCents(compensation.balanceCents)
              }
              tone={compensation.overpaidCents > 0 ? 'caution' : 'brand'}
            />
          </div>

          <Card className="mb-5">
            <CardHeader
              title="Progress to your next $100"
              description={milestoneHeadline(compensation)}
            />
            <CardBody>
              <div className="flex items-baseline justify-between text-[13px]">
                <span className="text-ink-600">
                  {compensation.progressTowardNext} of {MEETINGS_PER_MILESTONE} toward milestone{' '}
                  {compensation.nextMilestoneIndex}
                </span>
                <span className="tabular font-medium text-ink-900">
                  {compensation.meetingsUntilNextMilestone} to go
                </span>
              </div>
              <div className="mt-2">
                <ProgressBar
                  value={compensation.progressTowardNext}
                  max={MEETINGS_PER_MILESTONE}
                  label={`Progress toward milestone ${compensation.nextMilestoneIndex}`}
                  tone="positive"
                />
              </div>
              {compensation.pendingVerificationCount > 0 ? (
                <p className="mt-3 text-[13px] text-caution-700">
                  {compensation.pendingVerificationCount} meeting
                  {compensation.pendingVerificationCount === 1 ? '' : 's'} awaiting admin
                  verification. Pending meetings are worth nothing until verified.
                </p>
              ) : null}
              {compensation.overpaidCents > 0 ? (
                <Alert tone="caution" className="mt-3" title="A payout needs reconciling">
                  A verification was reversed after {formatCents(compensation.paidCents)} had
                  already been recorded as paid. The payment record is kept; an admin will resolve
                  the {formatCents(compensation.overpaidCents)} difference separately.
                </Alert>
              ) : null}
              <DefinitionNote>
                Only meetings an admin has verified as actually held count. Scheduled, pending,
                cancelled and no-show meetings are worth nothing. Rescheduling updates the same
                meeting rather than creating a second payable one.
              </DefinitionNote>
            </CardBody>
          </Card>
        </>
      )}

      <div className="grid gap-5">
        <MeetingTable
          title="Awaiting verification"
          description="You have submitted these as held. An admin decides."
          rows={pending}
          userTimezone={user.timezone}
          showSubmit={false}
        />
        <MeetingTable
          title="Upcoming"
          description="Once a meeting has taken place, submit it for verification."
          rows={upcoming}
          userTimezone={user.timezone}
          showSubmit
        />
        <MeetingTable
          title="Settled"
          description="Verified, cancelled and no-show meetings."
          rows={settled}
          userTimezone={user.timezone}
          showSubmit={false}
        />

        <Card>
          <CardHeader
            title="Payout ledger"
            description="Records of manual payments. Nothing here transfers money."
          />
          {payouts.length === 0 ? (
            <EmptyState
              title="No payouts recorded"
              description={
                context.cohort
                  ? 'A milestone appears here once an admin records that it has been paid.'
                  : undefined
              }
            />
          ) : (
            <TableScroll>
              <thead>
                <tr>
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
      </div>
    </>
  );
}

function MeetingTable({
  title,
  description,
  rows,
  userTimezone,
  showSubmit,
}: {
  title: string;
  description: string;
  rows: Awaited<ReturnType<typeof listMeetings>>;
  userTimezone: string;
  showSubmit: boolean;
}) {
  return (
    <Card>
      <CardHeader title={`${title} (${rows.length})`} description={description} />
      {rows.length === 0 ? (
        <EmptyState title={`No ${title.toLowerCase()} meetings`} />
      ) : (
        <TableScroll>
          <thead>
            <tr>
              <Th>Club</Th>
              <Th>Scheduled</Th>
              <Th>Status</Th>
              <Th>Held</Th>
              {showSubmit ? <Th>Actions</Th> : <Th>Notes</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <Td>
                  <Link
                    href={`/leads/${m.organizationId}`}
                    className="font-medium text-ink-900 hover:text-brand-600"
                  >
                    {m.organizationName}
                  </Link>
                  {m.contactName ? (
                    <span className="block text-[12px] text-ink-500">{m.contactName}</span>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap">
                  {formatInstant(m.scheduledStartAt, m.scheduledTimezone)}
                </Td>
                <Td>
                  <Badge
                    tone={
                      m.status === 'verified_held'
                        ? 'positive'
                        : m.status === 'pending_verification'
                          ? 'caution'
                          : 'neutral'
                    }
                  >
                    {MEETING_STATUS_LABELS[m.status]}
                  </Badge>
                  {m.rejectionReason ? (
                    <span className="mt-1 block text-[12px] text-caution-700">
                      Returned: {m.rejectionReason}
                    </span>
                  ) : null}
                </Td>
                <Td className="whitespace-nowrap">
                  {m.heldAt ? formatInstant(m.heldAt, userTimezone) : <NotAvailable label="—" />}
                </Td>
                <Td>
                  {showSubmit ? (
                    <SubmitHeldForm meetingId={m.id} timezone={userTimezone} />
                  ) : (
                    (m.notes ?? <NotAvailable label="—" />)
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableScroll>
      )}
    </Card>
  );
}
