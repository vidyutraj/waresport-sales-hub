import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { leadFilterOptions, listLeads, type LeadFilters } from '@/lib/queries/leads';
import { listPeople } from '@/lib/services/admin';
import { listImportBatches } from '@/lib/services/import';
import { listTerritories } from '@/lib/queries/program';
import { analysePhone, formatPhone } from '@/lib/domain/phone';
import { ORG_STATUS_LABELS } from '@/lib/services/outreach';
import { formatDateOnly, formatInstant, IMPORT_OUTCOME_TONES } from '@/lib/labels';
import { OUTCOME_LABELS as IMPORT_OUTCOME_LABELS } from '@/lib/domain/csv-import';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
  StatTile,
} from '@/components/ui';
import { LeadFilterBar } from '@/components/client/lead-filter-bar';
import { LeadAssignmentTable } from '@/components/client/lead-assignment-table';

export const metadata = { title: 'Leads & imports' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(p: Record<string, string | string[] | undefined>, k: string): string | null {
  const v = Array.isArray(p[k]) ? p[k][0] : p[k];
  return v && v !== '' ? v : null;
}

export default async function AdminLeadsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireAdmin();
  const params = await searchParams;

  const filters: LeadFilters = {
    search: one(params, 'q'),
    state: one(params, 'state'),
    city: one(params, 'city'),
    sport: one(params, 'sport'),
    source: one(params, 'source'),
    status: one(params, 'status'),
    territoryId: one(params, 'territoryId'),
    assigneeId: one(params, 'assigneeId'),
    assignment: one(params, 'assignment') as LeadFilters['assignment'],
    contactability: one(params, 'contactability') as LeadFilters['contactability'],
    sort: (one(params, 'sort') as LeadFilters['sort']) ?? 'name',
    page: Number(one(params, 'page') ?? '1') || 1,
    pageSize: 50,
  };

  const data = await asUser(user.id, async (tx) => ({
    leads: await listLeads(tx, filters),
    options: await leadFilterOptions(tx),
    interns: (await listPeople(tx, { role: 'intern' })).filter((p) => p.status === 'active'),
    territories: await listTerritories(tx),
    batches: await listImportBatches(tx, 5),
    unassignedCount: Number(
      (
        await tx<{ c: string }[]>`
          SELECT count(*)::text AS c FROM organizations o
          WHERE o.is_archived = false
            AND NOT EXISTS (SELECT 1 FROM organization_assignments a
                            WHERE a.organization_id = o.id AND a.unassigned_at IS NULL)`
      )[0]?.c ?? 0,
    ),
    unmappedTerritory: Number(
      (
        await tx<{ c: string }[]>`
          SELECT count(*)::text AS c FROM organizations
          WHERE is_archived = false AND territory_id IS NULL`
      )[0]?.c ?? 0,
    ),
  }));

  const queryString = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => {
      const value = Array.isArray(v) ? v[0] : v;
      return value ? [[k, value] as [string, string]] : [];
    }),
  );

  return (
    <>
      <PageHeader
        title="Leads & imports"
        description="Import club lists, then filter and allocate them to interns."
        actions={
          <>
            <LinkButton href="/admin/leads/import" variant="primary">
              Import CSV
            </LinkButton>
            <LinkButton href={`/api/exports/leads?${queryString.toString()}`}>
              Export filtered CSV
            </LinkButton>
          </>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile label="Clubs matching filters" value={data.leads.total.toLocaleString()} />
        <StatTile
          label="Unassigned clubs"
          value={data.unassignedCount.toLocaleString()}
          tone={data.unassignedCount > 0 ? 'caution' : 'positive'}
          sub={
            <Link href="/admin/leads?assignment=unassigned" className="text-brand-600 underline">
              Filter to them
            </Link>
          }
        />
        <StatTile
          label="Clubs with no territory"
          value={data.unmappedTerritory.toLocaleString()}
          tone={data.unmappedTerritory > 0 ? 'caution' : 'neutral'}
          sub={
            <Link href="/admin/settings" className="text-brand-600 underline">
              Edit the state map
            </Link>
          }
        />
      </div>

      <Card className="mb-4">
        <LeadFilterBar
          basePath="/admin/leads"
          states={data.options.states}
          sports={data.options.sports}
          sources={data.options.sources}
          statuses={Object.entries(ORG_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          assignees={data.interns.map((i) => ({
            id: i.id,
            name: i.preferredName ?? i.fullName ?? i.email,
          }))}
          showAssignment
          defaults={{
            q: filters.search ?? '',
            state: filters.state ?? '',
            sport: filters.sport ?? '',
            source: filters.source ?? '',
            status: filters.status ?? '',
            assigneeId: filters.assigneeId ?? '',
            assignment: filters.assignment ?? '',
            contactability: filters.contactability ?? '',
            sort: filters.sort ?? 'name',
          }}
        />
      </Card>

      <Card className="mb-5">
        {data.leads.rows.length === 0 ? (
          <EmptyState
            title="No clubs match those filters"
            description="Widen the filters, or import a lead list to get started."
            action={
              <LinkButton href="/admin/leads/import" variant="primary">
                Import CSV
              </LinkButton>
            }
          />
        ) : (
          <LeadAssignmentTable
            leads={data.leads.rows.map((l) => {
              const phone = analysePhone(l.primaryPhoneRaw);
              return {
                id: l.id,
                name: l.name,
                location: [l.city, l.state].filter(Boolean).join(', ') || 'Unknown',
                state: l.state,
                territoryCode: l.territoryCode,
                email: l.primaryEmail,
                phone: phone.raw ? formatPhone(phone) : null,
                phoneValid: phone.valid,
                status: l.status,
                statusLabel:
                  ORG_STATUS_LABELS[l.status as keyof typeof ORG_STATUS_LABELS] ?? l.status,
                assigneeId: l.assigneeId,
                assigneeName: l.assigneeName,
                nextFollowUpOn: l.nextFollowUpOn ? formatDateOnly(l.nextFollowUpOn) : null,
                contactCount: l.contactCount,
                suppressed: l.isSuppressed,
              };
            })}
            interns={data.interns.map((i) => ({
              id: i.id,
              name: i.preferredName ?? i.fullName ?? i.email,
              territoryCode: i.territoryCode,
            }))}
            page={data.leads.page}
            pageCount={data.leads.pageCount}
            total={data.leads.total}
            baseQuery={queryString.toString()}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Recent imports"
          description="Every batch records who uploaded it, when, and what happened to each row."
          actions={
            <LinkButton href="/admin/leads/import" size="sm">
              New import
            </LinkButton>
          }
        />
        {data.batches.length === 0 ? (
          <EmptyState title="No imports yet" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {data.batches.map((b) => (
              <li key={b.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-900">{b.filename}</p>
                    <p className="text-[12px] text-ink-500">
                      {b.uploadedByName} · {formatInstant(b.createdAt, 'UTC')} ·{' '}
                      {b.parsedRowCount.toLocaleString()} data rows
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {b.result ? (
                      Object.entries(b.result.summary.byOutcome)
                        .filter(([, count]) => count > 0)
                        .map(([outcome, count]) => (
                          <Badge key={outcome} tone={IMPORT_OUTCOME_TONES[outcome] ?? 'neutral'}>
                            {IMPORT_OUTCOME_LABELS[outcome as keyof typeof IMPORT_OUTCOME_LABELS]}:{' '}
                            {count}
                          </Badge>
                        ))
                    ) : (
                      <Badge tone="neutral">{b.status}</Badge>
                    )}
                    <LinkButton href={`/api/exports/import-rejects/${b.id}`} size="sm">
                      Rejected rows CSV
                    </LinkButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <CardBody className="border-t border-ink-100">
          <p className="text-[12px] text-ink-500">
            Re-uploading a file that has already been imported creates nothing: every source row
            carries a stable key, so repeats are classified as duplicates.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
