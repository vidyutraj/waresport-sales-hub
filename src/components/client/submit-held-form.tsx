'use client';

import { useActionState, useState } from 'react';
import { submitHeldAction } from '@/app/(intern)/meetings/actions';
import { SubmitButton } from '@/components/client/form';
import { Input, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SubmitHeldForm({ meetingId, timezone }: { meetingId: string; timezone: string }) {
  const [state, dispatch] = useActionState(submitHeldAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClass('secondary', 'sm')}
      >
        Mark as held
      </button>
    );
  }

  return (
    <form action={dispatch} className="flex flex-col gap-1.5">
      <input type="hidden" name="meetingId" value={meetingId} />
      <input type="hidden" name="timezone" value={timezone} />
      <label htmlFor={`held-${meetingId}`} className="text-[12px] font-medium text-ink-700">
        When did it actually take place?
      </label>
      <Input
        id={`held-${meetingId}`}
        name="heldAtLocal"
        type="datetime-local"
        defaultValue={localNow()}
        required
        className="h-8 w-auto text-[13px]"
      />
      {state.status === 'error' && state.message ? (
        <p role="alert" className="max-w-xs text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
      {state.status === 'success' && state.message ? (
        <p role="status" className="max-w-xs text-[12px] text-positive-700">
          {state.message}
        </p>
      ) : null}
      <div className="flex gap-1.5">
        <SubmitButton variant="primary" size="sm" pendingLabel="Submitting…">
          Submit for verification
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
      <p className="max-w-xs text-[11px] text-ink-500">
        A future time is rejected. An admin confirms before it counts toward $100.
      </p>
    </form>
  );
}
