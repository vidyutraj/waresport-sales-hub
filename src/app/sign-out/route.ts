import { NextResponse } from 'next/server';
import { signOutCurrentSession } from '@/lib/auth/session';
import { env } from '@/lib/env';

/**
 * POST-only sign-out endpoint.
 *
 * GET is intentionally not implemented: a sign-out reachable by GET is fired
 * by link prefetching, speculative navigation, or a cross-site `<img>` tag,
 * which logs users out at random. The UI uses the `signOutAction` server
 * action; this route exists for scripts and for a no-JavaScript fallback.
 */
export async function POST(request: Request) {
  // Reject a cross-site form post outright.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(env().APP_URL).origin) {
    return new NextResponse('Cross-origin sign-out is not allowed', { status: 403 });
  }
  await signOutCurrentSession();
  return NextResponse.redirect(new URL('/sign-in', env().APP_URL), { status: 303 });
}

export async function GET() {
  return new NextResponse('Use POST to sign out.', {
    status: 405,
    headers: { Allow: 'POST' },
  });
}
