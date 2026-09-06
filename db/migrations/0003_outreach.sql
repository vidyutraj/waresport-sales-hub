-- ============================================================================
-- 0003_outreach: activity events, follow-ups, LinkedIn prospects, targets
-- ============================================================================

CREATE TYPE activity_channel AS ENUM ('email', 'linkedin', 'phone', 'other');

CREATE TYPE activity_action AS ENUM (
  'email_initial',
  'email_followup',
  'linkedin_connection_request',
  'linkedin_message',
  'linkedin_followup',
  'phone_call',
  'research_note'
);

CREATE TYPE activity_outcome AS ENUM (
  'sent', 'no_response', 'replied', 'positive_reply', 'not_interested',
  'bounced', 'invalid_contact', 'do_not_contact', 'meeting_booked', 'logged'
);

-- ---------------------------------------------------------------------------
-- Metric policy versions. Counting rules are data, versioned so that changing
-- them prospectively cannot rewrite the meaning of historical weeks.
-- ---------------------------------------------------------------------------
CREATE TABLE metric_policies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id                   uuid NOT NULL REFERENCES cohorts (id) ON DELETE CASCADE,
  version                     integer NOT NULL,
  effective_from              timestamptz NOT NULL,
  email_counts_followups      boolean NOT NULL DEFAULT true,
  linkedin_counts_first_request_only boolean NOT NULL DEFAULT true,
  notes                       text,
  created_by                  uuid REFERENCES users (id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_policies_version_unique UNIQUE (cohort_id, version)
);
CREATE INDEX metric_policies_effective_idx ON metric_policies (cohort_id, effective_from DESC);

-- ---------------------------------------------------------------------------
-- Weekly targets. Resolution order for an (intern, week):
--   1. frozen snapshot  2. per-intern override  3. cohort default  4. PDF default
-- ---------------------------------------------------------------------------
CREATE TABLE weekly_targets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id            uuid NOT NULL REFERENCES cohorts (id) ON DELETE CASCADE,
  user_id              uuid REFERENCES users (id) ON DELETE CASCADE, -- NULL = cohort default
  week_number          integer NOT NULL CHECK (week_number BETWEEN 1 AND 52),
  email_target         integer NOT NULL CHECK (email_target >= 0),
  linkedin_target      integer NOT NULL CHECK (linkedin_target >= 0),
  email_daily_pace     integer NOT NULL DEFAULT 0 CHECK (email_daily_pace >= 0),
  linkedin_daily_pace  integer NOT NULL DEFAULT 0 CHECK (linkedin_daily_pace >= 0),
  created_by           uuid REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX weekly_targets_cohort_default_unique
  ON weekly_targets (cohort_id, week_number) WHERE user_id IS NULL;
CREATE UNIQUE INDEX weekly_targets_user_override_unique
  ON weekly_targets (cohort_id, user_id, week_number) WHERE user_id IS NOT NULL;

-- Frozen effective targets for weeks that have already elapsed.
CREATE TABLE weekly_target_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id            uuid NOT NULL REFERENCES cohorts (id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  week_number          integer NOT NULL,
  email_target         integer NOT NULL,
  linkedin_target      integer NOT NULL,
  email_daily_pace     integer NOT NULL,
  linkedin_daily_pace  integer NOT NULL,
  source               text NOT NULL CHECK (source IN ('intern_override', 'cohort_default', 'program_default')),
  snapshot_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_target_snapshots_unique UNIQUE (cohort_id, user_id, week_number)
);

CREATE TRIGGER weekly_targets_touch BEFORE UPDATE ON weekly_targets
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- LinkedIn prospects, researched independently of the imported email leads.
-- ---------------------------------------------------------------------------
CREATE TYPE prospect_status AS ENUM (
  'not_contacted', 'request_sent', 'connected', 'message_sent',
  'replied', 'interested', 'meeting_booked', 'not_interested'
);

CREATE TABLE linkedin_prospects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  created_by            uuid NOT NULL REFERENCES users (id),
  full_name             text NOT NULL CHECK (btrim(full_name) <> ''),
  title                 text,
  -- Canonicalized https://www.linkedin.com/in/<id> form; tracking params and
  -- fragments removed. The public id casing is preserved.
  profile_url           text NOT NULL,
  profile_url_raw       text NOT NULL,
  profile_key           text NOT NULL,   -- lowercased canonical form, dedupe key
  linkedin_public_id    text NOT NULL,
  territory_id          uuid REFERENCES territories (id) ON DELETE SET NULL,
  sport                 text,
  email                 citext,
  notes                 text,
  status                prospect_status NOT NULL DEFAULT 'not_contacted',
  is_archived           boolean NOT NULL DEFAULT false,
  row_version           integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- One record per real LinkedIn profile across the whole workspace.
CREATE UNIQUE INDEX linkedin_prospects_profile_unique
  ON linkedin_prospects (profile_key) WHERE is_archived = false;
