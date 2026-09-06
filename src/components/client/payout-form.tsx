'use client';

import { useActionState, useState } from 'react';
import { recordPayoutAction } from '@/app/admin/actions';
import { SubmitButton } from '@/components/client/form';
import { Input, Select, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

export function PayoutForm({
  userId,
  cohortId,
  unpaidMilestones,
}: {
  userId: string;
  cohortId: string;
  unpaidMilestones: number[];
}) {
  const [state, dispatch] = useActionState(recordPayoutAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={buttonClass('primary', 'sm')}
        >
          Record ${unpaidMilestones.length * 100} paid
        </button>
        <span className="text-[11px] text-ink-500">
          Milestone{unpaidMilestones.length === 1 ? '' : 's'} {unpaidMilestones.join(', ')}{' '}
          unrecorded
        </span>
        {state.status === 'success' && state.message ? (
          <p role="status" className="max-w-xs text-[12px] text-positive-700">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={dispatch} className="flex flex-col gap-1.5">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="cohortId" value={cohortId} />

      <label htmlFor={`ms-${userId}`} className="text-[12px] font-medium text-ink-700">
        Milestone
      </label>
      <Select
        id={`ms-${userId}`}
        name="milestoneIndex"
        defaultValue={String(unpaidMilestones[0] ?? 1)}
        className="h-8 w-auto text-[13px]"
      >
        {unpaidMilestones.map((m) => (
          <option key={m} value={m}>
            #{m} — $100
          </option>
        ))}
      </Select>

      <label htmlFor={`paid-${userId}`} className="text-[12px] font-medium text-ink-700">
        Paid on
      </label>
      <Input
        id={`paid-${userId}`}
        name="paidOn"
        type="date"
        defaultValue={new Date().toISOString().slice(0, 10)}
        required
        className="h-8 w-auto text-[13px]"
      />

      <Input
        name="reference"
        maxLength={120}
        placeholder="Payment reference"
        aria-label="Payment reference"
        className="h-8 text-[13px]"
      />

      {state.status === 'error' && state.message ? (
        <p role="alert" className="max-w-xs text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}

      <div className="flex gap-1.5">
        <SubmitButton variant="primary" size="sm" pendingLabel="Recording…">
          Record payment
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
      <p className="max-w-xs text-[11px] text-ink-500">
        This records that you paid it. No money moves, and a milestone can only be recorded once.
      </p>
    </form>
  );
}
