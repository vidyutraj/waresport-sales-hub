'use client';

import { useActionState, useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Alert, buttonClass } from '@/components/ui';
import { IDLE, type FormState } from '@/lib/form';

/**
 * Thin wrappers over React's form actions.
 *
 * `ActionForm` gives every form the same success/error surface, a disabled
 * submit while pending (which is also what makes a double-click harmless on
 * the client, with server-side idempotency keys as the real guarantee), and an
 * `aria-live` region so screen readers hear the result.
 */

export function SubmitButton({
  children,
  pendingLabel = 'Working…',
  variant = 'primary',
  size = 'md',
  className,
  disabled,
  ...props
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      {...props}
      disabled={pending || disabled}
      aria-busy={pending}
      className={clsx(buttonClass(variant, size), className)}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

export function FormFeedback({ state }: { state: FormState }) {
  return (
    <div aria-live="polite" aria-atomic="true">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}
      {state.status === 'success' && state.message ? (
        <Alert tone="positive">{state.message}</Alert>
      ) : null}
    </div>
  );
}

export function ActionForm({
  action,
  children,
  className,
  initialState = IDLE,
  feedbackPosition = 'top',
  id,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: (state: FormState) => ReactNode;
  className?: string;
  initialState?: FormState;
  feedbackPosition?: 'top' | 'bottom' | 'none';
  id?: string;
}) {
  const [state, dispatch] = useActionState(action, initialState);
  const generatedId = useId();
  return (
    <form
      action={dispatch}
      id={id ?? generatedId}
      className={clsx('flex flex-col gap-4', className)}
      noValidate
    >
      {feedbackPosition === 'top' ? <FormFeedback state={state} /> : null}
      {children(state)}
      {feedbackPosition === 'bottom' ? <FormFeedback state={state} /> : null}
    </form>
  );
}

/**
 * A one-button form for a simple state change (complete a follow-up, verify a
 * meeting). When `confirm` is supplied the button becomes a two-step inline
 * confirmation rather than a native `confirm()` dialog: a browser modal blocks
 * the page, cannot be styled, and is unreachable to some assistive tech.
 */
export function ActionButton({
  action,
  fields,
  children,
  variant = 'secondary',
  size = 'sm',
  confirm,
  pendingLabel,
  className,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  fields: Record<string, string>;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  confirm?: string;
  pendingLabel?: string;
  className?: string;
}) {
  const [state, dispatch] = useActionState(action, IDLE);
  const [confirming, setConfirming] = useState(false);

  return (
    <form action={dispatch} className={className}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {confirm && !confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={buttonClass(variant, size)}
        >
          {children}
        </button>
      ) : null}

      {confirm && confirming ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span role="status" className="text-[12px] text-ink-600">
            {confirm}
          </span>
          <SubmitButton variant="danger" size={size} pendingLabel={pendingLabel}>
            Confirm
          </SubmitButton>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className={buttonClass('ghost', size)}
          >
            Cancel
          </button>
        </span>
      ) : null}

      {!confirm ? (
        <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel}>
          {children}
        </SubmitButton>
      ) : null}

      {state.status === 'error' && state.message ? (
        <p role="alert" className="mt-1 text-[12px] font-medium text-brand-600">
          {state.message}
        </p>
      ) : null}
      {state.status === 'success' && state.message ? (
        <p role="status" className="mt-1 text-[12px] font-medium text-positive-600">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
