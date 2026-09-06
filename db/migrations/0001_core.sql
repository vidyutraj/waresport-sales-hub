-- ============================================================================
-- 0001_core: extensions, helper schema, enums, authentication, program setup
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Normalization helpers. These are IMMUTABLE so they can back generated
-- columns and unique indexes. They are deliberately conservative: they fold
-- case/whitespace/punctuation but never strip meaningful words, because
-- organization de-duplication must not merge distinct clubs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.normalize_text(v text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(lower(btrim(coalesce(v, ''))), '\s+', ' ', 'g'), '');
$$;

CREATE OR REPLACE FUNCTION app.normalize_name(v text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    btrim(regexp_replace(
      regexp_replace(lower(btrim(coalesce(v, ''))), '[^a-z0-9 ]+', ' ', 'g'),
      '\s+', ' ', 'g')),
    '');
$$;

CREATE OR REPLACE FUNCTION app.normalize_email(v text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(lower(btrim(coalesce(v, ''))), '');
$$;

CREATE OR REPLACE FUNCTION app.phone_digits(v text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(coalesce(v, ''), '\D', '', 'g'), '');
$$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE app_role         AS ENUM ('owner', 'admin', 'intern');
CREATE TYPE user_status      AS ENUM ('invited', 'active', 'deactivated');
CREATE TYPE auth_code_purpose AS ENUM ('sign_in', 'invite_claim');

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                     citext NOT NULL,
  role                      app_role NOT NULL DEFAULT 'intern',
  status                    user_status NOT NULL DEFAULT 'invited',
  full_name                 text,
  preferred_name            text,
  timezone                  text NOT NULL DEFAULT 'America/New_York',
  bio                       text,
  personal_linkedin_url     text,
  contact_phone             text,
  waresport_outreach_email  citext,
  email_verified_at         timestamptz,
  onboarding_completed_at   timestamptz,
  program_acknowledged_at   timestamptz,
  deactivated_at            timestamptz,
  last_sign_in_at           timestamptz,
  row_version               integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$')
);

CREATE INDEX users_role_status_idx ON users (role, status);

-- Exactly one owner is the minimum; enforced by a trigger in 0007 that blocks
-- demoting or deactivating the last owner.

-- ---------------------------------------------------------------------------
-- Sessions: opaque tokens, only the SHA-256 hash is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  user_agent    text,
  ip_hash       bytea
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- One-time codes for email verification / sign-in. Codes are hashed; the
-- plaintext exists only in the delivered email.
-- ---------------------------------------------------------------------------
CREATE TABLE auth_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  purpose       auth_code_purpose NOT NULL,
  code_hash     bytea NOT NULL,
  invitation_id uuid,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ip_hash       bytea
);
CREATE INDEX auth_codes_email_idx ON auth_codes (email, created_at DESC);
CREATE INDEX auth_codes_live_idx ON auth_codes (email) WHERE consumed_at IS NULL;

-- Simple durable rate-limit counters keyed by (bucket, subject, window start).
CREATE TABLE rate_limits (
  bucket        text NOT NULL,
  subject       text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, subject, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Program: cohorts and territories
-- ---------------------------------------------------------------------------
CREATE TABLE cohorts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  start_date         date NOT NULL,
  weeks_count        integer NOT NULL DEFAULT 12 CHECK (weeks_count BETWEEN 1 AND 52),
  reporting_timezone text NOT NULL DEFAULT 'America/New_York',
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES users (id),
  row_version        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cohorts_name_unique UNIQUE (name)
);

CREATE TABLE territories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT territories_code_unique UNIQUE (code),
  CONSTRAINT territories_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_]{1,23}$')
);

-- Admin-configurable state -> territory map. The program PDF does not define
-- one, so it is data, not code. Unmapped states stay unassigned and flagged.
CREATE TABLE territory_states (
  state_code   text PRIMARY KEY CHECK (state_code ~ '^[A-Z]{2}$'),
  territory_id uuid NOT NULL REFERENCES territories (id) ON DELETE CASCADE,
  updated_by   uuid REFERENCES users (id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX territory_states_territory_idx ON territory_states (territory_id);

-- Cohort membership: which cohort/territory an intern belongs to, and when.
CREATE TABLE cohort_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cohort_id    uuid NOT NULL REFERENCES cohorts (id) ON DELETE CASCADE,
  territory_id uuid REFERENCES territories (id),
  joined_on    date NOT NULL,
  left_on      date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cohort_memberships_unique UNIQUE (user_id, cohort_id),
  CONSTRAINT cohort_memberships_dates CHECK (left_on IS NULL OR left_on >= joined_on)
);
CREATE INDEX cohort_memberships_cohort_idx ON cohort_memberships (cohort_id);
CREATE INDEX cohort_memberships_territory_idx ON cohort_memberships (territory_id);

-- An intern may only sit in one *active* cohort at a time.
CREATE UNIQUE INDEX cohort_memberships_one_active
  ON cohort_memberships (user_id) WHERE left_on IS NULL;

-- ---------------------------------------------------------------------------
-- Invitations: email-bound, expiring, single-use.
-- ---------------------------------------------------------------------------
CREATE TABLE invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  role          app_role NOT NULL DEFAULT 'intern',
  cohort_id     uuid REFERENCES cohorts (id) ON DELETE SET NULL,
  territory_id  uuid REFERENCES territories (id) ON DELETE SET NULL,
  created_by    uuid NOT NULL REFERENCES users (id),
  expires_at    timestamptz NOT NULL,
  claimed_at    timestamptz,
  claimed_by    uuid REFERENCES users (id),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users (id),
  send_count    integer NOT NULL DEFAULT 0,
  last_sent_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_email_shape
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'),
  -- Invites never grant ownership; owners are bootstrapped server-side only.
  CONSTRAINT invitations_role_not_owner CHECK (role <> 'owner')
);

-- At most one live (unclaimed, unrevoked) invitation per email address. This is
-- the database-level guarantee behind atomic, single-use invite claiming.
CREATE UNIQUE INDEX invitations_one_live_per_email
  ON invitations (email) WHERE claimed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_cohort_idx ON invitations (cohort_id);

ALTER TABLE auth_codes
  ADD CONSTRAINT auth_codes_invitation_fk
  FOREIGN KEY (invitation_id) REFERENCES invitations (id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- updated_at maintenance + optimistic-locking row_version bump
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF to_jsonb(NEW) ? 'row_version' AND to_jsonb(OLD) ? 'row_version'
     AND (to_jsonb(NEW) ->> 'row_version') = (to_jsonb(OLD) ->> 'row_version') THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER cohorts_touch BEFORE UPDATE ON cohorts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER cohort_memberships_touch BEFORE UPDATE ON cohort_memberships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
