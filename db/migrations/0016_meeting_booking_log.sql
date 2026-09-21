-- Interns log a booked meeting from the Meetings tab: who it is with, the
-- Google Meet link, how they reached them and what they know so far. It goes
-- to an admin for approval before it counts as scheduled.
--
-- Pay is unchanged: a meeting is still worth nothing until it has been held
-- and an admin has verified it. Approval is an extra gate in front of that.

-- The meeting may come from LinkedIn or a referral, not one of the intern's
-- clubs, so the club link becomes optional. A meeting must still say who it
-- is with: a club, or a name.
ALTER TABLE meetings ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE meetings
  ADD COLUMN contact_name     text,
  ADD COLUMN meeting_link     text,
  ADD COLUMN outreach_channel text,
  ADD COLUMN background       text,
  ADD COLUMN approved_at      timestamptz,
  ADD COLUMN approved_by      uuid REFERENCES users (id);

-- Every meeting booked before this change was scheduled without an approval
-- step. Treat those as approved, so nothing already in progress moves.
UPDATE meetings SET approved_at = created_at WHERE approved_at IS NULL;

ALTER TABLE meetings
  ADD CONSTRAINT meetings_has_counterpart
    CHECK (organization_id IS NOT NULL OR contact_name IS NOT NULL),
  ADD CONSTRAINT meetings_outreach_channel
    CHECK (outreach_channel IS NULL
           OR outreach_channel IN ('email', 'linkedin', 'phone', 'referral', 'other')),
  -- Awaiting approval means not approved; anything on the way to being paid
  -- must have been approved.
  ADD CONSTRAINT meetings_approval_shape CHECK (
    (status = 'pending_approval' AND approved_at IS NULL)
    OR (status IN ('scheduled', 'pending_verification', 'verified_held') AND approved_at IS NOT NULL)
    OR status IN ('cancelled', 'no_show')
  );

CREATE INDEX meetings_approval_queue_idx ON meetings (created_at)
  WHERE status = 'pending_approval';

-- Interns may book without a club; with one, it must still be theirs.
DROP POLICY meetings_ins ON meetings;
CREATE POLICY meetings_ins ON meetings FOR INSERT
  WITH CHECK (app.is_admin()
              OR (app.is_intern()
                  AND booked_by_user_id = app.current_user_id()
                  AND credited_user_id = app.current_user_id()
                  AND (organization_id IS NULL OR app.owns_org(organization_id))));

-- The guard from 0007, plus: only an admin or owner may approve a booking. An
-- intern's booking always starts out awaiting approval, and an intern can
-- never set or clear the approval themselves.
CREATE OR REPLACE FUNCTION app.guard_meeting_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.held_at IS NOT NULL AND NEW.held_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'a meeting cannot be recorded as held in the future'
      USING ERRCODE = 'check_violation';
  END IF;
  IF app.current_user_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'verified_held'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'verified_held')
     AND NOT app.is_admin() THEN
    RAISE EXCEPTION 'only an admin or owner may verify a held meeting'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT app.is_admin() THEN
    IF TG_OP = 'INSERT' AND (NEW.status <> 'pending_approval' OR NEW.approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a booked meeting must be approved by an admin or owner'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at
                             OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
      RAISE EXCEPTION 'only an admin or owner may approve a booked meeting'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.credited_user_id IS DISTINCT FROM OLD.credited_user_id THEN
    IF NOT app.is_admin() THEN
      RAISE EXCEPTION 'only an admin or owner may change meeting attribution'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
