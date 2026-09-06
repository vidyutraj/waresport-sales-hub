-- ============================================================================
-- 0008_policies: row level security policies for every application table.
-- ============================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','cohorts','territories','territory_states','cohort_memberships','invitations',
    'organizations','contacts','organization_assignments','suppressions',
    'import_batches','import_rows','import_source_keys',
    'metric_policies','weekly_targets','weekly_target_snapshots',
    'linkedin_prospects','activity_events','prospect_events','follow_ups',
    'organization_status_events','meetings','meeting_events',
    'payout_ledger','payout_adjustments',
    'resources','training_topics','training_completions','intern_provisioning',
    'projects','project_assignments','project_submissions','reflections','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE POLICY users_select_self  ON users FOR SELECT USING (id = app.current_user_id());
CREATE POLICY users_select_admin ON users FOR SELECT USING (app.is_admin());
CREATE POLICY users_update_self  ON users FOR UPDATE
  USING (id = app.current_user_id() AND app.is_active())
  WITH CHECK (id = app.current_user_id());
CREATE POLICY users_update_admin ON users FOR UPDATE
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- ---------------------------------------------------------------------------
-- Program configuration: readable by every active member, writable by admins.
-- ---------------------------------------------------------------------------
CREATE POLICY cohorts_read  ON cohorts FOR SELECT USING (app.is_active());
CREATE POLICY cohorts_write ON cohorts FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY cohorts_edit  ON cohorts FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY territories_read  ON territories FOR SELECT USING (app.is_active());
CREATE POLICY territories_write ON territories FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY territories_edit  ON territories FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY territory_states_read  ON territory_states FOR SELECT USING (app.is_active());
CREATE POLICY territory_states_write ON territory_states FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY territory_states_edit  ON territory_states FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY memberships_read_self  ON cohort_memberships FOR SELECT
  USING (user_id = app.current_user_id() AND app.is_active());
CREATE POLICY memberships_read_admin ON cohort_memberships FOR SELECT USING (app.is_admin());
CREATE POLICY memberships_write      ON cohort_memberships FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY memberships_edit       ON cohort_memberships FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

-- Invitations are an administrative object; claiming happens on the system
-- connection before any session exists.
CREATE POLICY invitations_admin ON invitations FOR SELECT USING (app.is_admin());
CREATE POLICY invitations_create ON invitations FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY invitations_edit ON invitations FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

-- ---------------------------------------------------------------------------
-- Leads. Interns never see the unassigned pool.
-- ---------------------------------------------------------------------------
CREATE POLICY organizations_read ON organizations FOR SELECT
  USING (app.is_admin() OR app.owns_org(id) OR app.has_org_history(id));
CREATE POLICY organizations_insert ON organizations FOR INSERT
  WITH CHECK (app.is_admin() OR (app.is_intern() AND created_by = app.current_user_id()));
CREATE POLICY organizations_update ON organizations FOR UPDATE
  USING (app.is_admin() OR app.owns_org(id))
  WITH CHECK (app.is_admin() OR app.owns_org(id));

-- Contacts follow *current* ownership only: past contributors keep their own
-- history but lose access to the club's live contact data.
CREATE POLICY contacts_read ON contacts FOR SELECT
  USING (app.is_admin() OR app.owns_org(organization_id));
CREATE POLICY contacts_insert ON contacts FOR INSERT
  WITH CHECK (app.is_admin() OR app.owns_org(organization_id));
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (app.is_admin() OR app.owns_org(organization_id))
  WITH CHECK (app.is_admin() OR app.owns_org(organization_id));

CREATE POLICY assignments_read ON organization_assignments FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND intern_user_id = app.current_user_id()));
-- An intern may only claim an organization they themselves researched; the
-- partial unique index makes a concurrent double-claim impossible.
CREATE POLICY assignments_insert ON organization_assignments FOR INSERT
  WITH CHECK (
    app.is_admin()
    OR (app.is_intern()
        AND intern_user_id = app.current_user_id()
        AND assigned_by = app.current_user_id()
        AND EXISTS (SELECT 1 FROM organizations o
                    WHERE o.id = organization_id AND o.created_by = app.current_user_id()))
  );
CREATE POLICY assignments_update ON organization_assignments FOR UPDATE
  USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY suppressions_read ON suppressions FOR SELECT
  USING (app.is_admin() OR app.owns_org(organization_id)
         OR EXISTS (SELECT 1 FROM contacts c
                    WHERE c.id = suppressions.contact_id AND app.owns_org(c.organization_id)));
