'use client';

import { useActionState, useState } from 'react';
import { submitProjectAction } from '@/app/(intern)/training/actions';
import { FormFeedback, SubmitButton } from '@/components/client/form';
import { Checkbox, Field, Input, Textarea, buttonClass } from '@/components/ui';
import { IDLE } from '@/lib/form';

export function ProjectSubmissionForm({
  projectId,
  lastSubmittedAt,
}: {
  projectId: string;
  lastSubmittedAt: string | null;
}) {
  const [state, dispatch] = useActionState(submitProjectAction, IDLE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={buttonClass('secondary', 'sm')}
        >
          {lastSubmittedAt ? 'Add an update' : 'Submit work'}
        </button>
        {lastSubmittedAt ? (
          <span className="text-[12px] text-ink-500">
            Last submitted {new Date(lastSubmittedAt).toLocaleDateString()}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form action={dispatch} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={projectId} />
      <FormFeedback state={state} />
      <Field label="Notes" htmlFor={`notes-${projectId}`} error={state.fieldErrors.notes}>
        <Textarea id={`notes-${projectId}`} name="notes" rows={3} maxLength={4000} />
      </Field>
      <Field label="Link" htmlFor={`link-${projectId}`} error={state.fieldErrors.linkUrl}>
        <Input id={`link-${projectId}`} name="linkUrl" inputMode="url" placeholder="https://…" />
      </Field>
      <Checkbox id={`ready-${projectId}`} name="markReady" label="Mark as ready for review" />
      <div className="flex gap-2">
        <SubmitButton size="sm" pendingLabel="Saving…">
          Save
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}
