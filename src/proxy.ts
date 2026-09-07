import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from '@/lib/security/csp';

/**
 * Per-request Content-Security-Policy nonce.
 *
 * Next 16 calls this file `proxy.ts` (it was `middleware.ts` before). It does
 * exactly one thing: mint a nonce, hand it to the renderer through the request
 * headers so Next stamps it on its own bootstrap scripts, and set the matching
 * response header. That turns `script-src 'unsafe-inline'` — which permits any
 * injected inline script — into a policy where only scripts carrying this
 * request's unguessable nonce run.
 *
 * It is deliberately *not* doing authentication. Session checks stay in the
 * server components and actions that need them, next to the data, where they
 * cannot be skipped by a matcher mistake.
 */
export function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const csp = contentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    https: request.nextUrl.protocol === 'https:',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next reads the policy back off the request to nonce its own script tags.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except the static asset paths, which are immutable files that
     * execute nothing and would only burn a nonce each:
     *   _next/static, _next/image, favicon.ico, and the well-known files.
     */
    {
      source: '/((?!_next/static|_next/image|favicon.ico|robots.txt).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
