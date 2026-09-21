'use client';

import { useActionState, useState } from 'react';
import { meetingReviewAction } from '@/app/admin/actions';
import { SubmitButton } from '@/components/client/form';
import { Input, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

/**
 * Approve or decline a meeting an intern has logged as booked.
 *
 * Declining needs a reason, which the intern sees on their Meetings tab.
 */
export function BookingApprovalControls({ meetingId }: { meetingId: string }) {
  const [state, dispatch] = useActionState(meetingReviewAction, IDLE);
  const [declining, setDeclining] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <form action={dispatch}>
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="operation" value="approve" />
          <SubmitButton variant="primary" size="sm" pendingLabel="Approving…">
            Approve
          </SubmitButton>
        </form>
        <button
          type="button"
          onClick={() => setDeclining(!declining)}
          className={buttonClass('secondary', 'sm')}
        >
          Decline
        </button>
      </div>

      {declining ? (
        <form action={dispatch} className="flex flex-col gap-1.5">
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="operation" value="decline" />
          <label htmlFor={`decline-${meetingId}`} className="text-[12px] font-medium text-ink-700">
            Why are you declining it?
          </label>
          <Input
            id={`decline-${meetingId}`}
            name="reason"
            required
            minLength={3}
            maxLength={300}
            className="h-8 text-[13px]"
          />
          <SubmitButton variant="danger" size="sm" pendingLabel="Saving…">
            Confirm decline
          </SubmitButton>
        </form>
      ) : null}

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
    </div>
  );
}