CREATE POLICY suppressions_insert ON suppressions FOR INSERT
  WITH CHECK (
    created_by = app.current_user_id() AND (
      app.is_admin()
      OR app.owns_org(organization_id)
      OR EXISTS (SELECT 1 FROM contacts c
                 WHERE c.id = suppressions.contact_id AND app.owns_org(c.organization_id))
    ));
-- Only an admin may lift a suppression.
CREATE POLICY suppressions_lift ON suppressions FOR UPDATE
  USING (app.is_admin()) WITH CHECK (app.is_admin());

-- Imports are global operations: administrators only.
CREATE POLICY import_batches_admin ON import_batches FOR SELECT USING (app.is_admin());
CREATE POLICY import_batches_ins   ON import_batches FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY import_batches_upd   ON import_batches FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());
CREATE POLICY import_rows_admin    ON import_rows FOR SELECT USING (app.is_admin());
CREATE POLICY import_rows_ins      ON import_rows FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY import_rows_upd      ON import_rows FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());
CREATE POLICY import_keys_admin    ON import_source_keys FOR SELECT USING (app.is_admin());
CREATE POLICY import_keys_ins      ON import_source_keys FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY import_keys_upd      ON import_source_keys FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

-- ---------------------------------------------------------------------------
-- Targets and metric policy
-- ---------------------------------------------------------------------------
CREATE POLICY metric_policies_read ON metric_policies FOR SELECT USING (app.is_active());
CREATE POLICY metric_policies_ins  ON metric_policies FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY metric_policies_upd  ON metric_policies FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY weekly_targets_read ON weekly_targets FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND (user_id IS NULL OR user_id = app.current_user_id())));
CREATE POLICY weekly_targets_ins ON weekly_targets FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY weekly_targets_upd ON weekly_targets FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY target_snapshots_read ON weekly_target_snapshots FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY target_snapshots_ins ON weekly_target_snapshots FOR INSERT
  WITH CHECK (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));

-- ---------------------------------------------------------------------------
-- LinkedIn prospects and outreach activity
-- ---------------------------------------------------------------------------
CREATE POLICY prospects_read ON linkedin_prospects FOR SELECT
  USING (app.is_admin() OR created_by = app.current_user_id() OR app.owns_org(organization_id));
CREATE POLICY prospects_ins ON linkedin_prospects FOR INSERT
  WITH CHECK (app.is_active() AND created_by = app.current_user_id());
CREATE POLICY prospects_upd ON linkedin_prospects FOR UPDATE
  USING (app.is_admin() OR created_by = app.current_user_id())
  WITH CHECK (app.is_admin() OR created_by = app.current_user_id());

-- The current owner of a club can read its outreach history (to avoid
-- duplicate contact) but the actor column is immutable, so contributions
-- always stay attributed to whoever performed them.
CREATE POLICY activity_read ON activity_events FOR SELECT
  USING (app.is_admin()
         OR actor_user_id = app.current_user_id()
         OR app.owns_org(organization_id));
CREATE POLICY activity_ins ON activity_events FOR INSERT
  WITH CHECK (app.is_active()
              AND actor_user_id = app.current_user_id()
              AND (app.is_admin() OR app.owns_org(organization_id)));
-- Update is limited to voiding, and only your own records (or an admin's).
CREATE POLICY activity_void ON activity_events FOR UPDATE
  USING (app.is_admin() OR actor_user_id = app.current_user_id())
  WITH CHECK (app.is_admin() OR actor_user_id = app.current_user_id());

CREATE POLICY prospect_events_read ON prospect_events FOR SELECT
  USING (app.is_admin() OR actor_user_id = app.current_user_id()
         OR EXISTS (SELECT 1 FROM linkedin_prospects p
                    WHERE p.id = prospect_events.prospect_id
                      AND p.created_by = app.current_user_id()));
CREATE POLICY prospect_events_ins ON prospect_events FOR INSERT
  WITH CHECK (app.is_active() AND actor_user_id = app.current_user_id());
CREATE POLICY prospect_events_upd ON prospect_events FOR UPDATE
  USING (app.is_admin() OR actor_user_id = app.current_user_id())
  WITH CHECK (app.is_admin() OR actor_user_id = app.current_user_id());

CREATE POLICY follow_ups_read ON follow_ups FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND assigned_user_id = app.current_user_id()));
CREATE POLICY follow_ups_ins ON follow_ups FOR INSERT
  WITH CHECK (app.is_admin() OR (app.is_active() AND assigned_user_id = app.current_user_id()));
CREATE POLICY follow_ups_upd ON follow_ups FOR UPDATE
  USING (app.is_admin() OR (app.is_active() AND assigned_user_id = app.current_user_id()))
  WITH CHECK (app.is_admin() OR (app.is_active() AND assigned_user_id = app.current_user_id()));

