-- ============================================================================
-- 0006_audit: append-only audit trail
-- ============================================================================

CREATE TABLE audit_events (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role    app_role,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  before_data   jsonb,
  after_data    jsonb,
  reason        text,
  ip_hash       bytea,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_events_actor_idx  ON audit_events (actor_user_id, created_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, created_at DESC);

-- The audit log is append-only for everyone, including owners. Attempts to
-- rewrite history fail loudly at the database level.
CREATE OR REPLACE FUNCTION app.audit_events_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_immutable();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_immutable();
