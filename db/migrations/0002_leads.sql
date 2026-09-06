-- ============================================================================
-- 0002_leads: organizations, contacts, assignment/ownership, suppression,
--             and the CSV import ledger.
-- ============================================================================

CREATE TYPE org_status AS ENUM (
  'new', 'contacted', 'replied', 'interested',
  'meeting_booked', 'meeting_held', 'not_interested',
  'unreachable', 'do_not_contact'
);

CREATE TYPE import_status  AS ENUM ('draft', 'confirmed', 'failed');
CREATE TYPE import_outcome AS ENUM (
  'organization_created',   -- new club + (maybe) new contact
  'contact_added',          -- club already existed, contact was new
  'updated',                -- explicit update of an existing record
  'skipped_duplicate',      -- exact match already present
  'needs_review',           -- uncertain organization match, held for an admin
  'invalid'                 -- unusable row (e.g. missing club name)
);

-- ---------------------------------------------------------------------------
-- Organizations (clubs). Contacts live in their own table so that several
-- directors at one club never become conflicting assignments.
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (btrim(name) <> ''),
  name_normalized text GENERATED ALWAYS AS (app.normalize_name(name)) STORED,
  city            text,
  city_normalized text GENERATED ALWAYS AS (coalesce(app.normalize_name(city), '')) STORED,
  state           text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  country         text NOT NULL DEFAULT 'US',
  sport           text,
  source          text,
  source_url      text,
  website_domain  text,
  notes           text,
  status          org_status NOT NULL DEFAULT 'new',
  territory_id    uuid REFERENCES territories (id) ON DELETE SET NULL,
  territory_source text NOT NULL DEFAULT 'unassigned'
    CHECK (territory_source IN ('unassigned', 'state_map', 'manual')),
  created_by      uuid REFERENCES users (id),
  is_archived     boolean NOT NULL DEFAULT false,
  archived_at     timestamptz,
  archived_by     uuid REFERENCES users (id),
  row_version     integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Conservative identity: same normalized name AND same state AND same city.
-- "Diamond Youth Softball" in 44 different states stays 44 distinct records.
CREATE UNIQUE INDEX organizations_identity_unique
  ON organizations (name_normalized, coalesce(state, ''), city_normalized)
  WHERE is_archived = false;