CREATE POLICY org_status_read ON organization_status_events FOR SELECT
  USING (app.can_see_org(organization_id));
CREATE POLICY org_status_ins ON organization_status_events FOR INSERT
  WITH CHECK (actor_user_id = app.current_user_id()
              AND (app.is_admin() OR app.owns_org(organization_id)));

-- ---------------------------------------------------------------------------
-- Meetings, verification, payouts
-- ---------------------------------------------------------------------------
CREATE POLICY meetings_read ON meetings FOR SELECT
  USING (app.is_admin()
         OR credited_user_id = app.current_user_id()
         OR booked_by_user_id = app.current_user_id()
         OR app.owns_org(organization_id));
CREATE POLICY meetings_ins ON meetings FOR INSERT
  WITH CHECK (app.is_admin()
              OR (app.is_intern()
                  AND booked_by_user_id = app.current_user_id()
                  AND credited_user_id = app.current_user_id()
                  AND app.owns_org(organization_id)));
CREATE POLICY meetings_upd ON meetings FOR UPDATE
  USING (app.is_admin() OR credited_user_id = app.current_user_id())
  WITH CHECK (app.is_admin() OR credited_user_id = app.current_user_id());

CREATE POLICY meeting_events_read ON meeting_events FOR SELECT
  USING (app.is_admin() OR EXISTS (
    SELECT 1 FROM meetings m WHERE m.id = meeting_events.meeting_id
      AND (m.credited_user_id = app.current_user_id() OR m.booked_by_user_id = app.current_user_id())));
CREATE POLICY meeting_events_ins ON meeting_events FOR INSERT
  WITH CHECK (app.is_active() AND actor_user_id = app.current_user_id());

CREATE POLICY payouts_read ON payout_ledger FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY payouts_ins ON payout_ledger FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY payouts_upd ON payout_ledger FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY adjustments_read ON payout_adjustments FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY adjustments_ins ON payout_adjustments FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY adjustments_upd ON payout_adjustments FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

-- ---------------------------------------------------------------------------
-- Training, resources, projects, reflections
-- ---------------------------------------------------------------------------
CREATE POLICY resources_read ON resources FOR SELECT
  USING (app.is_active() AND is_archived = false
         AND (audience = 'all' OR (audience = 'admins' AND app.is_admin())
              OR (audience = 'interns' AND (app.is_intern() OR app.is_admin()))));
CREATE POLICY resources_ins ON resources FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY resources_upd ON resources FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY training_topics_read ON training_topics FOR SELECT USING (app.is_active());
CREATE POLICY training_topics_ins  ON training_topics FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY training_topics_upd  ON training_topics FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY training_completions_read ON training_completions FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY training_completions_ins ON training_completions FOR INSERT
  WITH CHECK (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));

CREATE POLICY provisioning_read ON intern_provisioning FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY provisioning_ins ON intern_provisioning FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY provisioning_upd ON intern_provisioning FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY projects_read ON projects FOR SELECT
  USING (app.is_admin() OR EXISTS (
    SELECT 1 FROM project_assignments pa
    WHERE pa.project_id = projects.id AND pa.user_id = app.current_user_id()));
CREATE POLICY projects_ins ON projects FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY projects_upd ON projects FOR UPDATE USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY project_assignments_read ON project_assignments FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY project_assignments_ins ON project_assignments FOR INSERT WITH CHECK (app.is_admin());
CREATE POLICY project_assignments_upd ON project_assignments FOR UPDATE
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()))
  WITH CHECK (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));

CREATE POLICY project_submissions_read ON project_submissions FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY project_submissions_ins ON project_submissions FOR INSERT
  WITH CHECK (app.is_active() AND user_id = app.current_user_id());
CREATE POLICY project_submissions_upd ON project_submissions FOR UPDATE
  USING (app.is_admin()) WITH CHECK (app.is_admin());

CREATE POLICY reflections_read ON reflections FOR SELECT
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
CREATE POLICY reflections_ins ON reflections FOR INSERT
  WITH CHECK (app.is_active() AND user_id = app.current_user_id());
CREATE POLICY reflections_upd ON reflections FOR UPDATE
  USING (app.is_active() AND user_id = app.current_user_id())
  WITH CHECK (app.is_active() AND user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- Audit trail: append-only, admin-readable. Interns cannot read or edit it.
-- ---------------------------------------------------------------------------
CREATE POLICY audit_read ON audit_events FOR SELECT USING (app.is_admin());
CREATE POLICY audit_append ON audit_events FOR INSERT
  WITH CHECK (actor_user_id IS NOT DISTINCT FROM app.current_user_id());
