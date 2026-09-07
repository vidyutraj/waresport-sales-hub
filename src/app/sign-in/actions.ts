'use server';

import { redirect } from 'next/navigation';
import { findSignInChoice, startSessionForUser } from '@/lib/auth/service';
import { clientIp, clientUserAgent, setSessionCookie } from '@/lib/auth/session';
import { fail, type FormState } from '@/lib/form';

/**
 * Sign-in server actions.
 *
 * An intern picks their name and is in. An admin or owner picks their name and
 * is sent to a password step. Which of the two happens is decided by the
 * server from the stored user row, so posting straight to `signInAsAction`
 * with an admin's id gets a password prompt, not a session.
 */

const MESSAGES = {
  not_found: 'That account no longer exists. Pick another one.',
  deactivated: 'That account has been deactivated. Ask an admin to reactivate it.',
  password_not_set:
    'That account has no password yet, so it cannot be signed into. Set one on the server with npm run user:set-password.',
  password_required: 'Enter the password for that account.',
  wrong_password: 'That password is not correct.',
  locked: 'Too many wrong passwords. Try again in a few minutes.',
} as const;

export async function signInAsAction(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');

  const choice = await findSignInChoice(userId);
  if (choice === null) redirect(`/sign-in?error=${encodeURIComponent(MESSAGES.not_found)}`);
  if (choice.passwordMissing) {
    redirect(`/sign-in?error=${encodeURIComponent(MESSAGES.password_not_set)}`);
  }
  // Admins and owners take the password step instead of signing in here.
  if (choice.requiresPassword) redirect(`/sign-in?user=${encodeURIComponent(choice.id)}`);

  const result = await startSessionForUser({
    userId,
    ip: await clientIp(),
    userAgent: await clientUserAgent(),
  });
  if (!result.ok) {
    redirect(`/sign-in?error=${encodeURIComponent(MESSAGES[result.reason] ?? MESSAGES.not_found)}`);
  }

  await setSessionCookie(result.sessionToken);
  redirect('/');
}

export async function signInWithPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const userId = String(formData.get('userId') ?? '');
  const password = String(formData.get('password') ?? '');

  const result = await startSessionForUser({
    userId,
    password,
    ip: await clientIp(),
    userAgent: await clientUserAgent(),
  });

  if (!result.ok) {
    const message =
      result.reason === 'locked' && result.retryAfterSeconds
        ? `Too many wrong passwords. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`
        : (MESSAGES[result.reason] ?? MESSAGES.not_found);
    // Deliberately the same shape for every failure: a wrong password and a
    // deactivated account are both just "you are not getting in".
    return fail(message);
  }

  await setSessionCookie(result.sessionToken);
  redirect('/');
}
