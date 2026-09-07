# Architecture and data model

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript 5.9 | Server components keep authorization and data access on the server; server actions give progressively-enhanced forms without a separate API surface. |
| Database | PostgreSQL 17 | Row level security, partial unique indexes and transactions do the correctness work that application code would otherwise get wrong. |
| Data access | `postgres` (postgres.js), hand-written SQL | The correctness rules here are transactional and index-shaped; an ORM would obscure them. |
| Auth | Pick-your-profile sign-in, DB-backed sessions | Internal tool on a trusted network. See "Deviation from the suggested stack" below. |
| Validation | Zod 4 | One schema per action, server-side. Client validation is UX only. |
| Styling | Tailwind CSS 4 with `@theme` tokens | Brand values are declared once in `src/app/globals.css`. |
| Tests | Vitest 4 (unit + integration), Playwright 1.63 (E2E) | Integration tests run against real PostgreSQL with RLS on; E2E drives a production build. |
| Local infra | Docker Compose: `postgres:17-alpine` | One small container. The app sends no email. |

### Deviation from the suggested stack

The brief suggested Supabase (Postgres + GoTrue + Inbucket). This build uses
**PostgreSQL directly, with sign-in reduced to picking your own profile**. Two
reasons:

1. **Disk.** The full Supabase local stack pulls roughly 4 GB of images. The
   build machine had 14 GiB free (99% full). Postgres alone is ~80 MB.
2. **Scope.** This is an internal workspace for one small team on a trusted
   network. Accounts are created from the backend (`npm run user:create`, or
   *Interns → Add someone*) and people sign in by choosing their name; there is
   no password, no email code and no self-signup.

**This is identification, not authentication.** Anyone who can reach the app can
sign in as anyone listed, so the app must not be exposed publicly. What it is
*not* is an authorization hole: the role comes from the stored user row, never
from the request, deactivation revokes live sessions on the next request, and
every business query still runs under row level security.

Row level security is used exactly as it would be with Supabase. All business
queries run through a `waresport_app` role that owns no tables and has
`NOBYPASSRLS`, with the actor pinned per transaction. The policies in
`db/migrations/0008_policies.sql` are the real enforcement, and
`tests/integration/authorization.test.ts` proves it against the live database.

Adding real authentication later means replacing `src/lib/auth/*` — the picker
and `startSessionForUser` become a credential check that ends in the same
`sessions` insert. Everything downstream of `currentUser()` is unaffected.

---

## Two database connections, on purpose

`src/lib/db.ts` exposes exactly two pools:

```
systemSql()  → DATABASE_URL      (table owner; bypasses RLS)
appSql()     → APP_DATABASE_URL  (waresport_app; NOBYPASSRLS, owns nothing)
```

**`asSystem()` is used only where no session identity exists yet**, and the list
is short and closed:

- `scripts/migrate.ts`, `scripts/seed.ts`, `scripts/create-user.ts`
- `src/lib/auth/service.ts` — listing the sign-in choices, starting and loading
  sessions, creating accounts
- test fixtures (`tests/integration/factories.ts`)

**Everything else runs through `asUser(userId, fn)`**, which opens a transaction
and pins the actor:

```ts
await appSql().begin(async (tx) => {
  await tx`SELECT set_config('app.user_id', ${userId}, true)`;
  return fn(tx);
});
```

`set_config(..., true)` is transaction-local, so the identity cannot leak to the
next borrower of a pooled connection.

### Savepoints

PostgreSQL aborts an entire transaction when a statement raises, so catching a
unique-violation in JavaScript is not enough — every later statement on that
connection would fail. `attempt(tx, fn)` wraps a risky statement in a SAVEPOINT
and returns a result instead of throwing. It is used wherever a constraint
violation is an *expected* outcome: duplicate assignment claims, repeated
connection requests, concurrent payouts, idempotent import upserts, and
concurrent account creation.

---

## Data model

Tables, grouped by migration. Foreign keys, indexes and constraints are in
`db/migrations/`.

### Identity and access — `0001_core.sql`

