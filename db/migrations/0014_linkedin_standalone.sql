-- LinkedIn becomes its own track, not an extension of the assigned club list.
--
-- Interns have LinkedIn Premium and work it directly: they connect with someone
-- and message them in one motion, and the app is only there to record who. Tying
-- every prospect to one of their assigned clubs made them answer a question that
-- has no answer on that track.
--
-- The column stays, so the earlier club-linked prospects keep their link and the
-- club pages keep showing them; it simply is not required any more.

ALTER TABLE linkedin_prospects ALTER COLUMN organization_id DROP NOT NULL;

COMMENT ON COLUMN linkedin_prospects.organization_id IS
  'Optional. Null for connections logged on the standalone LinkedIn track.';