CREATE INDEX linkedin_prospects_org_idx     ON linkedin_prospects (organization_id);
CREATE INDEX linkedin_prospects_creator_idx ON linkedin_prospects (created_by);

CREATE TRIGGER linkedin_prospects_touch BEFORE UPDATE ON linkedin_prospects
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Activity events. This table is the single source of truth for outreach
-- volume; organization/prospect status columns are only workflow summaries.
-- ---------------------------------------------------------------------------
CREATE TABLE activity_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  contact_id        uuid REFERENCES contacts (id) ON DELETE SET NULL,
  prospect_id       uuid REFERENCES linkedin_prospects (id) ON DELETE SET NULL,
  actor_user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cohort_id         uuid REFERENCES cohorts (id) ON DELETE SET NULL,
  channel           activity_channel NOT NULL,
  action_type       activity_action NOT NULL,
  occurred_at       timestamptz NOT NULL,
  outcome           activity_outcome NOT NULL DEFAULT 'sent',
  notes             text,
  evidence_url      text,
  follow_up_on      date,
  policy_version    integer,
  -- Idempotency for retried / double-clicked submits.
  client_request_id text,
  corrected_from_id uuid REFERENCES activity_events (id) ON DELETE SET NULL,
  voided_at         timestamptz,
  voided_by         uuid REFERENCES users (id),
  void_reason       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_channel_action_match CHECK (
    (channel = 'email'    AND action_type IN ('email_initial', 'email_followup')) OR
    (channel = 'linkedin' AND action_type IN ('linkedin_connection_request', 'linkedin_message', 'linkedin_followup')) OR
    (channel = 'phone'    AND action_type = 'phone_call') OR
    (channel = 'other'    AND action_type = 'research_note')
  ),
  CONSTRAINT activity_void_reason CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);

CREATE UNIQUE INDEX activity_events_client_request_unique
  ON activity_events (actor_user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX activity_events_actor_time_idx ON activity_events (actor_user_id, occurred_at DESC)
  WHERE voided_at IS NULL;
CREATE INDEX activity_events_org_time_idx   ON activity_events (organization_id, occurred_at DESC);
CREATE INDEX activity_events_contact_idx    ON activity_events (contact_id);
CREATE INDEX activity_events_prospect_idx   ON activity_events (prospect_id);
CREATE INDEX activity_events_metrics_idx
  ON activity_events (actor_user_id, action_type, occurred_at) WHERE voided_at IS NULL;

-- A LinkedIn *connection request* may only be counted once per prospect, ever.
CREATE UNIQUE INDEX activity_events_one_connection_request_per_prospect
  ON activity_events (prospect_id)
  WHERE action_type = 'linkedin_connection_request'
    AND prospect_id IS NOT NULL
    AND voided_at IS NULL;

-- ---------------------------------------------------------------------------
-- Prospect lifecycle events (separate from outreach volume metrics).
-- ---------------------------------------------------------------------------
CREATE TYPE prospect_event_type AS ENUM (
  'created', 'request_sent', 'connected', 'message_sent',
  'replied', 'interested', 'meeting_booked', 'not_interested', 'note'
);

CREATE TABLE prospect_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id   uuid NOT NULL REFERENCES linkedin_prospects (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  event_type    prospect_event_type NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  notes         text,
  activity_id   uuid REFERENCES activity_events (id) ON DELETE SET NULL,
  voided_at     timestamptz,
  void_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prospect_events_prospect_idx ON prospect_events (prospect_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Follow-up queue
-- ---------------------------------------------------------------------------
CREATE TYPE follow_up_status AS ENUM ('open', 'completed', 'snoozed', 'cancelled');

CREATE TABLE follow_ups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES contacts (id) ON DELETE SET NULL,
  prospect_id      uuid REFERENCES linkedin_prospects (id) ON DELETE SET NULL,
  assigned_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_from     uuid REFERENCES activity_events (id) ON DELETE SET NULL,
  due_on           date NOT NULL,
  status           follow_up_status NOT NULL DEFAULT 'open',
  snoozed_until    date,
  completed_at     timestamptz,
  completed_by     uuid REFERENCES users (id),
  notes            text,
  row_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT follow_ups_snooze CHECK (status <> 'snoozed' OR snoozed_until IS NOT NULL)
);
CREATE INDEX follow_ups_queue_idx ON follow_ups (assigned_user_id, due_on)
  WHERE status IN ('open', 'snoozed');
CREATE INDEX follow_ups_org_idx ON follow_ups (organization_id);

CREATE TRIGGER follow_ups_touch BEFORE UPDATE ON follow_ups
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Organization status change history (status is a summary, never a metric).
CREATE TABLE organization_status_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  actor_user_id   uuid NOT NULL REFERENCES users (id),
  from_status     org_status,
  to_status       org_status NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_status_events_org_idx
  ON organization_status_events (organization_id, created_at DESC);
