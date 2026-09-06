-- ============================================================================
-- 0004_meetings_comp: meetings, verification history, payout ledger
-- ============================================================================

CREATE TYPE meeting_status AS ENUM (
  'scheduled', 'pending_verification', 'verified_held', 'cancelled', 'no_show'
);

CREATE TYPE meeting_event_type AS ENUM (
  'booked', 'rescheduled', 'submitted_for_verification', 'verified',
  'rejected', 'reverted', 'cancelled', 'no_show', 'attribution_changed', 'edited'
);

CREATE TABLE meetings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  contact_id          uuid REFERENCES contacts (id) ON DELETE SET NULL,
  prospect_id         uuid REFERENCES linkedin_prospects (id) ON DELETE SET NULL,
  -- The intern who gets paid for this meeting. Deliberately NOT derived from
  -- the club's current assignment: reassignment must not move earnings.
  credited_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  booked_by_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cohort_id           uuid REFERENCES cohorts (id) ON DELETE SET NULL,
  scheduled_start_at  timestamptz NOT NULL,
  scheduled_timezone  text NOT NULL DEFAULT 'America/New_York',
  status              meeting_status NOT NULL DEFAULT 'scheduled',
  held_at             timestamptz,
  verified_at         timestamptz,
  verified_by         uuid REFERENCES users (id),
  rejection_reason    text,
  eligibility_override boolean NOT NULL DEFAULT false,
  eligibility_override_reason text,
  notes               text,
  reference_url       text,
  row_version         integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Only a verified-held meeting may carry verification metadata.
  CONSTRAINT meetings_verified_shape CHECK (
    (status = 'verified_held' AND held_at IS NOT NULL AND verified_at IS NOT NULL AND verified_by IS NOT NULL)
    OR status <> 'verified_held'
  ),
  CONSTRAINT meetings_pending_shape CHECK (
    status <> 'pending_verification' OR held_at IS NOT NULL
  ),
  CONSTRAINT meetings_override_reason CHECK (
    eligibility_override = false OR eligibility_override_reason IS NOT NULL
  )
);

CREATE INDEX meetings_credited_idx ON meetings (credited_user_id, status);
CREATE INDEX meetings_org_idx      ON meetings (organization_id);
CREATE INDEX meetings_queue_idx    ON meetings (status, held_at)
  WHERE status = 'pending_verification';
-- Drives the compensation calculation.
CREATE INDEX meetings_payable_idx
  ON meetings (credited_user_id, cohort_id, held_at)
  WHERE status = 'verified_held';

CREATE TABLE meeting_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    uuid NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users (id),
  event_type    meeting_event_type NOT NULL,
  from_status   meeting_status,
  to_status     meeting_status,
  reason        text,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_events_meeting_idx ON meeting_events (meeting_id, created_at DESC);

CREATE TRIGGER meetings_touch BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Payout ledger. These are records of manual payments made outside this
-- system; nothing here moves money. Amounts are integer cents, USD.
-- ---------------------------------------------------------------------------
CREATE TABLE payout_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cohort_id       uuid NOT NULL REFERENCES cohorts (id) ON DELETE RESTRICT,
  -- 1 = the first $100 milestone (10 verified meetings), 2 = the second, ...
  milestone_index integer NOT NULL CHECK (milestone_index >= 1),
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  currency        text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  paid_on         date NOT NULL,
  reference       text,
  notes           text,
  recorded_by     uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES users (id),
  void_reason     text,
  CONSTRAINT payout_void_reason CHECK (voided_at IS NULL OR void_reason IS NOT NULL)
);

-- Idempotency + concurrency guard: a milestone can be paid at most once.
CREATE UNIQUE INDEX payout_ledger_milestone_unique
  ON payout_ledger (user_id, cohort_id, milestone_index) WHERE voided_at IS NULL;
CREATE INDEX payout_ledger_user_idx ON payout_ledger (user_id, cohort_id);

-- Reconciliation entries recorded when a verification reversal drops earned
-- dollars below what has already been paid. Payout history is never erased.
CREATE TABLE payout_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  cohort_id      uuid NOT NULL REFERENCES cohorts (id) ON DELETE RESTRICT,
  amount_cents   integer NOT NULL,
  reason         text NOT NULL,
  recorded_by    uuid NOT NULL REFERENCES users (id),
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users (id),
  resolution_note text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_adjustments_user_idx ON payout_adjustments (user_id, cohort_id);
