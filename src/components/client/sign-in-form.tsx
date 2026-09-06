'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  requestCodeAction,
  verifyCodeAction,
  type RequestCodeState,
  type VerifyState,
} from '@/app/sign-in/actions';
import { Alert, Button, Field, Input } from '@/components/ui';

/**
 * Two-step email sign-in: request a one-time code, then enter it.
 *
 * The same component serves a returning user and an invited intern claiming
 * their invitation, because the server decides which of the two it is.
 */

function SubmitButton({ children, idleLabel }: { children?: string; idleLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Working…' : (children ?? idleLabel)}
    </Button>
  );
}

const initialRequest: RequestCodeState = {
  status: 'idle',
  message: null,
  email: null,
  cooldownSeconds: 0,
};
const initialVerify: VerifyState = { status: 'idle', message: null, attemptsRemaining: null };

export function SignInForm({ initialEmail }: { initialEmail?: string }) {
  const [requestState, requestAction] = useActionState(requestCodeAction, initialRequest);
  const [verifyState, verifyAction] = useActionState(verifyCodeAction, initialVerify);
  const [cooldown, setCooldown] = useState(0);

  // Start the countdown when a new code has just been sent, using React's
  // "adjusting state when a prop changes" pattern rather than a setState inside
  // an effect (which would render twice on every request).
  const [lastRequestState, setLastRequestState] = useState(requestState);
  if (lastRequestState !== requestState) {
    setLastRequestState(requestState);
    if (requestState.status === 'sent') setCooldown(requestState.cooldownSeconds);
  }

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  if (requestState.status === 'sent' && requestState.email) {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="info" title="Check your email">
          <p>
            If <strong>{requestState.email}</strong> has access to this workspace, a 6-digit code is
            on its way. It expires shortly and can be used once.
          </p>
        </Alert>

        {requestState.message ? <Alert tone="caution">{requestState.message}</Alert> : null}

        <form action={verifyAction} className="flex flex-col gap-4" noValidate>
          <input type="hidden" name="email" value={requestState.email} />
          <Field
            label="Verification code"
            htmlFor="code"
            required
            hint="Six digits, from the email we just sent."
            error={verifyState.message}
          >
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              aria-describedby="code-hint"
              aria-invalid={verifyState.status === 'error'}
              className="text-center text-lg tracking-[0.4em]"
            />
          </Field>
          {verifyState.attemptsRemaining !== null ? (
            <p className="text-[12px] text-ink-500">
              {verifyState.attemptsRemaining} attempt
              {verifyState.attemptsRemaining === 1 ? '' : 's'} remaining before this code is locked.
            </p>
          ) : null}
          <SubmitButton idleLabel="Verify and continue" />
        </form>

        <form action={requestAction}>
          <input type="hidden" name="email" value={requestState.email} />
          <button
            type="submit"
            disabled={cooldown > 0}
            className="text-[13px] font-medium text-brand-600 underline underline-offset-2 disabled:cursor-not-allowed disabled:text-ink-400 disabled:no-underline"
          >
            {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Send a new code'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <form action={requestAction} className="flex flex-col gap-4" noValidate>
      <Field
        label="Work email"
        htmlFor="email"
        required
        hint="Use the address your invitation was sent to."
        error={requestState.status === 'error' ? requestState.message : null}
      >
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          defaultValue={requestState.email ?? initialEmail ?? ''}
          aria-describedby="email-hint"
          aria-invalid={requestState.status === 'error'}
          placeholder="you@waresport.com"
        />
      </Field>
      <SubmitButton idleLabel="Email me a sign-in code" />
    </form>
  );
}
