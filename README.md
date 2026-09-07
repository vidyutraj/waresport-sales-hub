# Waresport Sales Hub

Internal workspace for the Waresport business development internship: lead
management, outreach tracking, weekly goals, meeting verification and
compensation.

This is **not** the Waresport club-management product. It is the internal tool
an administrator uses to run the internship described in
`Waresport_Internship_Program.pdf`.

- Architecture and data model → [`docs/architecture.md`](docs/architecture.md)
- Business-rule decisions and what the program guide leaves open →
  [`docs/assumptions.md`](docs/assumptions.md)

---

## What it does

**For an intern**

- See the current program week, its date range, and the East/West assignment.
- Track emails and LinkedIn requests against the weekly target, with remaining
  counts and a suggested daily pace.
- Work assigned clubs: copy contact details, send from your own Waresport
  mailbox or LinkedIn, then log what you actually sent.
- Keep a LinkedIn prospect tracker with separate counters for requests,
  acceptances and messages.
- Manage a follow-up queue (overdue, due today, upcoming, snoozed, completed).
- Book meetings, submit them as held, and watch $100 milestones accumulate.
- Complete training items, project submissions and the end-of-program reflection.

**For an admin or owner**

- Invite interns by email, assign cohort and territory, activate/deactivate.
- Import CSV lead lists with a preview, duplicate detection and a reconciled
  report; re-importing the same file creates nothing.
- Filter and allocate clubs, individually, in bulk, or evenly across interns.
- Review every intern's progress, follow-ups, meetings and compensation.
- Verify held meetings, record manual payouts, and reconcile reversals.
- Edit cohort dates, weekly targets and the metric policy.
- Manage the resource hub, projects and the state→territory map.
- Export leads, the intern roster, per-intern weekly trends and the payout
  ledger as CSV.

**What it deliberately does not do:** send outreach, scrape LinkedIn, track
opens or clicks, provision external accounts, or move money. See
[`docs/assumptions.md#10`](docs/assumptions.md).

---

## Requirements

- Node.js 20+ (developed on 20.19)
- Docker (for local PostgreSQL and mail capture)

---

## Local setup

```bash
# 1. Install
npm ci

# 2. Configure
cp .env.example .env.local        # dev-safe defaults; nothing to edit to start

# 3. Start PostgreSQL 17 (waits until it is healthy)
npm run db:up

# 4. Create the schema and baseline data
npm run db:migrate
npm run db:seed                   # territories, training topics, starter scripts
                                  # no accounts, no leads

# 5. Create the first owner (accounts are only ever created from the backend)
npm run user:create -- --email owner@waresport.local --name "Your Name" --role owner

# 6. Run
npm run dev                       # http://localhost:3000
```

Sign in at <http://localhost:3000/sign-in>. The page lists every profile and
you pick your own. Interns need nothing else: for them this is identification,
not authentication, so run the app on a trusted network. **Admin and owner
accounts also have to enter a password**, which is what stops an intern simply
picking the admin card. An admin account with no password set cannot be signed
into at all.

`user:create` prints a generated password for an admin or owner unless you pass
`--password`. To change one later (this also signs that account out
everywhere):

```bash
npm run user:set-password -- --email you@waresport.com --password "a long passphrase"
```

Add more people with the same command, or from *Interns → Add someone* once an
owner exists:

```bash
npm run user:create -- --email jordan@waresport.com --name "Jordan Lee" \
  --role intern --cohort "Spring 2026" --territory EAST
```

The rest of account management is backend-only too:

| Command | What it does |
| --- | --- |
| `npm run user:create` | Create a profile. Prints a generated password for an admin or owner. |
| `npm run user:set-password` | Set or replace a password, and sign that account out everywhere. |
| `npm run user:role -- --email <a> --role owner\|admin\|intern` | Change a role. The workspace always keeps one active owner, and an admin or owner must have a password first. |
| `npm run user:deactivate -- --email <a> [--reactivate]` | Retire an account: off the sign-in screen, signed out, history kept. Accounts are never deleted — their imports and activity stay attributed to them. |

To start over: `npm run db:reset` (drops the volume, re-migrates, re-seeds).

---

## Admin quick start

1. **Sign in as the owner.** Pick your name, then enter your password.
2. **Create a cohort** — *Targets & Program*. Give it a name, a start date and a
   reporting timezone. It is seeded with the program guide's targets: 75/50 in
   week 1, then 150/100.
