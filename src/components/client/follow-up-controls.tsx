'use client';

import { useActionState, useState } from 'react';
import { followUpAction } from '@/app/(intern)/leads/actions';
import { SubmitButton } from '@/components/client/form';
import { Input, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function FollowUpControls({
  followUpId,
  snoozed,
}: {
  followUpId: string;
  snoozed: boolean;
}) {
  const [state, dispatch] = useActionState(followUpAction, IDLE);
  const [snoozing, setSnoozing] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <form action={dispatch}>
          <input type="hidden" name="followUpId" value={followUpId} />
          <input type="hidden" name="operation" value="complete" />
          <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
            Complete
          </SubmitButton>
        </form>

        {snoozed ? (
          <form action={dispatch}>
            <input type="hidden" name="followUpId" value={followUpId} />
            <input type="hidden" name="operation" value="reopen" />
            <SubmitButton variant="ghost" size="sm" pendingLabel="Saving…">
              Reopen
            </SubmitButton>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setSnoozing((v) => !v)}
            className={buttonClass('ghost', 'sm')}
            aria-expanded={snoozing}
          >
            Snooze
          </button>
        )}
      </div>

      {snoozing ? (
        <form action={dispatch} className="flex flex-wrap items-end gap-1.5">
          <input type="hidden" name="followUpId" value={followUpId} />
          <input type="hidden" name="operation" value="snooze" />
          <div>
            <label htmlFor={`snooze-${followUpId}`} className="sr-only">
              Snooze until
            </label>
            <Input
              id={`snooze-${followUpId}`}
              name="until"
              type="date"
              defaultValue={inDays(3)}
              required
              className="h-8 w-auto text-[13px]"
            />
          </div>
          <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
            Snooze
          </SubmitButton>
        </form>
      ) : null}

      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
