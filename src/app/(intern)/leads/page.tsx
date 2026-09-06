import Link from 'next/link';
import { requireIntern } from '@/lib/auth/session';
import { asUser } from '@/lib/db';
import { listLeads, type LeadFilters } from '@/lib/queries/leads';
import { analysePhone, formatPhone } from '@/lib/domain/phone';
import { ORG_STATUS_LABELS } from '@/lib/services/outreach';
import { formatDateOnly } from '@/lib/labels';
import {
  Badge,
  Card,
  EmptyState,
  NotAvailable,
  PageHeader,
  Pagination,
  StatusBadge,
  TableScroll,
  Td,
  Th,
} from '@/components/ui';
import { LeadFilterBar } from '@/components/client/lead-filter-bar';

export const metadata = { title: 'My leads' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(params: Record<string, string | string[] | undefined>, key: string): string | null {
  const value = params[key];
  const v = Array.isArray(value) ? value[0] : value;
  return v && v !== '' ? v : null;
}

export default async function MyLeadsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireIntern();
  const params = await searchParams;

  // Filters live in the URL so a view can be bookmarked and shared.
  const filters: LeadFilters = {
    search: one(params, 'q'),
    state: one(params, 'state'),
    status: one(params, 'status'),
    contactability: one(params, 'contactability') as LeadFilters['contactability'],
    sort: (one(params, 'sort') as LeadFilters['sort']) ?? 'name',
    page: Number(one(params, 'page') ?? '1') || 1,
    pageSize: 25,
    // Interns only ever see clubs currently assigned to them; row level
    // security enforces this independently of the filter below.
    assigneeId: user.id,
  };

  const { leads, states } = await asUser(user.id, async (tx) => ({
    leads: await listLeads(tx, filters),
    states: await tx<{ v: string }[]>`
      SELECT DISTINCT o.state AS v
      FROM organization_assignments a
      JOIN organizations o ON o.id = a.organization_id
      WHERE a.intern_user_id = ${user.id} AND a.unassigned_at IS NULL AND o.state IS NOT NULL
      ORDER BY 1`,
  }));

  const buildHref = (page: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const v = Array.isArray(value) ? value[0] : value;
      if (v) next.set(key, v);
    }
    next.set('page', String(page));
    return `/leads?${next.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="My leads"
        description="Clubs currently assigned to you. Open one to copy contact details, then log the outreach you actually sent."
      />

      <Card className="mb-4">
        <LeadFilterBar
          basePath="/leads"
          states={states.map((s) => s.v)}
          statuses={Object.entries(ORG_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          defaults={{
            q: filters.search ?? '',
            state: filters.state ?? '',
            status: filters.status ?? '',
            contactability: filters.contactability ?? '',
            sort: filters.sort ?? 'name',
          }}
        />
      </Card>

      <Card>
        {leads.rows.length === 0 ? (
          <EmptyState
            title={
              filters.search || filters.state || filters.status
                ? 'No clubs match those filters'
                : 'No clubs assigned yet'
            }
            description={
              filters.search || filters.state || filters.status
                ? 'Clear or widen the filters to see more of your assigned clubs.'
                : 'An admin assigns clubs to you. You can also research and add your own from the LinkedIn tab.'
            }
          />
        ) : (
          <>
            <TableScroll>
              <caption className="sr-only">Clubs assigned to you, {leads.total} in total</caption>
              <thead>
                <tr>
                  <Th>Club</Th>
                  <Th>Email</Th>
                  <Th>Phone</Th>
                  <Th>Territory</Th>
                  <Th>Status</Th>
                  <Th>Next follow-up</Th>
                </tr>
              </thead>
              <tbody>
                {leads.rows.map((lead) => {
                  const phone = analysePhone(lead.primaryPhoneRaw);
                  return (
                    <tr key={lead.id} className="hover:bg-ink-50">
                      <Td>
                        <Link
                          href={`/leads/${lead.id}`}
                          className="font-medium text-ink-900 hover:text-brand-600"
                        >
                          {lead.name}
                        </Link>
                        <span className="block text-[12px] text-ink-500">
                          {[lead.city, lead.state].filter(Boolean).join(', ') || 'Location unknown'}
                          {lead.contactCount > 1 ? ` · ${lead.contactCount} contacts` : ''}
                        </span>
                        {lead.isSuppressed ? (
                          <Badge tone="caution" className="mt-1">
                            Suppressed
                          </Badge>
                        ) : null}
                      </Td>
                      <Td className="wrap-anywhere">{lead.primaryEmail ?? <NotAvailable />}</Td>
                      <Td className="whitespace-nowrap">
                        {phone.raw ? (
                          <>
                            {formatPhone(phone)}
                            {!phone.valid ? (
                              <span className="block text-[11px] text-caution-700">
                                Not verified as dialable
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <NotAvailable />
                        )}
                      </Td>
                      <Td>{lead.territoryCode ?? <NotAvailable label="Unassigned" />}</Td>
                      <Td>
                        <StatusBadge
                          status={lead.status}
                          label={
                            ORG_STATUS_LABELS[lead.status as keyof typeof ORG_STATUS_LABELS] ??
                            lead.status
                          }
                        />
                      </Td>
                      <Td className="whitespace-nowrap">
                        {lead.nextFollowUpOn ? (
                          formatDateOnly(lead.nextFollowUpOn)
                        ) : (
                          <NotAvailable label="None" />
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableScroll>
            <Pagination
              page={leads.page}
              pageCount={leads.pageCount}
              total={leads.total}
              buildHref={buildHref}
            />
          </>
        )}
      </Card>
    </>
  );
}
