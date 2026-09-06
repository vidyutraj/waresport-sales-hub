'use client';

import { useActionState } from 'react';
import { setStatusAction } from '@/app/(intern)/leads/actions';
import { FormFeedback, SubmitButton } from '@/components/client/form';
import { Select } from '@/components/ui';
import { IDLE } from '@/lib/form';
import { ORG_STATUS_LABELS } from '@/lib/status-labels';

export function StatusPicker({
  organizationId,
  current,
  rowVersion,
}: {
  organizationId: string;
  current: string;
  rowVersion: number;
}) {
  const [state, dispatch] = useActionState(setStatusAction, IDLE);

  return (
    <form action={dispatch} className="flex flex-col gap-3">
      <input type="hidden" name="organizationId" value={organizationId} />
      {/* Optimistic-locking token: a stale form is rejected, never applied. */}
      <input type="hidden" name="expectedRowVersion" value={rowVersion} />
      <label htmlFor="org-status" className="sr-only">
        Workflow status
      </label>
      <Select id="org-status" name="status" defaultValue={current}>
        {Object.entries(ORG_STATUS_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
        Update status
      </SubmitButton>
      <p className="text-[12px] text-ink-500">
        Changing the status records no outreach and creates no meeting.
      </p>
      <FormFeedback state={state} />
    </form>
  );
}
