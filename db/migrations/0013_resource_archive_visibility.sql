-- Archiving a resource was impossible, for anyone.
--
-- `resources_read` (0008) is the only SELECT policy on the table, and it ends
-- with `is_archived = false`. PostgreSQL checks the *new* row of an UPDATE
-- against the actor's policies, so setting `is_archived = true` produced a row
-- the actor could no longer see and the update was rejected:
--
--   ERROR: new row violates row-level security policy for table "resources"
--
-- The Archive button in the admin UI therefore never worked. An update that
-- left the flag alone succeeded, which is why nothing else showed the problem.
--
-- Admins get their own read policy. Permissive policies are OR'ed, so interns
-- are unaffected: they still see only unarchived resources for their audience.
-- Admin screens filter `is_archived` explicitly in their own queries, so what
-- is listed does not change either — but an admin can now archive a resource,
-- see it afterwards, and restore it.

CREATE POLICY resources_read_admin ON resources FOR SELECT USING (app.is_admin());