- **`users`** — one row per person: email (citext, unique), `role`
  (`owner|admin|intern`), `status` (`invited|active|deactivated`), profile
  fields, `row_version` for optimistic locking. Rows are created only from the
  backend; `/sign-in` lists every non-deactivated one.
- **`sessions`** — opaque tokens stored only as a keyed SHA-256 digest.
- `auth_codes`, `invitations` and `rate_limits` existed for the original
  one-time-code sign-in and were dropped in `0011_drop_email_auth.sql`.
- **`cohorts`**, **`territories`**, **`territory_states`**,
  **`cohort_memberships`** — program scaffolding. `cohort_memberships_one_active`
  keeps an intern in at most one active cohort.

### Leads — `0002_leads.sql`

- **`organizations`** — clubs. `name_normalized` and `city_normalized` are
  generated columns backed by IMMUTABLE SQL functions, and
  `organizations_identity_unique` makes *name + state + city* the identity.
- **`contacts`** — separate table, so several directors at one club never become
  conflicting assignments. Phone is stored as raw text with normalisation
  *alongside* it (`phone_raw`, `phone_digits`, `phone_e164`, `phone_valid`).
- **`organization_assignments`** — history, not a column.
  `organization_assignments_one_current` is a partial unique index on
  `(organization_id) WHERE unassigned_at IS NULL`: **this** is what makes two
  concurrent assignments impossible.
- **`suppressions`** — do-not-contact / bounce / invalid, scoped to an
  organization or a contact and a channel. Applies across assignees and
  survives re-imports.
- **`import_batches`**, **`import_rows`**, **`import_source_keys`** — the import
  ledger. `idempotency_key` makes a retried confirmation a no-op;
  `import_source_keys` makes re-uploading the same file create nothing.

### Outreach — `0003_outreach.sql`

- **`metric_policies`** — versioned counting rules per cohort.
- **`weekly_targets`** — cohort defaults (`user_id IS NULL`) and per-intern
  overrides, as two partial unique indexes.
- **`weekly_target_snapshots`** — effective targets frozen once a week has
  elapsed, so editing a default cannot rewrite history.
- **`linkedin_prospects`** — `profile_key` (lowercased canonical URL) is unique
  workspace-wide.
- **`activity_events`** — the single source of truth for outreach volume.
  Append-only apart from an audited void. Two partial unique indexes matter:
  `activity_events_client_request_unique` (retry/double-submit idempotency) and
  `activity_events_one_connection_request_per_prospect` (a LinkedIn request
  counts once, ever).
- **`prospect_events`**, **`follow_ups`**, **`organization_status_events`**.

### Meetings and money — `0004_meetings_comp.sql`

- **`meetings`** — `credited_user_id` is deliberately independent of the club's
  current assignment, so reassignment never moves earnings. CHECK constraints
  keep verification metadata consistent.
- **`meeting_events`** — full state history with actor and reason.
- **`payout_ledger`** — integer cents, USD. `payout_ledger_milestone_unique`
  makes a milestone payable at most once.
- **`payout_adjustments`** — reconciliation entries when a reversal leaves an
  intern overpaid.

### Program content — `0005`, audit — `0006`

`resources`, `training_topics`, `training_completions`, `intern_provisioning`,
`projects`, `project_assignments`, `project_submissions`, `reflections`, and an
append-only `audit_events` table whose UPDATE and DELETE are rejected by a
trigger for **every** role, including owners.

---

## Enforcement that does not depend on application code

`0007_rls.sql` and `0008_policies.sql` install:

**Helper functions** (SECURITY DEFINER, so they can read `users` without
recursing through its own policies): `app.current_user_id()`,
`app.current_user_role()`, `app.is_active()`, `app.is_admin()`,
`app.is_owner()`, `app.owns_org()`, `app.has_org_history()`.

**Triggers:**

