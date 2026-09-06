-- ============================================================================
-- 0007_rls: application role, authorization helper functions, integrity
--           guards, and row level security policies.
--
-- The web application runs *all* business queries through the `waresport_app`
-- login role, which is neither a superuser nor a table owner, so every policy
-- below is genuinely enforced by PostgreSQL. Only a small, explicitly
-- documented "system" surface (migrations, sign-in, invite claiming, seeding)
-- connects as the table owner.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waresport_app') THEN
    EXECUTE format('CREATE ROLE waresport_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
                   coalesce(current_setting('waresport.app_password', true), 'waresport_app_dev'));
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO waresport_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO waresport_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO waresport_app;
-- No DELETE anywhere: records are archived / voided with history, never dropped.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM waresport_app;
-- Authentication material is never reachable from the request-scoped role.
REVOKE ALL ON sessions, auth_codes, rate_limits FROM waresport_app;

-- ---------------------------------------------------------------------------
-- Current-actor helpers. SECURITY DEFINER so they can read `users` without
-- recursing through that table's own policies.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.current_user_role()
RETURNS app_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT u.role FROM users u
  WHERE u.id = app.current_user_id() AND u.status = 'active';
$$;

CREATE OR REPLACE FUNCTION app.is_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u WHERE u.id = app.current_user_id() AND u.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION app.is_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() IN ('admin', 'owner');
$$;

CREATE OR REPLACE FUNCTION app.is_owner()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() = 'owner';
$$;

CREATE OR REPLACE FUNCTION app.is_intern()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app.current_user_role() = 'intern';
$$;

-- Current assignment ownership.
CREATE OR REPLACE FUNCTION app.owns_org(org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT app.is_active() AND EXISTS (
    SELECT 1 FROM organization_assignments a
    WHERE a.organization_id = org
      AND a.intern_user_id = app.current_user_id()
      AND a.unassigned_at IS NULL
  );
$$;

-- Personal historical contribution: keeps an intern's own past work readable
-- after a club is reassigned, without exposing the club's current contacts.
CREATE OR REPLACE FUNCTION app.has_org_history(org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT app.is_active() AND (
    EXISTS (SELECT 1 FROM activity_events e
            WHERE e.organization_id = org AND e.actor_user_id = app.current_user_id())
    OR EXISTS (SELECT 1 FROM meetings m
               WHERE m.organization_id = org AND m.credited_user_id = app.current_user_id())
    OR EXISTS (SELECT 1 FROM organization_assignments a
               WHERE a.organization_id = org AND a.intern_user_id = app.current_user_id())
  );
$$;

CREATE OR REPLACE FUNCTION app.can_see_org(org uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app.is_admin() OR app.owns_org(org) OR app.has_org_history(org);
$$;

-- ---------------------------------------------------------------------------
-- Integrity guards enforced in the database, independent of application code.
-- ---------------------------------------------------------------------------

-- 1. The workspace must always retain at least one active owner.
CREATE OR REPLACE FUNCTION app.protect_last_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  remaining integer;
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active'
     AND (NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    SELECT count(*) INTO remaining
      FROM users WHERE role = 'owner' AND status = 'active' AND id <> OLD.id;
    IF remaining = 0 THEN
      RAISE EXCEPTION 'cannot remove or deactivate the last active owner'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_protect_last_owner BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.protect_last_owner();

-- 2. Privilege fields can never be set by the account itself or by an intern,
--    and only an owner may mint or revoke admin/owner roles.
CREATE OR REPLACE FUNCTION app.guard_user_privilege_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := app.current_user_id();
BEGIN
  -- No actor set => system/bootstrap path (migrations, invite claim, CLI).
  IF actor IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NOT app.is_owner() THEN
      RAISE EXCEPTION 'only an owner may change roles' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.id = actor THEN
      RAISE EXCEPTION 'an owner may not change their own role' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.waresport_outreach_email IS DISTINCT FROM OLD.waresport_outreach_email)
     AND NOT app.is_admin() THEN
    RAISE EXCEPTION 'only an admin may change account status or outreach address'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER users_guard_privileges BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.guard_user_privilege_fields();

-- 3. Activity events are append-only apart from an audited void.
CREATE OR REPLACE FUNCTION app.guard_activity_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.organization_id, NEW.contact_id, NEW.prospect_id, NEW.actor_user_id,
      NEW.channel, NEW.action_type, NEW.occurred_at, NEW.outcome, NEW.notes,
      NEW.evidence_url, NEW.follow_up_on, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.contact_id, OLD.prospect_id, OLD.actor_user_id,
      OLD.channel, OLD.action_type, OLD.occurred_at, OLD.outcome, OLD.notes,
      OLD.evidence_url, OLD.follow_up_on, OLD.created_at) THEN
    RAISE EXCEPTION 'logged activity is immutable; void it and log a correction instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'a voided activity cannot be un-voided'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER activity_events_guard BEFORE UPDATE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_activity_update();

-- 4. Only an admin or owner may move a meeting into `verified_held`, and a
--    held meeting can never be recorded in the future.
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
  IF TG_OP = 'UPDATE' AND NEW.credited_user_id IS DISTINCT FROM OLD.credited_user_id THEN
    IF NOT app.is_admin() THEN
      RAISE EXCEPTION 'only an admin or owner may change meeting attribution'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meetings_guard_insert BEFORE INSERT ON meetings
  FOR EACH ROW EXECUTE FUNCTION app.guard_meeting_transition();
CREATE TRIGGER meetings_guard_update BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION app.guard_meeting_transition();

-- 5. Suppressed contacts/organizations reject new outreach logging outright.
CREATE OR REPLACE FUNCTION app.guard_suppressed_outreach()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  blocked text;
BEGIN
  IF NEW.action_type = 'research_note' THEN
    RETURN NEW;   -- research is never outreach
  END IF;
  SELECT s.reason INTO blocked
  FROM suppressions s
  WHERE s.lifted_at IS NULL
    AND s.channel IN (NEW.channel::text::suppression_channel, 'all')
    AND (
      (s.scope = 'organization' AND s.organization_id = NEW.organization_id)
      OR (s.scope = 'contact' AND NEW.contact_id IS NOT NULL AND s.contact_id = NEW.contact_id)
    )
  LIMIT 1;
  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION 'outreach is suppressed for this contact/channel: %', blocked
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER activity_events_suppression BEFORE INSERT ON activity_events
  FOR EACH ROW EXECUTE FUNCTION app.guard_suppressed_outreach();
