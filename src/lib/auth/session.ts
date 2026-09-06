import 'server-only';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { env } from '@/lib/env';
import { loadSessionUser, revokeSession, type AuthenticatedUser } from './service';
import { SESSION_COOKIE_NAME } from './tokens';

/**
 * Request-scoped session access.
 *
 * `currentUser()` is memoised per request with React's `cache`, so a page that
 * checks authorization in several places still performs one session lookup.
 */

export const currentUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return loadSessionUser(token);
});

export async function setSessionCookie(token: string): Promise<void> {
  const e = env();
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Keyed to the actual scheme rather than NODE_ENV: a Secure cookie set over
    // plain HTTP is stored by some browsers but not sent back on same-site
    // POSTs, which silently breaks every server action. Any real deployment
    // serves HTTPS, so this is `true` wherever it matters.
    secure: e.APP_URL.startsWith('https://'),
    path: '/',
    maxAge: e.SESSION_TTL_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

export async function signOutCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (token) await revokeSession(token);
  store.delete(SESSION_COOKIE_NAME);
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return h.get('x-real-ip');
}

export async function clientUserAgent(): Promise<string | null> {
  return (await headers()).get('user-agent');
}

// ---------------------------------------------------------------------------
// Authorization guards. Every server action and route handler starts with one
// of these; RLS in the database is the second, independent line of defence.
// ---------------------------------------------------------------------------

export class AuthorizationError extends Error {
  constructor(message = 'You do not have permission to do that.') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/** Any signed-in, active account. Redirects to sign-in when there is none. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await currentUser();
  if (!user) redirect('/sign-in');
  return user;
}

/** A signed-in user who has finished onboarding. */
export async function requireOnboardedUser(): Promise<AuthenticatedUser> {
  const user = await requireUser();
  if (user.onboardingCompletedAt === null) redirect('/onboarding');
  return user;
}

export async function requireAdmin(): Promise<AuthenticatedUser> {
  const user = await requireOnboardedUser();
  if (user.role !== 'admin' && user.role !== 'owner') redirect('/denied');
  return user;
}

export async function requireOwner(): Promise<AuthenticatedUser> {
  const user = await requireOnboardedUser();
  if (user.role !== 'owner') redirect('/denied');
  return user;
}

export async function requireIntern(): Promise<AuthenticatedUser> {
  const user = await requireOnboardedUser();
  if (user.role !== 'intern') redirect('/denied');
  return user;
}

/** Guard variants for server actions, which throw rather than redirect. */
export async function assertUser(): Promise<AuthenticatedUser> {
  const user = await currentUser();
  if (!user) throw new AuthorizationError('You are signed out. Sign in again to continue.');
  return user;
}

export async function assertAdmin(): Promise<AuthenticatedUser> {
  const user = await assertUser();
  if (user.role !== 'admin' && user.role !== 'owner') {
    throw new AuthorizationError('Only an admin or owner can do that.');
  }
  return user;
}

export async function assertOwner(): Promise<AuthenticatedUser> {
  const user = await assertUser();
  if (user.role !== 'owner') throw new AuthorizationError('Only the owner can do that.');
  return user;
}

export function isAdminRole(role: AuthenticatedUser['role']): boolean {
  return role === 'admin' || role === 'owner';
}

export function displayName(user: {
  preferredName?: string | null;
  fullName?: string | null;
  email: string;
}): string {
  return user.preferredName?.trim() || user.fullName?.trim() || user.email;
}
