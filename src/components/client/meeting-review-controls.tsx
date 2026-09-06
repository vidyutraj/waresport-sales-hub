'use client';

import { useActionState, useState } from 'react';
import { changeAttributionAction, meetingReviewAction } from '@/app/admin/actions';
import { SubmitButton } from '@/components/client/form';
import { Input, Select, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

/**
 * Verify, reject, revert or re-attribute one meeting.
 *
 * Every destructive or reversing action requires a typed reason, which is
 * stored on the meeting's event history and in the audit trail.
 */
export function MeetingReviewControls({
  meetingId,
  interns,
  canRevert,
}: {
  meetingId: string;
  interns: { id: string; name: string }[];
  canRevert: boolean;
}) {
  const [state, dispatch] = useActionState(meetingReviewAction, IDLE);
  const [attrState, attrDispatch] = useActionState(changeAttributionAction, IDLE);
  const [panel, setPanel] = useState<'none' | 'reject' | 'revert' | 'attribute' | 'exception'>(
    'none',
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {!canRevert ? (
          <form action={dispatch}>
            <input type="hidden" name="meetingId" value={meetingId} />
            <input type="hidden" name="operation" value="verify" />
            <SubmitButton variant="primary" size="sm" pendingLabel="Verifying…">
              Verify held
            </SubmitButton>
          </form>
        ) : null}

        {!canRevert ? (
          <button
            type="button"
            onClick={() => setPanel(panel === 'reject' ? 'none' : 'reject')}
            className={buttonClass('secondary', 'sm')}
          >
            Return
          </button>
        ) : null}

        {!canRevert ? (
          <button
            type="button"
            onClick={() => setPanel(panel === 'exception' ? 'none' : 'exception')}
            className={buttonClass('ghost', 'sm')}
          >
            Verify as exception
          </button>
        ) : null}

        {canRevert ? (
          <button
            type="button"
            onClick={() => setPanel(panel === 'revert' ? 'none' : 'revert')}
            className={buttonClass('danger', 'sm')}
          >
            Reverse verification
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setPanel(panel === 'attribute' ? 'none' : 'attribute')}
          className={buttonClass('ghost', 'sm')}
        >
          Re-attribute
        </button>
      </div>

      {panel === 'reject' || panel === 'revert' ? (
        <form action={dispatch} className="flex flex-col gap-1.5">
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="operation" value={panel} />
          <label htmlFor={`reason-${meetingId}`} className="text-[12px] font-medium text-ink-700">
            {panel === 'reject' ? 'Why are you returning it?' : 'Why are you reversing this?'}
          </label>
          <Input
            id={`reason-${meetingId}`}
            name="reason"
            required
            minLength={3}
            maxLength={300}
            className="h-8 text-[13px]"
          />
          {/* A distinct label from the trigger, so the confirming action is
              unambiguous both on screen and to assistive technology. */}
          <SubmitButton variant="danger" size="sm" pendingLabel="Saving…">
            {panel === 'reject' ? 'Return to intern' : 'Confirm reversal'}
          </SubmitButton>
          {panel === 'revert' ? (
            <p className="max-w-xs text-[11px] text-ink-500">
              Earnings recalculate immediately. Any payout already recorded is kept, and any
              resulting overpayment is surfaced for reconciliation.
            </p>
          ) : null}
        </form>
      ) : null}

      {panel === 'exception' ? (
        <form action={dispatch} className="flex flex-col gap-1.5">
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="operation" value="verify" />
          <label htmlFor={`exc-${meetingId}`} className="text-[12px] font-medium text-ink-700">
            Reason for counting a meeting held outside the cohort window
          </label>
          <Input
            id={`exc-${meetingId}`}
            name="eligibilityOverrideReason"
            required
            minLength={3}
            maxLength={300}
            className="h-8 text-[13px]"
          />
          <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
            Verify with exception
          </SubmitButton>
        </form>
      ) : null}

      {panel === 'attribute' ? (
        <form action={attrDispatch} className="flex flex-col gap-1.5">
          <input type="hidden" name="meetingId" value={meetingId} />
          <label htmlFor={`attr-${meetingId}`} className="text-[12px] font-medium text-ink-700">
            Credit this meeting to
          </label>
          <Select
            id={`attr-${meetingId}`}
            name="newCreditedUserId"
            className="h-8 w-auto text-[13px]"
            required
          >
            {interns.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
          <Input
            name="reason"
            required
            minLength={3}
            maxLength={300}
            placeholder="Reason (audited)"
            className="h-8 text-[13px]"
            aria-label="Reason for the attribution change"
          />
          {attrState.status === 'error' && attrState.message ? (
            <p role="alert" className="max-w-xs text-[12px] font-medium text-brand-600">
              {attrState.message}
            </p>
          ) : null}
          <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
            Change attribution
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