CREATE INDEX organizations_state_idx      ON organizations (state);
CREATE INDEX organizations_territory_idx  ON organizations (territory_id);
CREATE INDEX organizations_status_idx     ON organizations (status);
CREATE INDEX organizations_sport_idx      ON organizations (sport);
CREATE INDEX organizations_source_idx     ON organizations (source);
CREATE INDEX organizations_name_trgm_idx  ON organizations (name_normalized text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Contacts
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  full_name        text,
  role_title       text,
  email            citext,
  email_normalized text GENERATED ALWAYS AS (app.normalize_email(email::text)) STORED,
  email_valid      boolean NOT NULL DEFAULT false,
  -- Phone is preserved exactly as supplied (extensions, leading zeros, text).
  phone_raw        text,
  phone_digits     text GENERATED ALWAYS AS (app.phone_digits(phone_raw)) STORED,
  phone_e164       text,
  phone_valid      boolean NOT NULL DEFAULT false,
  phone_extension  text,
  linkedin_url     text,
  source_url       text,
  notes            text,
  is_primary       boolean NOT NULL DEFAULT false,
  is_archived      boolean NOT NULL DEFAULT false,
  archived_at      timestamptz,
  created_by       uuid REFERENCES users (id),
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contacts_org_email_unique
  ON contacts (organization_id, email_normalized)
  WHERE email_normalized IS NOT NULL AND is_archived = false;

CREATE INDEX contacts_org_idx    ON contacts (organization_id);
CREATE INDEX contacts_email_idx  ON contacts (email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX contacts_phone_idx  ON contacts (phone_digits) WHERE phone_digits IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Assignment: one *current* intern owner per organization, enforced in the DB.
-- History is retained; unassignment closes a row rather than deleting it.
-- ---------------------------------------------------------------------------
CREATE TABLE organization_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  intern_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  assigned_by       uuid NOT NULL REFERENCES users (id),
  assigned_at       timestamptz NOT NULL DEFAULT now(),
  unassigned_at     timestamptz,
  unassigned_by     uuid REFERENCES users (id),
  reason            text,
  territory_override_reason text,
  CONSTRAINT assignment_window CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);

-- The concurrency guard: two simultaneous assign/claim transactions cannot both
-- succeed. The loser gets a unique-violation and is reported as a collision.
CREATE UNIQUE INDEX organization_assignments_one_current
  ON organization_assignments (organization_id) WHERE unassigned_at IS NULL;

CREATE INDEX organization_assignments_intern_idx
  ON organization_assignments (intern_user_id) WHERE unassigned_at IS NULL;
CREATE INDEX organization_assignments_history_idx
  ON organization_assignments (intern_user_id, assigned_at DESC);

-- ---------------------------------------------------------------------------
-- Suppression (do-not-contact / bounced / invalid), applied across assignees
-- and re-imports. Blocks new outreach logging until an admin lifts it.
-- ---------------------------------------------------------------------------
CREATE TYPE suppression_scope   AS ENUM ('organization', 'contact');
CREATE TYPE suppression_channel AS ENUM ('email', 'linkedin', 'phone', 'all');

CREATE TABLE suppressions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           suppression_scope NOT NULL,
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts (id) ON DELETE CASCADE,
  channel         suppression_channel NOT NULL,
  reason          text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  lifted_at       timestamptz,
  lifted_by       uuid REFERENCES users (id),
  lift_reason     text,
  CONSTRAINT suppressions_target CHECK (
    (scope = 'organization' AND organization_id IS NOT NULL AND contact_id IS NULL) OR
    (scope = 'contact' AND contact_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX suppressions_active_org
  ON suppressions (organization_id, channel)
  WHERE scope = 'organization' AND lifted_at IS NULL;
CREATE UNIQUE INDEX suppressions_active_contact
  ON suppressions (contact_id, channel)
  WHERE scope = 'contact' AND lifted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Import ledger
-- ---------------------------------------------------------------------------
CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename          text NOT NULL,
  file_hash         text NOT NULL,
  file_bytes        integer NOT NULL,
  uploaded_by       uuid NOT NULL REFERENCES users (id),
  status            import_status NOT NULL DEFAULT 'draft',
  idempotency_key   text NOT NULL,
  options           jsonb NOT NULL DEFAULT '{}'::jsonb,
  column_mapping    jsonb NOT NULL DEFAULT '{}'::jsonb,
  parsed_row_count  integer NOT NULL DEFAULT 0,
  result            jsonb,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz,
  CONSTRAINT import_batches_idempotency_unique UNIQUE (idempotency_key)
);
CREATE INDEX import_batches_uploader_idx ON import_batches (uploaded_by, created_at DESC);

CREATE TABLE import_rows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  source_row_number integer NOT NULL,   -- 1-based data row, excluding the header
  raw               jsonb NOT NULL,
  outcome           import_outcome NOT NULL,
  reasons           text[] NOT NULL DEFAULT '{}',
  warnings          text[] NOT NULL DEFAULT '{}',
  organization_id   uuid REFERENCES organizations (id) ON DELETE SET NULL,
  contact_id        uuid REFERENCES contacts (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_rows_unique UNIQUE (batch_id, source_row_number)
);
CREATE INDEX import_rows_outcome_idx ON import_rows (batch_id, outcome);

-- Records which source rows produced which organizations, so re-importing the
-- same file is a no-op rather than a duplicate-creation event.
CREATE TABLE import_source_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key      text NOT NULL,
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts (id) ON DELETE CASCADE,
  first_batch_id  uuid NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_source_keys_unique UNIQUE (dedupe_key)
);

CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER contacts_touch BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
