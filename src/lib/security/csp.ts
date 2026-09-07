/**
 * One Content-Security-Policy, built in one place.
 *
 * `next.config.ts` sets the static fallback on every response; `src/proxy.ts`
 * replaces it per request with a nonce so that inline scripts do not need
 * `'unsafe-inline'`. Both call this, so the two can never drift apart.
 *
 * This module is imported by the Next config (plain Node) and by the proxy
 * (edge runtime), so it must stay dependency-free.
 */

export type CspOptions = {
  /** Per-request nonce. Omitted for the static fallback. */
  nonce?: string;
  isDev?: boolean;
  /** Adds `upgrade-insecure-requests`, which only makes sense over HTTPS. */
  https?: boolean;
};

export function contentSecurityPolicy({ nonce, isDev = false, https = false }: CspOptions): string {
  const script = nonce
    ? // 'strict-dynamic' makes the browser trust only scripts the nonced
      // bootstrap itself loads, and ignore host allowlists entirely. Browsers
      // that do not understand it fall back to 'self'.
      `'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`
    : `'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`;

  const directives = [
    "default-src 'self'",
    `script-src ${script}`,
    // React and Next emit inline style attributes for streamed segments;
    // Tailwind itself compiles to a static stylesheet. Inline styles cannot
    // execute script, so this is the one relaxation kept.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? ' ws:' : ''}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];

  if (https) directives.push('upgrade-insecure-requests');

  return directives.join('; ');
}