3. **Check the territory map** — *Settings*. The seed maps all 50 states to East
   or West; adjust it before importing so clubs land in the right territory.
   Unmapped states import as unassigned and are flagged.
4. **Add interns** — *Interns → Add someone*. Name, address, cohort and
   territory. The profile can be signed into immediately. Only the owner can
   add another admin. `npm run user:create` does the same thing from a shell.
5. **Import leads** — *Leads & Imports → Import CSV*. Upload, review the preview
   (nothing is written yet), then confirm. The report accounts for every parsed
   row in mutually exclusive buckets; rejected rows can be downloaded as CSV.
6. **Allocate clubs** — *Leads & Imports*. Three tabs: **All clubs**,
   **Unallocated** and **Allocated**. Newly imported clubs land in Unallocated
   and stay there until you hand them out.
   - *Allocate a batch* (on the Unallocated tab) is the usual path: say how
     many and to whom, and that many go out — the rest wait for next time. It
     always takes from the top of the unallocated queue for the filters you
     have applied, and never touches a club someone already owns, so running it
     again hands out the next batch.
   - Or select rows by hand and assign them to one intern or distribute evenly.
   Bulk changes show a preview first, and a cross-territory assignment needs a
   typed reason.
7. **Set targets** — *Targets & Program*. Cohort defaults, or a per-intern
   override from that intern's page. A week that has already ended keeps the
   target it was worked under.
8. **Approve meetings** — *Meetings & Payouts*. The verification queue lists
   meetings interns have submitted as held. Only an admin or owner can verify.
9. **Record payouts** — same page. Once ten meetings are verified, record the
   $100 as paid with a date and reference. This records a payment you made
   elsewhere; it moves no money, and a milestone can only be recorded once.

---

## Intern quick start

1. Open the app and pick your name on the sign-in screen.
2. Complete onboarding: name, timezone, and tick what training you have covered.
   Territory, cohort and your Waresport outreach address are set by an admin.
3. **Overview** shows the current week, your targets and what is left.
4. **My Leads** lists the clubs assigned to you. Open one to copy the email or
   phone.
5. Send the message **from your own Waresport mailbox or LinkedIn**, then come
   back and press **Log it**. Only what you log counts — copying an address or
   drafting a message does not.
6. **LinkedIn** — add a researched prospect (research, not outreach), then
   record the request once you have actually sent it. It counts once per profile.
7. **Follow-ups** — everything you scheduled, grouped by when it is due.
8. **Meetings & Earnings** — book a meeting, mark it held once it happens, and
   an admin verifies it. Every 10 verified meetings is $100, cumulative across
   the whole internship.
9. Made a mistake? Open the club, press **Correct** on the entry and give a
   reason. The entry stays on the record but stops counting.

---

## Tests

```bash
npm run test:unit          # 104 tests — pure domain logic, no database
npm run test:integration   # 83 tests  — real PostgreSQL, real RLS
npm run test:all           # both
npm run test:e2e           # 76 Playwright tests, production build, real browser
npm run verify             # format + lint + typecheck + all tests + build
```

The database must be up for the integration and E2E suites
(`npm run db:up && npm run db:migrate`). Both truncate the workspace before
running, so they are deterministic and independent of anything left behind.

**Nothing is mocked at the authorization boundary.** Integration tests connect
as the same `waresport_app` role the application uses, which owns no tables and
has `NOBYPASSRLS`, so a policy that did not work would fail the test.

E2E signs in through the real flow: it opens `/sign-in` and clicks the profile
it wants, exactly as a person would. Nothing is stubbed.

### The supplied lead file

Two tests reconcile the real 1,231-row file. They run only when a private copy
exists at `private/baseball-club-directors-combined.csv` (`private/` is
git-ignored) and report themselves as skipped otherwise. A committed synthetic
fixture with the same headers and the same edge cases covers the flow either
way. **Real prospect data is never committed and is never uploaded anywhere.**

To load it locally:

```bash
mkdir -p private && cp /path/to/baseball-club-directors-combined.csv private/
npm run import:csv -- --file private/baseball-club-directors-combined.csv \
  --as owner@waresport.local --sport Baseball --source "Directory export"
# add --confirm to actually apply it
```

