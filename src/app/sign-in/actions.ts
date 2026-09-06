'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requestAccessCode, verifyAccessCode } from '@/lib/auth/service';
import { clientIp, clientUserAgent, setSessionCookie } from '@/lib/auth/session';
import { MailDeliveryError } from '@/lib/auth/mailer';

/**
 * Sign-in / invitation-claim server actions.
 *
 * Responses never reveal whether an address has an account: a request for an
 * unknown address returns the same "code sent" state as a known one.
 */

export type RequestCodeState = {
  status: 'idle' | 'sent' | 'error';
  message: string | null;
  email: string | null;
  cooldownSeconds: number;
};

const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.'),
});

export async function requestCodeAction(
  _prev: RequestCodeState,
  formData: FormData,
): Promise<RequestCodeState> {
  const parsed = emailSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return {
      status: 'error',
      message: parsed.error.issues[0]?.message ?? 'Enter a valid email address.',
      email: String(formData.get('email') ?? ''),
      cooldownSeconds: 0,
    };
  }

  const email = parsed.data.email.toLowerCase();

  try {
    const result = await requestAccessCode({ email, ip: await clientIp() });

    if (!result.ok) {
      if (result.reason === 'cooldown') {
        return {
          status: 'sent',
          message: `A code was just sent. You can request another in ${result.retryAfterSeconds}s.`,
          email,
          cooldownSeconds: result.retryAfterSeconds,
        };
      }
      if (result.reason === 'rate_limited') {
        return {
          status: 'error',
          message: 'Too many requests from this address. Try again in about 15 minutes.',
          email,
          cooldownSeconds: result.retryAfterSeconds,
        };
      }
      return {
        status: 'error',
        message: 'Enter a valid email address.',
        email,
        cooldownSeconds: 0,
      };
    }

    return {
      status: 'sent',
      message: null,
      email,
      cooldownSeconds: result.cooldownSeconds,
    };
  } catch (error) {
    if (error instanceof MailDeliveryError) {
      return {
        status: 'error',
        message:
          'The workspace could not send email just now. Tell an admin the mail provider is not reachable.',
        email,
        cooldownSeconds: 0,
      };
    }
    throw error;
  }
}

export type VerifyState = {
  status: 'idle' | 'error';
  message: string | null;
  attemptsRemaining: number | null;
};

const verifySchema = z.object({
  email: z.string().trim().email(),
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Enter the 6-digit code from your email.'),
});

export async function verifyCodeAction(
  _prev: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  const parsed = verifySchema.safeParse({
    email: formData.get('email'),
    code: String(formData.get('code') ?? '').replace(/\s+/g, ''),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: parsed.error.issues[0]?.message ?? 'Enter the 6-digit code from your email.',
      attemptsRemaining: null,
    };
  }

  const result = await verifyAccessCode({
    email: parsed.data.email,
    code: parsed.data.code,
    ip: await clientIp(),
    userAgent: await clientUserAgent(),
  });

  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      invalid_code: 'That code is not correct.',
      expired: 'That code has expired. Request a new one.',
      too_many_attempts: 'Too many incorrect attempts. Request a new code.',
      rate_limited: 'Too many attempts. Try again in about 15 minutes.',
      // Deliberately identical to the invited-but-wrong-code message shape: a
      // verified stranger learns nothing about who does have access.
      no_access: 'That address does not have access to this workspace.',
      deactivated: 'That account has been deactivated. Contact an admin.',
    };
    return {
      status: 'error',
      message: messages[result.reason],
      attemptsRemaining: result.attemptsRemaining ?? null,
    };
  }

  await setSessionCookie(result.sessionToken);
  redirect('/');
}
