'use client';

import { logConnectionAction } from '@/app/(intern)/linkedin/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input, Textarea } from '@/components/ui';

/**
 * Log one accepted LinkedIn connection: name, link, and anything worth
 * remembering.
 *
 * Three fields on purpose. This is filled in dozens of times a week, so every
 * extra field is a tax on the person doing the actual work.
 */
export function LogConnectionForm() {
  return (
    <ActionForm action={logConnectionAction}>
      {(state) => {
        // Restored after a rejected submission; React resets the form itself.
        const kept = state.values ?? {};
        const failed = state.status === 'error';
        return (
          <>
            <Field
              label="Name"
              htmlFor="connection-name"
              required
              error={state.fieldErrors.fullName}
            >
              <Input
                id="connection-name"
                name="fullName"
                required
                placeholder="Jordan Lee"
                autoComplete="off"
                defaultValue={failed ? (kept.fullName ?? '') : ''}
              />
            </Field>

            <Field
              label="LinkedIn profile link"
              htmlFor="connection-url"
              required
              hint="Paste the URL from their profile page."
              error={state.fieldErrors.profileUrl}
            >
              <Input
                id="connection-url"
                name="profileUrl"
                required
                inputMode="url"
                placeholder="https://www.linkedin.com/in/jordanlee"
                defaultValue={failed ? (kept.profileUrl ?? '') : ''}
              />
            </Field>

            <Field
              label="Notes"
              htmlFor="connection-notes"
              hint="Optional. What they do, what you talked about, anything to pick up next time."
              error={state.fieldErrors.notes}
            >
              <Textarea
                id="connection-notes"
                name="notes"
                rows={3}
                maxLength={1000}
                defaultValue={failed ? (kept.notes ?? '') : ''}
              />
            </Field>

            <div>
              <SubmitButton pendingLabel="Logging…">Log connection</SubmitButton>
            </div>
          </>
        );
      }}
    </ActionForm>
  );
}
