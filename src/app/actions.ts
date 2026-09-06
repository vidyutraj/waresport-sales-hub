'use server';

import { redirect } from 'next/navigation';
import { signOutCurrentSession } from '@/lib/auth/session';

/**
 * Sign out.
 *
 * Deliberately a POST-only server action rather than a link. A GET sign-out is
 * triggered by anything that fetches the URL — Next.js link prefetching, a
 * browser's speculative loader, or a hostile `<img src="/sign-out">` on another
 * site — which silently ends the session. Next's server actions also carry an
 * origin check, so this cannot be driven from another site.
 */
export async function signOutAction(): Promise<void> {
  await signOutCurrentSession();
  redirect('/sign-in');
}
