'use client';

import { useState } from 'react';
import { allocateBatchAction } from '@/app/admin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Alert, Field, Input, Select } from '@/components/ui';

/**
 * Allocate a batch of unallocated clubs to one intern.
 *
 * The point of this form is that it is *partial*: you say how many and to whom,
 * and whatever is left stays in the unallocated queue for next time. It always
 * operates on the filters currently applied to the table, which are carried
 * along as hidden fields so the "next 20" is the next 20 of what is on screen.
 */
export function AllocateBatchForm({
  interns,
  unallocatedCount,
  filters,
}: {
  interns: { id: string; name: string; territoryCode: string | null }[];
  unallocatedCount: number;
  filters: Record<string, string>;
}) {
  const [count, setCount] = useState(Math.min(20, Math.max(unallocatedCount, 1)));
  const [internId, setInternId] = useState(interns[0]?.id ?? '');

  const chosen = interns.find((i) => i.id === internId);
  const willAllocate = Math.min(count || 0, unallocatedCount);
  const remaining = Math.max(0, unallocatedCount - willAllocate);

  if (interns.length === 0) {
    return (
      <Alert tone="caution" title="No active interns">
        Add an intern before allocating clubs.
      </Alert>
    );
  }

  return (
    <ActionForm action={allocateBatchAction}>
      {(state) => (
        <>
          {Object.entries(filters).map(([key, value]) =>
            value ? <input key={key} type="hidden" name={key} value={value} /> : null,
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="How many"
              htmlFor="allocate-count"
              required
              hint={`${unallocatedCount.toLocaleString()} unallocated match the current filters.`}
              error={state.fieldErrors.count}
            >
              <Input
                id="allocate-count"
                name="count"
                type="number"
                min={1}
                max={500}
                required
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </Field>

            <Field
              label="Allocate to"
              htmlFor="allocate-intern"
              required
              error={state.fieldErrors.internUserId}
            >
              <Select
                id="allocate-intern"
                name="internUserId"
                value={internId}
                onChange={(e) => setInternId(e.target.value)}
              >
                {interns.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                    {i.territoryCode ? ` (${i.territoryCode})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field
            label="Reason"
            htmlFor="allocate-reason"
            hint="Recorded on every assignment in the audit trail."
            error={state.fieldErrors.reason}
          >
            <Input
              id="allocate-reason"
              name="reason"
              maxLength={300}
              placeholder="Optional — e.g. first batch for week 1"
            />
          </Field>

          <Field
            label="Cross-territory reason"
            htmlFor="allocate-override"
            hint="Only needed if some clubs sit outside that intern's territory; without it those clubs are skipped and stay unallocated."
            error={state.fieldErrors.territoryOverrideReason}
          >
            <Input
              id="allocate-override"
              name="territoryOverrideReason"
              maxLength={300}
              placeholder="Optional"
            />
          </Field>

          <Alert tone="info" title="What will happen">
            <p>
              The first <strong>{willAllocate.toLocaleString()}</strong> unallocated club
              {willAllocate === 1 ? '' : 's'} (by name) go to{' '}
              <strong>{chosen?.name ?? 'nobody'}</strong>.{' '}
              <strong>{remaining.toLocaleString()}</strong> stay unallocated for later.
            </p>
            <p className="mt-1 text-[12px]">
              Clubs already owned by someone are never touched, so running this again allocates the
              next batch rather than reshuffling this one.
            </p>
          </Alert>

          <div>
            <SubmitButton pendingLabel="Allocating…">
              Allocate {willAllocate.toLocaleString()} to {chosen?.name ?? '—'}
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
