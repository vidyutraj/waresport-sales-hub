# Deploying

The app is a standard Next.js server plus a PostgreSQL 17 database. It has no
other runtime dependency: no queue, no cache, no object store, no mail server.

Two supported shapes:

- **Container** (Fly.io, Render, Railway, Cloud Run, your own box) — build the
  included `Dockerfile`. It emits a standalone server, runs as an unprivileged
  user and exposes `/api/health`.
- **Vercel** — no configuration needed; point it at the repo. Bring your own
  Postgres (Neon, Supabase, RDS). Uploaded resource files need a volume, which
  Vercel does not provide — see *Storage* below. Vercel specifics are in
  *Serverless and pooled connections* and *Migrations without a release hook*
  below.

---

## 1. Provision the database

Any PostgreSQL 17 will do. You need **two** connection strings, and they must be
different roles:

| Variable | Role | Used by |
| --- | --- | --- |
| `DATABASE_URL` | table owner | migrations, sign-in, account creation, CLI |
| `APP_DATABASE_URL` | `waresport_app` | every business query, under RLS |

`waresport_app` is created by migration `0007_rls.sql`. It owns nothing and has
`NOBYPASSRLS`, which is what makes row level security a real boundary rather
than a decoration. **Set its password explicitly** — the migration falls back to
a well-known development password otherwise:

```bash
psql "$DATABASE_URL" -c "SET waresport.app_password = 'a-strong-password'" -f db/migrations/0007_rls.sql
# or, after migrating:
psql "$DATABASE_URL" -c "ALTER ROLE waresport_app WITH PASSWORD 'a-strong-password'"
```

Both URLs need `?sslmode=require` unless the database is on a private network.
The app refuses to boot otherwise.

## 2. Set the environment

```bash
NODE_ENV=production
APP_URL=https://your-host                      # must be https
AUTH_SECRET=$(openssl rand -base64 48)         # 32+ chars, never the example one
DATABASE_URL=postgres://owner:...@host/db?sslmode=require
APP_DATABASE_URL=postgres://waresport_app:...@host/db?sslmode=require
SESSION_TTL_HOURS=12
STORAGE_DIR=/data/storage                      # container volume, see below
```

`src/lib/env.ts` refuses to start a production deployment that still carries the
example secret, serves over plain HTTP, reaches a hosted database without TLS,
or points both connections at the owning role. Those failures are loud at boot
rather than silent in production.

## 3. Migrate, then release

Migrations are a **release step**, never a boot step — two instances starting at
once must not race each other through the schema:

```bash
npm run db:migrate     # idempotent; refuses to re-run an edited migration
```

Then start the server (`node server.js` in the container, or your platform's
own start command).

## 4. Create the first account

There is no self-signup, so the first owner is created from a shell with access
to `DATABASE_URL`:

```bash
npm run user:create -- --email you@yourcompany.com --name "Your Name" --role owner
```

It prints a generated password once. Admin and owner accounts cannot sign in
without one.

## 5. Check it

```bash
curl -sI https://your-host/sign-in | grep -i content-security-policy
curl -s  https://your-host/api/health          # {"status":"ok"}
```

`/api/health` reports only up/degraded — no version, no configuration.

---

## Serverless and pooled connections

On a serverless platform each warm instance holds its own connection pool, so
point both `DATABASE_URL` and `APP_DATABASE_URL` at the provider's **pooled**
endpoint (Neon's is the host containing `-pooler`). `src/lib/db.ts` detects a
pooled URL and disables prepared statements — a transaction pooler gives each
statement whichever backend is free, so a statement prepared on one connection
is missing on the next — and caps the pool size when it detects serverless.

Run DDL against the **direct** endpoint instead (the same host without
`-pooler`). Schema changes do not belong on a pooler.

## Migrations without a release hook

Fly and Render run `npm run db:migrate` as a release step. Vercel has no
equivalent, and a build is the wrong place for it: builds run on every deploy,
sometimes in parallel. Apply migrations from a workstation with access to the
database, before promoting the deployment:

```bash
DATABASE_URL="<direct endpoint>" npm run db:migrate
```

The runner is idempotent and refuses to re-run a migration whose contents
changed, so running it twice is safe and running it against an already-current
database prints "Database is up to date."

## Storage

Uploaded resource documents are written to `STORAGE_DIR`, outside the web root,
and are served only through an authorization-checked route. On a container
platform this must be a mounted volume, or files vanish on the next deploy. On
Vercel there is no writable disk: either skip resource uploads or put them
behind an object store before using that feature.

## Backups

The database is the whole system — activity, meetings and payout history are
not reconstructable. Turn on your provider's automated backups and confirm a
restore once. Nothing else in the deployment holds state worth keeping.

## Scaling

Stateless: run as many instances as you like behind a load balancer. Sessions
live in the database, not in memory. The only shared mutable resource is
PostgreSQL, and every correctness rule that matters (one current assignment per
club, single-use payout milestones, append-only activity) is enforced there by a
constraint rather than by application code, so concurrent instances are safe.
