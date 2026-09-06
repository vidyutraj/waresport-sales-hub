'use client';

import { useActionState, useState } from 'react';
import { voidActivityAction } from '@/app/(intern)/leads/actions';
import { SubmitButton } from '@/components/client/form';
import { Input, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

/**
 * Void one logged activity with a reason.
 *
 * The original row is kept and stays visible in the timeline; it simply stops
 * counting. There is no delete, and metrics recalculate from the remaining
 * non-voided rows.
 */
export function VoidActivityButton({
  activityId,
  organizationId,
}: {
  activityId: string;
  organizationId: string;
}) {
  const [state, dispatch] = useActionState(voidActivityAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass('ghost', 'sm')}
        aria-label="Correct or void this entry"
      >
        Correct
      </button>
    );
  }

  return (
    <form action={dispatch} className="flex min-w-[14rem] flex-col gap-1.5">
      <input type="hidden" name="activityId" value={activityId} />
      <input type="hidden" name="organizationId" value={organizationId} />
      <label htmlFor={`void-${activityId}`} className="text-[12px] font-medium text-ink-700">
        Why is this wrong?
      </label>
      <Input
        id={`void-${activityId}`}
        name="reason"
        required
        minLength={3}
        maxLength={300}
        placeholder="e.g. logged against the wrong contact"
        className="h-8 text-[13px]"
      />
      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
      <div className="flex gap-1.5">
        <SubmitButton variant="danger" size="sm" pendingLabel="Voiding…">
          Void entry
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}
