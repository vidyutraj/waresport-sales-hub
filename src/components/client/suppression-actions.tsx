'use client';

import { useActionState, useState } from 'react';
import { liftSuppressionAction } from '@/app/admin/actions';
import { SubmitButton } from '@/components/client/form';
import { Input, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

export function SuppressionActions({ suppressionId }: { suppressionId: string }) {
  const [state, dispatch] = useActionState(liftSuppressionAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass('secondary', 'sm')}
      >
        Lift
      </button>
    );
  }

  return (
    <form action={dispatch} className="flex flex-col gap-1.5">
      <input type="hidden" name="suppressionId" value={suppressionId} />
      <label htmlFor={`lift-${suppressionId}`} className="text-[12px] font-medium text-ink-700">
        Why is it safe to contact them again?
      </label>
      <Input
        id={`lift-${suppressionId}`}
        name="reason"
        required
        minLength={3}
        maxLength={300}
        className="h-8 text-[13px]"
      />
      {state.status === 'error' && state.message ? (
        <p role="alert" className="max-w-xs text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
      <div className="flex gap-1.5">
        <SubmitButton variant="danger" size="sm" pendingLabel="Lifting…">
          Lift suppression
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}
