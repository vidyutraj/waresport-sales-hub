'use client';

import { signInWithPasswordAction } from '@/app/sign-in/actions';
import { ActionForm, SubmitButton } from '@/components/client/form';
import { Field, Input } from '@/components/ui';

/** The password step for an admin or owner account. */
export function PasswordGateForm({ userId, name }: { userId: string; name: string }) {
  return (
    <ActionForm action={signInWithPasswordAction}>
      {(state) => (
        <>
          <input type="hidden" name="userId" value={userId} />
          <Field
            label={`Password for ${name}`}
            htmlFor="admin-password"
            required
            error={state.fieldErrors.password}
          >
            <Input
              id="admin-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              autoFocus
            />
          </Field>
          <div>
            <SubmitButton pendingLabel="Checking…">Sign in</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
