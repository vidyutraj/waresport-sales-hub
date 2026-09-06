import Link from 'next/link';
import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { loadInternContext } from '@/lib/queries/intern-context';
import { listFollowUps, type FollowUpBucket } from '@/lib/services/outreach';
import { FOLLOW_UP_BUCKET_LABELS, formatDateOnly } from '@/lib/labels';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { FollowUpControls } from '@/components/client/follow-up-controls';

export const metadata = { title: 'Follow-ups' };
export const dynamic = 'force-dynamic';

const ORDER: FollowUpBucket[] = ['overdue', 'due_today', 'upcoming', 'snoozed', 'completed'];

const BUCKET_TONES: Record<FollowUpBucket, 'caution' | 'brand' | 'neutral' | 'info' | 'positive'> =
  {
    overdue: 'caution',
    due_today: 'brand',
    upcoming: 'neutral',
    snoozed: 'info',
    completed: 'positive',
  };

export default async function FollowUpsPage() {
  const user = await requireIntern();

  const { rows, today } = await asUser(user.id, async (tx) => {
    const context = await loadInternContext(tx, user.id);
    return {
      today: context.todayReporting,
      rows: await listFollowUps(tx, {
        assignedUserId: user.id,
        today: context.todayReporting,
      }),
    };
  });

  const grouped = new Map<FollowUpBucket, typeof rows>();
  for (const bucket of ORDER) grouped.set(bucket, []);
  for (const row of rows) grouped.get(row.bucket)?.push(row);

  const openCount = rows.filter((r) => r.bucket === 'overdue' || r.bucket === 'due_today').length;

  return (
    <>
      <PageHeader
        title="Follow-ups"
        description={
          <>
            Persisted in the workspace and shown here — no email reminders are sent.{' '}
            {openCount > 0 ? (
              <strong>
                {openCount} need{openCount === 1 ? 's' : ''} attention today.
              </strong>
            ) : (
              'Nothing needs attention today.'
            )}
          </>
        }
      />

      <div className="grid gap-5">
        {ORDER.map((bucket) => {
          const items = grouped.get(bucket) ?? [];
          return (
            <Card key={bucket}>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    {FOLLOW_UP_BUCKET_LABELS[bucket] ?? bucket}
                    <Badge tone={BUCKET_TONES[bucket]}>{items.length}</Badge>
                  </span>
                }
                description={
                  bucket === 'overdue'
                    ? `Due before ${formatDateOnly(today)}.`
                    : bucket === 'due_today'
                      ? `Due ${formatDateOnly(today)}.`
                      : undefined
                }
              />
              {items.length === 0 ? (
                <EmptyState
                  title={`Nothing ${(FOLLOW_UP_BUCKET_LABELS[bucket] ?? bucket).toLowerCase()}`}
                />
              ) : (
                <TableScroll>
                  <thead>
                    <tr>
                      <Th>Club</Th>
                      <Th>Contact</Th>
                      <Th>Due</Th>
                      <Th>Notes</Th>
                      <Th>Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <Td>
                          <Link
                            href={`/leads/${item.organizationId}`}
                            className="font-medium text-ink-900 hover:text-brand-600"
                          >
                            {item.organizationName}
                          </Link>
                        </Td>
                        <Td>{item.contactName ?? <span className="text-ink-400">—</span>}</Td>
                        <Td className="whitespace-nowrap">{formatDateOnly(item.dueOn)}</Td>
                        <Td className="wrap-anywhere max-w-sm">
                          {item.notes ?? <span className="text-ink-400">—</span>}
                        </Td>
                        <Td>
                          {bucket === 'completed' ? (
                            <span className="text-[12px] text-ink-500">Done</span>
                          ) : (
                            <FollowUpControls followUpId={item.id} snoozed={bucket === 'snoozed'} />
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </TableScroll>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
