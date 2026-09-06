/**
 * Server-only guard.
 *
 * The `server-only` npm package is a build-time barrier, but it also makes a
 * module unimportable from plain Node (CLI scripts, Vitest), which several of
 * these modules legitimately need. This runtime guard gives the same
 * protection against a server module leaking into the browser bundle while
 * staying importable from the test and script runners.
 *
 * Modules that are inherently Next-only (they import `next/headers` and so can
 * never be a client component) use the real `server-only` package instead.
 */
if (typeof window !== 'undefined') {
  throw new Error(
    'A server-only module was imported into browser code. Move the call behind a server action or route handler.',
  );
}

export {};
