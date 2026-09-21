-- A booked meeting now waits for an admin to approve it before it is scheduled.
--
-- Kept in its own migration: a new enum value cannot be used in the same
-- transaction that adds it, and every migration runs as one transaction.

ALTER TYPE meeting_status ADD VALUE IF NOT EXISTS 'pending_approval' BEFORE 'scheduled';
ALTER TYPE meeting_event_type ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE meeting_event_type ADD VALUE IF NOT EXISTS 'declined';