---

## Production configuration

Full instructions, including database provisioning and the release order, are in
**[DEPLOYMENT.md](DEPLOYMENT.md)**. The threat model and every hardening
decision are in **[SECURITY.md](SECURITY.md)**.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Owning connection. Migrations, sign-in, account creation, CLI. Needs `?sslmode=require` unless the host is private. |
| `APP_DATABASE_URL` | Request-scoped connection as `waresport_app`. Must be a role with `NOBYPASSRLS` that owns no tables — this is what makes RLS real. Must not equal `DATABASE_URL`. |
| `AUTH_SECRET` | `openssl rand -base64 48`. Keys the session-token digest; rotating it signs everyone out. Admin passwords are scrypt-hashed and do not depend on it. |
| `APP_URL` | The real `https://` origin. Session cookies are `Secure` and `__Host-` prefixed when it is, and it backs the sign-out origin check. |
| `SESSION_TTL_HOURS` | How long a session cookie stays valid. |
| `IMPORT_MAX_FILE_BYTES`, `IMPORT_MAX_ROWS` | Import guardrails. |
| `STORAGE_DIR` | Private resource attachments. Must be writable, must survive deploys (a volume), and **must not** be web-served; files are streamed through an authorization-checked route. |

There is no mail configuration, and no third-party service of any kind: the app
sends no email.

`src/lib/env.ts` refuses to boot a real deployment that still carries the
example secret, serves over plain HTTP, reaches a hosted database without TLS,
or runs business queries on the owning connection. Loopback is exempt so local
production builds and the acceptance suite still run.

### Release order

```bash
npm ci
npm run db:migrate     # a release step, never a boot step
npm run db:seed        # optional; territories and training topics, no accounts
npm run build && npm start
npm run user:create -- --email you@yourcompany.com --name "Your Name" --role owner
```

A `Dockerfile` is included for container platforms (standalone output,
unprivileged user, `/api/health` probe). Vercel needs no configuration, but has
no writable disk for `STORAGE_DIR`.

Behind a proxy, forward `X-Forwarded-For` so the audit trail sees real clients.

### Verified

Schema migration from empty, seeding, account creation, the real sign-in flow
including the admin password step, the import of the actual 1,231-row file, all
dashboards, and every acceptance flow against a production build with the
production security headers in place.

---

## Security notes

- Two database connections. Business queries run as a non-owner role with RLS
  enforced; the privileged connection is used only where no session exists yet
  (migrations, sign-in, account creation, CLI) and that list is enumerated in
  `docs/architecture.md`.
- Roles are never read from client input. The role comes from the stored user
  row; only the
  owner can grant admin, and a database trigger enforces it.
- Sign-out is POST-only. A GET sign-out is fired by link prefetching or a
  cross-site `<img>`.
- Session tokens are stored only as keyed SHA-256 digests, and admin passwords
  as salted scrypt hashes. Ten wrong passwords locks that account for 15
  minutes; a database trigger rejects any attempt to change a password through
  the request-scoped connection.
- Deactivating an account revokes its sessions immediately.
- The audit log is append-only for every role, including owners.
- Only `http(s)` links are ever rendered as anchors; imported `javascript:` and
  `data:` URLs are shown as inert, flagged text.
- CSV exports are protected against spreadsheet formula injection.
- Resource attachments are stored outside the web root under generated
  filenames and served through an authorization-checked route with
  `Content-Disposition: attachment`.
- Session tokens and whole contact datasets are never written to logs.

## Known limitations

- The `needs_review` import bucket is reported and downloadable, but resolving a
  row in place (merge vs. create) is done by correcting the CSV and re-importing
  rather than through a dedicated in-app queue.
- Import runs in a single request. The supplied 1,231-row file takes a few
  seconds; a much larger file would want a background job.
- Charts are tables and progress bars. There is no charting library, so trends
  are read as numbers rather than plotted.
- Interns sign in by picking their name, which identifies but does not
  authenticate them; only admin and owner accounts have passwords. Put the
  site behind a network boundary, or replace `src/lib/auth/*` with real
  authentication — the RLS policies carry over unchanged either way.
- Brand colours and typography were taken from waresport.com's own stylesheet
  (`#E60027`, `#C4001F`, `#111927`, Inter). Only the wordmark is used, not the
  logo image file.
