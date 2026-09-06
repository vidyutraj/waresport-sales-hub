'use client';

import Link from 'next/link';
import { useActionState, useMemo, useState } from 'react';
import { assignLeadsAction, distributeLeadsAction, unassignAction } from '@/app/admin/actions';
import { FormFeedback, SubmitButton } from '@/components/client/form';
import {
  Alert,
  Badge,
  Input,
  NotAvailable,
  Pagination,
  Select,
  StatusBadge,
  TableScroll,
  Td,
  Th,
  buttonClass,
} from '@/components/ui';
import { IDLE } from '@/lib/form';
import { planEvenDistribution } from '@/lib/distribution';

export type LeadCell = {
  id: string;
  name: string;
  location: string;
  state: string | null;
  territoryCode: string | null;
  email: string | null;
  phone: string | null;
  phoneValid: boolean;
  status: string;
  statusLabel: string;
  assigneeId: string | null;
  assigneeName: string | null;
  nextFollowUpOn: string | null;
  contactCount: number;
  suppressed: boolean;
};

/**
 * Lead table with selection and bulk assignment.
 *
 * Every bulk change shows a preview of exactly what will happen — including
 * the per-intern split for even distribution and any territory mismatch —
 * before it can be confirmed.
 */
export function LeadAssignmentTable({
  leads,
  interns,
  page,
  pageCount,
  total,
  baseQuery,
}: {
  leads: LeadCell[];
  interns: { id: string; name: string; territoryCode: string | null }[];
  page: number;
  pageCount: number;
  total: number;
  baseQuery: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'single' | 'even'>('single');
  const [internId, setInternId] = useState<string>(interns[0]?.id ?? '');
  const [distributeTo, setDistributeTo] = useState<Set<string>>(new Set(interns.map((i) => i.id)));
  const [override, setOverride] = useState('');

  const [assignState, assignDispatch] = useActionState(assignLeadsAction, IDLE);
  const [distributeState, distributeDispatch] = useActionState(distributeLeadsAction, IDLE);
  const [unassignState, unassignDispatch] = useActionState(unassignAction, IDLE);

  const selectedLeads = leads.filter((l) => selected.has(l.id));
  const allSelected = leads.length > 0 && selectedLeads.length === leads.length;

  const chosenIntern = interns.find((i) => i.id === internId);
  const mismatches = useMemo(() => {
    if (mode !== 'single' || !chosenIntern?.territoryCode) return [];
    return selectedLeads.filter(
      (l) => l.territoryCode !== null && l.territoryCode !== chosenIntern.territoryCode,
    );
  }, [mode, chosenIntern, selectedLeads]);

  const distributeIds = interns.filter((i) => distributeTo.has(i.id)).map((i) => i.id);
  const plan = useMemo(
    () =>
      planEvenDistribution(
        selectedLeads.map((l) => l.id),
        distributeIds,
      ),
    [selectedLeads, distributeIds],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      {/* ---- Bulk assignment panel -------------------------------------- */}
      <div className="border-b border-ink-200 bg-ink-50 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[13px] font-medium text-ink-800" aria-live="polite">
            {selectedLeads.length === 0
              ? 'Select clubs to assign'
              : `${selectedLeads.length} club${selectedLeads.length === 1 ? '' : 's'} selected`}
          </p>
          <button
            type="button"
            onClick={() => setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)))}
            className={buttonClass('secondary', 'sm')}
          >
            {allSelected ? 'Clear selection' : `Select all ${leads.length} on this page`}
          </button>

          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="assign-mode" className="text-[12px] font-medium text-ink-700">
              Mode
            </label>
            <Select
              id="assign-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'single' | 'even')}
              className="w-auto"
            >
              <option value="single">Assign to one intern</option>
              <option value="even">Distribute evenly</option>
            </Select>
          </div>
        </div>

        {selectedLeads.length > 0 && mode === 'single' ? (
          <form action={assignDispatch} className="mt-3 flex flex-col gap-2">
            {selectedLeads.map((l) => (
              <input key={l.id} type="hidden" name="organizationIds" value={l.id} />
            ))}
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label
                  htmlFor="assign-intern"
                  className="mb-1 block text-[12px] font-medium text-ink-700"
                >
                  Assign to
                </label>
                <Select
                  id="assign-intern"
                  name="internUserId"
                  value={internId}
                  onChange={(e) => setInternId(e.target.value)}
                  className="w-auto min-w-[12rem]"
                >
                  {interns.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                      {i.territoryCode ? ` (${i.territoryCode})` : ''}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-[14rem] flex-1">
                <label
                  htmlFor="assign-reason"
                  className="mb-1 block text-[12px] font-medium text-ink-700"
                >
                  Reason
                </label>
                <Input id="assign-reason" name="reason" maxLength={300} placeholder="Optional" />
              </div>
              <SubmitButton pendingLabel="Assigning…">Assign {selectedLeads.length}</SubmitButton>
            </div>

            {mismatches.length > 0 ? (
              <Alert
                tone="caution"
                title={`${mismatches.length} club(s) are outside that intern's territory`}
              >
                <p className="mb-2">
                  {mismatches
                    .slice(0, 4)
                    .map((m) => `${m.name} (${m.territoryCode})`)
                    .join(', ')}
                  {mismatches.length > 4 ? `, +${mismatches.length - 4} more` : ''}
                </p>
                <label htmlFor="override-reason" className="mb-1 block text-[12px] font-medium">
                  Override reason (required to assign anyway)
                </label>
                <Input
                  id="override-reason"
                  name="territoryOverrideReason"
                  value={override}
                  onChange={(e) => setOverride(e.target.value)}
                  maxLength={300}
                  placeholder="Why is this cross-territory assignment correct?"
                />
              </Alert>
            ) : null}

            <FormFeedback state={assignState} />
          </form>
        ) : null}

        {selectedLeads.length > 0 && mode === 'even' ? (
          <form action={distributeDispatch} className="mt-3 flex flex-col gap-2">
            {selectedLeads.map((l) => (
              <input key={l.id} type="hidden" name="organizationIds" value={l.id} />
            ))}
            {distributeIds.map((id) => (
              <input key={id} type="hidden" name="internUserIds" value={id} />
            ))}
            <fieldset>
              <legend className="mb-1 text-[12px] font-medium text-ink-700">
                Distribute across
              </legend>
              <div className="flex flex-wrap gap-3">
                {interns.map((i) => (
                  <label key={i.id} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={distributeTo.has(i.id)}
                      onChange={() =>
                        setDistributeTo((prev) => {
                          const next = new Set(prev);
                          if (next.has(i.id)) next.delete(i.id);
                          else next.add(i.id);
                          return next;
                        })
                      }
                      className="h-4 w-4 accent-brand-500"
                    />
                    {i.name}
                  </label>
                ))}
              </div>
            </fieldset>

            {distributeIds.length > 0 ? (
              <Alert tone="info" title="Preview">
                <ul className="mt-1 grid gap-0.5">
                  {[...plan.entries()].map(([id, ids]) => (
                    <li key={id}>
                      {interns.find((i) => i.id === id)?.name}: <strong>{ids.length}</strong> club
                      {ids.length === 1 ? '' : 's'}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[12px]">
                  Clubs are dealt in order, so the remainder goes to the interns listed first. The
                  same selection always produces this same split.
                </p>
              </Alert>
            ) : (
              <Alert tone="caution">Select at least one intern to distribute across.</Alert>
            )}

            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1">
                <label
                  htmlFor="dist-reason"
                  className="mb-1 block text-[12px] font-medium text-ink-700"
                >
                  Reason
                </label>
                <Input id="dist-reason" name="reason" maxLength={300} placeholder="Optional" />
              </div>
              <div className="min-w-[14rem] flex-1">
                <label
                  htmlFor="dist-override"
                  className="mb-1 block text-[12px] font-medium text-ink-700"
                >
                  Territory override reason
                </label>
                <Input
                  id="dist-override"
                  name="territoryOverrideReason"
                  maxLength={300}
                  placeholder="Needed if any club sits outside an intern's territory"
                />
              </div>
              <SubmitButton pendingLabel="Distributing…" disabled={distributeIds.length === 0}>
                Distribute {selectedLeads.length}
              </SubmitButton>
            </div>
            <FormFeedback state={distributeState} />
          </form>
        ) : null}

        <FormFeedback state={unassignState} />
      </div>

      {/* ---- Table ------------------------------------------------------- */}
      <TableScroll>
        <caption className="sr-only">Clubs with assignment controls</caption>
        <thead>
          <tr>
            <Th className="w-8">
              <span className="sr-only">Select</span>
            </Th>
            <Th>Club</Th>
            <Th>Email</Th>
            <Th>Phone</Th>
            <Th>Territory</Th>
            <Th>Assigned to</Th>
            <Th>Status</Th>
            <Th>Next follow-up</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr
              key={lead.id}
              className={selected.has(lead.id) ? 'bg-brand-50/40' : 'hover:bg-ink-50'}
            >
              <Td>
                <input
                  type="checkbox"
                  checked={selected.has(lead.id)}
                  onChange={() => toggle(lead.id)}
                  aria-label={`Select ${lead.name}`}
                  className="h-4 w-4 accent-brand-500"
                />
              </Td>
              <Td>
                <Link
                  href={`/admin/leads/${lead.id}`}
                  className="font-medium text-ink-900 hover:text-brand-600"
                >
                  {lead.name}
                </Link>
                <span className="block text-[12px] text-ink-500">
                  {lead.location}
                  {lead.contactCount > 1 ? ` · ${lead.contactCount} contacts` : ''}
                </span>
                {lead.suppressed ? (
                  <Badge tone="caution" className="mt-1">
                    Suppressed
                  </Badge>
                ) : null}
              </Td>
              <Td className="wrap-anywhere">{lead.email ?? <NotAvailable />}</Td>
              <Td className="whitespace-nowrap">
                {lead.phone ? (
                  <>
                    {lead.phone}
                    {!lead.phoneValid ? (
                      <span className="block text-[11px] text-caution-700">Unverified</span>
                    ) : null}
                  </>
                ) : (
                  <NotAvailable />
                )}
              </Td>
              <Td>{lead.territoryCode ?? <NotAvailable label="Unmapped" />}</Td>
              <Td>{lead.assigneeName ?? <NotAvailable label="Unassigned" />}</Td>
              <Td>
                <StatusBadge status={lead.status} label={lead.statusLabel} />
              </Td>
              <Td className="whitespace-nowrap">
                {lead.nextFollowUpOn ?? <NotAvailable label="None" />}
              </Td>
              <Td>
                {lead.assigneeId ? (
                  <form action={unassignDispatch}>
                    <input type="hidden" name="organizationId" value={lead.id} />
                    <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                      Unassign
                    </SubmitButton>
                  </form>
                ) : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </TableScroll>

      <Pagination
        page={page}
        pageCount={pageCount}
        total={total}
        buildHref={(p) => {
          const next = new URLSearchParams(baseQuery);
          next.set('page', String(p));
          return `/admin/leads?${next.toString()}`;
        }}
      />
    </div>
  );
}
