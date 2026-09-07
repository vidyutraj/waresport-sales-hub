-- Admin and owner accounts are password-gated.
--
-- Picking a name from a list identifies you; it is not a credential. That is
-- acceptable for interns on a trusted network, but the admin portal manages
-- accounts, targets, verification and payouts, so it needs an actual secret.
-- An account with a password must present it; an admin or owner account
-- without one cannot sign in at all (see src/lib/auth/service.ts).

ALTER TABLE users
  ADD COLUMN password_hash            text,
  ADD COLUMN password_set_at          timestamptz,
  ADD COLUMN failed_password_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN password_locked_until    timestamptz;

COMMENT ON COLUMN users.password_hash IS
  'scrypt$N$r$p$salt$hash. Never the password itself; see src/lib/auth/password.ts.';

-- The request-scoped role can read and write `users` under RLS (an admin edits
-- profiles, an intern edits their own). None of those paths may touch the
-- password: it is set from the backend only, on the system connection, where
-- app.current_user_id() is null.
CREATE OR REPLACE FUNCTION app.guard_password_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.password_set_at IS DISTINCT FROM OLD.password_set_at
     OR NEW.failed_password_attempts IS DISTINCT FROM OLD.failed_password_attempts
     OR NEW.password_locked_until IS DISTINCT FROM OLD.password_locked_until THEN
    RAISE EXCEPTION 'passwords are set from the backend only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_guard_password BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.guard_password_fields();
