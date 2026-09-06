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

# 3. Start PostgreSQL 17 + Mailpit (waits until both are healthy)
npm run db:up

# 4. Create the schema and baseline data
npm run db:migrate
npm run db:seed                   # territories, training topics, starter scripts
                                  # no accounts, no leads

# 5. Create the first owner (this is the only way an owner is created)
npm run bootstrap:owner -- --email owner@waresport.local --name "Your Name"

# 6. Run
npm run dev                       # http://localhost:3000
```

Sign in at <http://localhost:3000/sign-in>. There are no passwords: a six-digit
code is emailed to you. In development that email is captured locally — open
**<http://127.0.0.1:54324>** (Mailpit) to read it. Nothing leaves the machine.

To start over: `npm run db:reset` (drops the volume, re-migrates, re-seeds).

---

## Admin quick start

1. **Sign in as the owner.** Enter your address, read the code in Mailpit, enter it.
2. **Create a cohort** — *Targets & Program*. Give it a name, a start date and a
   reporting timezone. It is seeded with the program guide's targets: 75/50 in
   week 1, then 150/100.
3. **Check the territory map** — *Settings*. The seed maps all 50 states to East
   or West; adjust it before importing so clubs land in the right territory.
   Unmapped states import as unassigned and are flagged.
4. **Invite interns** — *Interns*. Enter an address, pick the cohort and
   territory, send. They receive a one-time code. Only the owner can invite
   another admin.
5. **Import leads** — *Leads & Imports → Import CSV*. Upload, review the preview
   (nothing is written yet), then confirm. The report accounts for every parsed
   row in mutually exclusive buckets; rejected rows can be downloaded as CSV.
6. **Assign clubs** — *Leads & Imports*. Filter, select, then assign to one
   intern or distribute evenly. Bulk changes show a preview first, and a
   cross-territory assignment needs a typed reason.
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

1. Open the invitation email, click through, enter the code.
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

E2E signs in through the real one-time-code flow, reading codes back from the
local Mailpit capture server. The suite raises the auth rate limits for its own
run (a suite signs in far more often than a person does); the limiter itself is
tested at its real threshold in the integration suite.

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

Set these before deploying. Every one has a dev-only default in `.env.example`
that **must** be replaced.

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Owning connection. Migrations, sign-in, invite claim, CLI. |
| `APP_DATABASE_URL` | Request-scoped connection as `waresport_app`. Must be a role with `NOBYPASSRLS` that owns no tables — this is what makes RLS real. |
| `AUTH_SECRET` | `openssl rand -base64 48`. Rotating it invalidates all sessions and codes. |
| `APP_URL` | Must be the real `https://` origin. Session cookies are marked `Secure` when it is, and it is used in invitation links and the sign-out origin check. |
| `SMTP_*`, `MAIL_FROM` | A real provider. **This is the one external dependency that cannot be verified locally** — see below. |
| `OWNER_BOOTSTRAP_EMAILS` | Allowlist for `bootstrap:owner`. Not a password; the account still verifies by email. |
| `SESSION_TTL_HOURS`, `OTP_*`, `INVITE_TTL_HOURS` | Session and code lifetimes. |
| `AUTH_REQUEST_LIMIT_*`, `AUTH_VERIFY_LIMIT_*`, `AUTH_RATE_WINDOW_SECONDS` | Rate limits. Defaults are strict; raise only with a reason. |
| `IMPORT_MAX_FILE_BYTES`, `IMPORT_MAX_ROWS` | Import guardrails. |
| `STORAGE_DIR` | Private resource attachments. Must be writable and **must not** be web-served; files are streamed through an authorization-checked route. |

### Creating the application role

`db/migrations/0007_rls.sql` creates `waresport_app` with a development
password. For a real deployment, set a real one before migrating:

```sql
ALTER ROLE waresport_app WITH PASSWORD 'a-strong-password';
```

then put that password in `APP_DATABASE_URL`.

### Deploying

```bash
npm ci
npm run db:migrate     # against the production DATABASE_URL
npm run db:seed        # safe: no accounts, no leads, idempotent
npm run build
npm start
npm run bootstrap:owner -- --email you@waresport.com
```

Any Node host works (the app is fully dynamic — no static export). Behind a
proxy, forward `X-Forwarded-For` so per-address rate limiting sees real clients.

### Verified vs. not verified

- **Verified locally:** schema migration from empty, seeding, owner bootstrap,
  the full auth flow against real SMTP-over-Mailpit, the import of the actual
  1,231-row file, all dashboards, and every acceptance flow against a production
  build.
- **Not verified:** delivery through a real production email provider. No
  credentials were available, so `SMTP_*` against a real host (and its SPF/DKIM
  setup) is an outstanding production dependency. Everything else about the auth
  flow is exercised; only the final hop is untested.

---

## Security notes

- Two database connections. Business queries run as a non-owner role with RLS
  enforced; the privileged connection is used only where no session exists yet
  (migrations, sign-in, invite claim, CLI) and that list is enumerated in
  `docs/architecture.md`.
- Roles are never read from client input. An invite carries the role; only the
  owner can grant admin, and a database trigger enforces it.
- Sign-out is POST-only. A GET sign-out is fired by link prefetching or a
  cross-site `<img>`.
- Session tokens and one-time codes are stored only as keyed SHA-256 digests.
- Deactivating an account revokes its sessions immediately.
- The audit log is append-only for every role, including owners.
- Only `http(s)` links are ever rendered as anchors; imported `javascript:` and
  `data:` URLs are shown as inert, flagged text.
- CSV exports are protected against spreadsheet formula injection.
- Resource attachments are stored outside the web root under generated
  filenames and served through an authorization-checked route with
  `Content-Disposition: attachment`.
- Credentials, OTPs and whole contact datasets are never written to logs.

## Known limitations

- **Production email is unverified** (see above).
- The `needs_review` import bucket is reported and downloadable, but resolving a
  row in place (merge vs. create) is done by correcting the CSV and re-importing
  rather than through a dedicated in-app queue.
- Import runs in a single request. The supplied 1,231-row file takes a few
  seconds; a much larger file would want a background job.
- Charts are tables and progress bars. There is no charting library, so trends
  are read as numbers rather than plotted.
- `docs/architecture.md` records that swapping to Supabase Auth later means
  replacing `src/lib/auth/*`; the RLS policies would carry over unchanged.
- Brand colours and typography were taken from waresport.com's own stylesheet
  (`#E60027`, `#C4001F`, `#111927`, Inter). Only the wordmark is used, not the
  logo image file.
