'use server';

import { redirect } from 'next/navigation';
import { startSessionForUser } from '@/lib/auth/service';
import { clientIp, clientUserAgent, setSessionCookie } from '@/lib/auth/session';

/**
 * Sign-in server action.
 *
 * There is no password and no code: you pick your name and the server starts a
 * session for that account. The role always comes from the stored user row, so
 * a forged `userId` can only ever get you the account it names — which the
 * picker lists anyway.
 */
export async function signInAsAction(formData: FormData): Promise<void> {
  const userId = String(formData.get('userId') ?? '');

  const result = await startSessionForUser({
    userId,
    ip: await clientIp(),
    userAgent: await clientUserAgent(),
  });

  if (!result.ok) {
    const message =
      result.reason === 'deactivated'
        ? 'That account has been deactivated. Ask an admin to reactivate it.'
        : 'That account no longer exists. Pick another one.';
    redirect(`/sign-in?error=${encodeURIComponent(message)}`);
  }

  await setSessionCookie(result.sessionToken);
  redirect('/');
}
