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

  const thisWeek = dashboard.weekTotals.linkedinConnections;

  return (
    <>
      <PageHeader
        title="LinkedIn"
        description="Every time someone accepts your connection request, log them here. There is no weekly number to hit. Keep adding people as they accept."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <StatTile
          label="Connections this week"
          value={thisWeek}
          tone="brand"
          definition={METRIC_DEFINITIONS.linkedinConnections}
        />
        <StatTile label="Connections in total" value={connections.length} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader
            title="Log a connection"
            description="Once they have accepted your request."
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
              description="When someone accepts your request on LinkedIn, log them with the form."
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
              Each person counts once, however many times you message them. If you log someone who
              is already in your list, you are told so and they are not counted again.
            </DefinitionNote>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
