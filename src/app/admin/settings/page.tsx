import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { listTerritories } from '@/lib/queries/program';
import { listAudit } from '@/lib/services/audit';
import { US_STATE_NAMES } from '@/lib/domain/normalize';
import { formatInstant } from '@/lib/labels';
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
import { TerritoryStatesForm } from '@/components/client/territory-states-form';
import { SuppressionActions } from '@/components/client/suppression-actions';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requireAdmin();

  const data = await asUser(user.id, async (tx) => ({
    territories: await listTerritories(tx),
    map: await tx<{ state_code: string; territory_id: string; code: string }[]>`
      SELECT ts.state_code, ts.territory_id, t.code
      FROM territory_states ts JOIN territories t ON t.id = ts.territory_id
      ORDER BY ts.state_code`,
    suppressions: await tx<
      {
        id: string;
        scope: string;
        channel: string;
        reason: string;
        created_at: Date;
        organization_name: string | null;
        contact_name: string | null;
      }[]
    >`
      SELECT s.id, s.scope::text, s.channel::text, s.reason, s.created_at,
             o.name AS organization_name, c.full_name AS contact_name
      FROM suppressions s
      LEFT JOIN organizations o ON o.id = s.organization_id
      LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.lifted_at IS NULL
      ORDER BY s.created_at DESC
      LIMIT 100`,
    audit: await listAudit(tx, { limit: 40 }),
  }));

  const mapped = new Set(data.map.map((m) => m.state_code));
  const unmapped = Object.keys(US_STATE_NAMES).filter((s) => !mapped.has(s));
  const byTerritory = new Map<string, string[]>();
  for (const row of data.map) {
    byTerritory.set(row.code, [...(byTerritory.get(row.code) ?? []), row.state_code]);
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Territory mapping, suppression list, and the audit trail."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="grid content-start gap-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="State to territory mapping"
              description="The program guide does not define one, so this is yours to configure. Unmapped states import as unassigned and are flagged."
            />
            <CardBody>
              {unmapped.length > 0 ? (
                <Alert
                  tone="caution"
                  className="mb-4"
                  title={`${unmapped.length} state(s) unmapped`}
                >
                  {unmapped.join(', ')}
                </Alert>
              ) : (
                <Alert tone="positive" className="mb-4">
                  Every US state is mapped to a territory.
                </Alert>
              )}

              <TableScroll>
                <thead>
                  <tr>
                    <Th>Territory</Th>
                    <Th numeric>States</Th>
                    <Th>Codes</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.territories.map((t) => {
                    const states = byTerritory.get(t.code) ?? [];
                    return (
                      <tr key={t.id}>
                        <Td>
                          <span className="font-medium text-ink-900">{t.code}</span>
                          <span className="block text-[12px] text-ink-500">{t.name}</span>
                        </Td>
                        <Td numeric>{states.length}</Td>
                        <Td className="wrap-anywhere text-[12px] text-ink-600">
                          {states.join(', ') || <NotAvailable label="None" />}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableScroll>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Active suppressions (${data.suppressions.length})`}
              description="Suppression blocks new outreach across every assignee and survives re-imports. Only an admin can lift one."
            />
            {data.suppressions.length === 0 ? (
              <EmptyState title="Nothing suppressed" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Target</Th>
                    <Th>Channel</Th>
                    <Th>Reason</Th>
                    <Th>Since</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.suppressions.map((s) => (
                    <tr key={s.id}>
                      <Td>
                        {s.contact_name ?? s.organization_name ?? 'Unknown'}
                        <span className="block text-[12px] text-ink-500">
                          {s.scope === 'contact' ? 'Contact' : 'Whole organization'}
                          {s.organization_name && s.contact_name ? ` · ${s.organization_name}` : ''}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone="caution">{s.channel}</Badge>
                      </Td>
                      <Td className="wrap-anywhere">{s.reason}</Td>
                      <Td className="whitespace-nowrap text-ink-600">
                        {formatInstant(s.created_at, 'UTC', { timeStyle: undefined })}
                      </Td>
                      <Td>
                        <SuppressionActions suppressionId={s.id} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Audit trail"
              description="Append-only. Not readable by interns and not editable by anyone, including owners."
            />
            {data.audit.length === 0 ? (
              <EmptyState title="No audited changes yet" />
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Actor</Th>
                    <Th>Action</Th>
                    <Th>Entity</Th>
                    <Th>Reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.map((a) => (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap text-ink-600">
                        {formatInstant(a.createdAt, 'UTC')}
                      </Td>
                      <Td>
                        {a.actorName ?? 'system'}
                        {a.actorRole ? (
                          <span className="block text-[11px] text-ink-500">{a.actorRole}</span>
                        ) : null}
                      </Td>
                      <Td className="font-mono text-[12px]">{a.action}</Td>
                      <Td className="text-[12px] text-ink-600">{a.entityType}</Td>
                      <Td className="wrap-anywhere max-w-xs">
                        {a.reason ?? <NotAvailable label="—" />}
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
            <CardHeader title="Map states to a territory" />
            <CardBody>
              <TerritoryStatesForm
                territories={data.territories.map((t) => ({
                  id: t.id,
                  label: `${t.code} — ${t.name}`,
                }))}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Access model" />
            <CardBody className="grid gap-2 text-[13px] text-ink-700">
              <p>
                <strong>Owner</strong> — the only role that can grant or revoke admin. Created
                server-side via{' '}
                <code className="font-mono text-[12px]">npm run bootstrap:owner</code>, never by a
                public signup.
              </p>
              <p>
                <strong>Admin</strong> — manages interns, leads, targets, meeting verification and
                payouts.
              </p>
              <p>
                <strong>Intern</strong> — sees only their own metrics, profile, projects and the
                clubs currently assigned to them.
              </p>
              <p className="text-[12px] text-ink-500">
                These boundaries are enforced by PostgreSQL row level security as well as by the
                application, so a forged request cannot bypass them.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
