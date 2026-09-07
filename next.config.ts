import type { NextConfig } from 'next';
import { contentSecurityPolicy } from './src/lib/security/csp';

/**
 * Response headers are set here rather than at the edge of whatever hosts this,
 * so they travel with the application and are identical in development,
 * acceptance and production.
 *
 * The Content-Security-Policy is completed per request in `src/proxy.ts`, which
 * mints a nonce and rewrites `script-src`. This file carries the static
 * fallback, so a route the proxy does not match is never left unprotected.
 */

const isDev = process.env.NODE_ENV === 'development';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server bundle, so a container image does not ship
  // node_modules. Vercel builds its own runtime and does not want it, so it is
  // only set elsewhere.
  output: process.env.VERCEL ? undefined : 'standalone',
  async headers() {
    const headers = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      // This app asks for no device capabilities at all.
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
      },
      { key: 'Content-Security-Policy', value: contentSecurityPolicy({ isDev }) },
      // Internal workspace: never index it, and never let a preview leak.
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
    ];

    if (!isDev) {
      // Two years, subdomains included, preload-eligible. Only meaningful over
      // HTTPS, and ignored by browsers on plain HTTP.
      headers.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      });
    }

    return [{ source: '/:path*', headers }];
  },
};

export default nextConfig;
