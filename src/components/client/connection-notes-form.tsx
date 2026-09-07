'use client';

import { useState } from 'react';
import { saveConnectionNotesAction } from '@/app/(intern)/linkedin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Textarea, buttonClass } from '@/components/ui';

/**
 * Notes on one connection, edited in place.
 *
 * Notes are working memory rather than a logged action, so unlike outreach they
 * can be changed. Collapsed until opened, so a long list stays readable.
 */
export function ConnectionNotesForm({
  prospectId,
  name,
  notes,
}: {
  prospectId: string;
  name: string;
  notes: string | null;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] whitespace-pre-line text-ink-700">
          {notes?.trim() ? notes : <span className="text-ink-400">No notes yet</span>}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={buttonClass('secondary', 'sm')}
        >
          {notes?.trim() ? 'Edit notes' : 'Add notes'}
        </button>
      </div>
    );
  }

  return (
    <ActionForm action={saveConnectionNotesAction} feedbackPosition="bottom">
      {(state) => (
        <>
          <input type="hidden" name="prospectId" value={prospectId} />
          <label htmlFor={`notes-${prospectId}`} className="sr-only">
            Notes on {name}
          </label>
          <Textarea
            id={`notes-${prospectId}`}
            name="notes"
            rows={3}
            maxLength={1000}
            defaultValue={notes ?? ''}
            autoFocus
          />
          <div className="flex gap-2">
            <SubmitButton pendingLabel="Saving…">Save notes</SubmitButton>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={buttonClass('secondary', 'sm')}
            >
              {state.status === 'success' ? 'Close' : 'Cancel'}
            </button>
          </div>
        </>
      )}
    </ActionForm>
  );
}