| Trigger | Guarantees |
| --- | --- |
| `users_protect_last_owner` | The workspace always keeps one active owner. |
| `users_guard_privileges` | Only an owner changes roles, and never their own; only an admin changes status or the outreach address. |
| `activity_events_guard` | Logged activity is immutable apart from voiding; a void cannot be undone. |
| `meetings_guard_*` | Only an admin/owner can verify; a held time is never in the future; attribution changes are admin-only. |
| `activity_events_suppression` | A suppressed contact/channel rejects new outreach at the database level. |
| `audit_events_immutable` | The audit log is append-only for everyone. |

**Policies** restrict every table. The two subtle ones:

- `organizations_read` allows an intern to see a club they currently own, one
  they have history on, or one they created. `contacts_read` allows **only**
  current ownership — so a former owner keeps their own history but loses the
  club's live contact data.
- `audit_events` has a SELECT policy for admins only, and an INSERT policy that
  forces `actor_user_id` to match the current actor.

### A trap worth knowing about

Because RLS hides other users' `users` rows from an intern, an **inner join** on
`users` silently drops rows. That emptied the intern's payout ledger (the
recorder is an admin) and hid a previous owner's work from a club's timeline.
Every such join is now a `LEFT JOIN` with a neutral fallback name
(`'Another team member'`, `'A Waresport admin'`) — the actor stays attributed,
only the display name is withheld. Regression tests:
`tests/integration/compensation.test.ts` and
`tests/integration/assignment-outreach.test.ts`.

---

## Where the calculations live

Every number on every screen and in every export comes from one of these:

| Concern | Module |
| --- | --- |
| Week boundaries, DST, timezone conversion | `src/lib/domain/time.ts` |
| Program weeks, targets, pace, rates | `src/lib/domain/program.ts` |
| $100 milestones, balance, overpayment | `src/lib/domain/compensation.ts` |
| What counts as an email / a request | `src/lib/domain/metrics.ts` |
| CSV parsing, matching, duplicate rules | `src/lib/domain/csv-import.ts` |
| Phone, URL, LinkedIn, CSV-export safety | `src/lib/domain/{phone,url,linkedin,csv-export}.ts` |
| SQL aggregation using those definitions | `src/lib/queries/metrics.ts`, `admin-dashboard.ts` |

The domain modules are pure and have no database dependency, which is why the
compensation examples and DST cases can be unit-tested directly. The SQL
aggregations mirror them, and the integration tests assert both produce the same
answer.

---

## Request flow

```
Browser
  └─ Server Component (page.tsx)
       ├─ requireIntern() / requireAdmin()      ← session + role
       └─ asUser(user.id, tx => query(tx))      ← RLS-enforced read
  └─ Server Action ('use server')
       ├─ assertAdmin()                          ← throws AuthorizationError
       ├─ parseForm(zodSchema, formData)         ← server-side validation
       ├─ asUser(user.id, tx => service(tx))     ← transaction + RLS
       ├─ recordAudit(tx, ...)                   ← for sensitive changes
       └─ revalidatePath(...)  → FormState
```

The actor is always read from the session, never from the form. A forged
`actorUserId` field is impossible by construction, and RLS rejects it a second
time — see the "actor spoofing" cases in the authorization tests.

---

## Notable UI decisions

- **Sign-out is POST-only.** A GET sign-out is fired by Next.js link
  prefetching, speculative navigation, or a cross-site `<img src>`, which logs
  people out at random. This was found by an acceptance test; `/sign-out` now
  returns 405 for GET and the UI uses a server action.
- **Cookie `secure` follows the URL scheme, not `NODE_ENV`.** A Secure cookie
  set over plain HTTP is stored by Chrome but not returned on same-site POSTs,
  which silently breaks every server action in a non-HTTPS production-mode
  deployment.
- **Rejected submissions keep their input.** React resets an uncontrolled form
  once its action settles, so failed validation would otherwise wipe everything
  typed. Actions echo the submitted values back in `FormState.values`.
- **Cards and table wrappers carry `min-w-0` / `max-w-full`.** A grid item
  defaults to `min-width: auto`, so a wide table stretches its parent and pushes
  the page sideways instead of scrolling inside its own container.
- **Confirmations are inline, not `window.confirm`.** A browser modal blocks the
  page, cannot be styled, and is awkward for assistive technology.
