# Security

This is an internal business-development workspace holding prospect contact
details and intern performance data. It is not a public product. The threat
model is a small trusted team, an internet-exposed host, and the assumption that
any account may be careless rather than hostile.

## Reporting something

Email the workspace owner directly. Please do not open a public issue for a
suspected vulnerability.

---

## The one thing to understand first

**Intern sign-in is identification, not authentication.** `/sign-in` lists every
active profile and picking one starts a session. Anyone who can reach the site
can sign in as any intern. That is a deliberate trade for a small internal tool,
and it means:

- The site should sit behind a network boundary (VPN, IP allowlist, or an
  authenticating proxy) if the data matters more than the convenience.
- **Admin and owner accounts are password-gated** — see below. That is what
  keeps the destructive surface closed.

Swap in real authentication by replacing `src/lib/auth/*`: the picker and
`startSessionForUser` become a credential check ending in the same `sessions`
insert. Nothing downstream of `currentUser()` changes.

## Authentication and sessions

- Session tokens are 32 bytes of CSPRNG entropy, stored **only** as a keyed
  SHA-256 digest. A database dump cannot be replayed as a login.
- The cookie is `httpOnly`, `SameSite=Lax`, `Secure` whenever `APP_URL` is
  HTTPS, and uses the `__Host-` prefix there, so no subdomain and nothing
  speaking plain HTTP can overwrite it.
- Deactivating an account revokes its live sessions on the next request.
- Sign-out is POST-only. A GET sign-out is fired by link prefetching and by a
  cross-site `<img>` tag.

## Admin passwords

- scrypt (N=16384, r=8, p=1), 16-byte random salt, parameters stored alongside
  the hash so they can be raised later without invalidating old ones.
- Verification is constant-time; a malformed or tampered stored hash reads as
  "wrong password" rather than throwing.
- Ten wrong attempts locks the account for fifteen minutes.
- An admin or owner row **with no password cannot be signed into at all**, so
  there is no window where the admin portal is reachable by picking a card.
- Passwords are writable only on the privileged connection. The
  `users_guard_password` trigger rejects any password write that arrives on the
  request-scoped role, so no application bug can set one.

## Authorization

Two independent layers, and the second does not trust the first:

1. Every server action and route handler starts with `assertAdmin()`,
   `requireOwner()`, or similar. Roles come from the stored user row, never
   from client input.
2. PostgreSQL row level security. All business queries run as `waresport_app`,
   which owns no tables and has `NOBYPASSRLS`, with the actor pinned per
   transaction. `tests/integration/authorization.test.ts` calls the privileged
   paths as an intern against the live database and expects denial.

Database-enforced invariants that application code cannot bypass: at least one
active owner, one current assignment per club, append-only activity (corrections
are audited voids), and no self-granted privileges.

## Transport and browser hardening

Set in `next.config.ts` and `src/proxy.ts`, so they travel with the app rather
than depending on the host:

- `Content-Security-Policy` with a **per-request nonce** and `strict-dynamic`;
  no `unsafe-inline` for scripts, no `unsafe-eval` outside development,
  `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`.
- `Strict-Transport-Security` two years, `includeSubDomains`, preload-eligible.
- `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  a `Permissions-Policy` denying every device capability, and
  `X-Robots-Tag: noindex` (plus a `Disallow: /` robots.txt).
- `X-Powered-By` removed.

## Data handling

- Imported prospect data is real personal data. `private/` and `storage/` are
  git-ignored; no real contact data belongs in the repository or in a fixture.
- Uploaded resource files live outside the web root and are served only through
  an authorization-checked route.
- Audit rows record who did what, before and after. IP addresses are stored
  hashed, never raw.
- Logs never carry session tokens, passwords or contact datasets.
- CSV exports are generated per request under the same RLS as the UI.

## Configuration safety

`src/lib/env.ts` refuses to boot a production deployment that:

- still uses the example `AUTH_SECRET`,
- serves over plain HTTP (which would silently drop the cookie's `Secure` flag),
- reaches a non-private database without TLS, or
- points `APP_DATABASE_URL` at the owning role, which would bypass RLS entirely.

Loopback is exempt, so `npm run build` and the acceptance suite still run.

## Dependencies

`npm audit --audit-level=high` runs in CI on every push and pull request. The
dependency list is deliberately short; adding one is a decision, not a reflex.
