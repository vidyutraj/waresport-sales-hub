'use client';

import { useActionState, useState } from 'react';
import { reviewSubmissionAction } from '@/app/admin/resources/actions';
import { SubmitButton } from '@/components/client/form';
import { Checkbox, Textarea, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

export function SubmissionReviewForm({
  submissionId,
  existingFeedback,
}: {
  submissionId: string;
  existingFeedback: string | null;
}) {
  const [state, dispatch] = useActionState(reviewSubmissionAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={buttonClass('secondary', 'sm')}
        >
          {existingFeedback ? 'Edit feedback' : 'Give feedback'}
        </button>
        {existingFeedback ? (
          <span className="text-[12px] text-ink-600">“{existingFeedback}”</span>
        ) : null}
        {state.status === 'success' && state.message ? (
          <span role="status" className="text-[12px] text-positive-700">
            {state.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form action={dispatch} className="flex flex-col gap-2">
      <input type="hidden" name="submissionId" value={submissionId} />
      <label htmlFor={`fb-${submissionId}`} className="text-[12px] font-medium text-ink-700">
        Feedback
      </label>
      <Textarea
        id={`fb-${submissionId}`}
        name="feedback"
        rows={3}
        required
        maxLength={4000}
        defaultValue={existingFeedback ?? ''}
      />
      <Checkbox
        id={`cp-${submissionId}`}
        name="markComplete"
        label="Mark this project complete for them"
      />
      {state.status === 'error' && state.message ? (
        <p role="alert" className="text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
      <div className="flex gap-2">
        <SubmitButton size="sm" pendingLabel="Saving…">
          Save feedback
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}
