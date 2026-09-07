import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { listProspects } from '@/lib/services/prospects';
import { loadInternDashboard } from '@/lib/queries/intern-context';
import { formatInstant } from '@/lib/labels';
import { METRIC_DEFINITIONS } from '@/lib/domain/metrics';
import {
  Card,
  CardBody,
  CardHeader,
  DefinitionNote,
  EmptyState,
  PageHeader,
  ProgressBar,
  SafeLink,
  StatTile,
} from '@/components/ui';
import { LogConnectionForm } from '@/components/client/log-connection-form';
import { ConnectionNotesForm } from '@/components/client/connection-notes-form';

export const metadata = { title: 'LinkedIn' };
export const dynamic = 'force-dynamic';

export default async function LinkedInPage() {
  const user = await requireIntern();
  const dashboard = await loadInternDashboard(user.id);
  const connections = await asUser(user.id, (tx) => listProspects(tx, { createdBy: user.id }));

  const target = dashboard.context.target?.linkedinTarget ?? null;
  const achieved = dashboard.weekTotals.linkedinRequests;

  return (
    <>
      <PageHeader
        title="LinkedIn"
        description="Every time you connect with someone, log them here. Name, profile link, and anything worth remembering."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <StatTile
          label="Connections this week"
          value={achieved}
          tone="brand"
          definition={METRIC_DEFINITIONS.linkedinRequests}
          sub={target !== null ? `Target ${target}` : undefined}
        />
        <StatTile label="People logged in total" value={connections.length} />
      </div>

      {target !== null && target > 0 ? (
        <Card className="mb-5">
          <CardBody>
            <ProgressBar label="This week" value={achieved} max={target} tone="brand" />
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader
            title="Log a connection"
            description="After you have connected and sent your message."
          />
          <CardBody>
            <LogConnectionForm />
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title={`Your connections (${connections.length})`}
            description="Newest first. Notes are yours to edit at any time."
          />
          {connections.length === 0 ? (
            <EmptyState
              title="No connections logged yet"
              description="Connect with someone on LinkedIn, then log them with the form."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {connections.map((c) => (
                <li key={c.id} className="px-4 py-3 sm:px-5">
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="font-medium text-ink-900">{c.fullName}</p>
                    <span className="text-[12px] whitespace-nowrap text-ink-500">
                      {formatInstant(c.createdAt, user.timezone, { dateStyle: 'medium' })}
                    </span>
                  </div>
                  <SafeLink
                    href={c.profileUrl}
                    className="mb-2 block truncate text-[12px] text-brand-600 underline"
                  >
                    {c.profileUrl}
                  </SafeLink>
                  <ConnectionNotesForm prospectId={c.id} name={c.fullName} notes={c.notes} />
                </li>
              ))}
            </ul>
          )}
          <CardBody className="border-t border-ink-100">
            <DefinitionNote>
              Each profile counts once toward your weekly target, however many times you message
              them. Logging someone already in your list tells you so rather than counting again.
            </DefinitionNote>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
