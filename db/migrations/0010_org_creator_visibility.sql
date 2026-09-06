-- ============================================================================
-- 0010_org_creator_visibility
--
-- An intern who researches and creates an organization must be able to read it
-- back — both because it is their own work and because PostgreSQL evaluates the
-- SELECT policy for an INSERT ... RETURNING. Without this, creating a
-- researched club failed with "new row violates row-level security policy" the
-- moment the statement asked for the new id.
--
-- This does not open the lead pool: it grants visibility only of rows where
-- `created_by` is the current user.
-- ============================================================================

DROP POLICY organizations_read ON organizations;

CREATE POLICY organizations_read ON organizations FOR SELECT
  USING (
    app.is_admin()
    OR app.owns_org(id)
    OR app.has_org_history(id)
    OR (app.is_active() AND created_by = app.current_user_id())
  );

-- `app.can_see_org` is used by the status-history policy; keep it aligned.
CREATE OR REPLACE FUNCTION app.can_see_org(org uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app.is_admin()
      OR app.owns_org(org)
      OR app.has_org_history(org)
      OR EXISTS (SELECT 1 FROM organizations o
                 WHERE o.id = org AND o.created_by = app.current_user_id());
$$;
