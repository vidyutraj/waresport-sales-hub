-- ============================================================================
-- 0009_training_toggle: allow an intern to un-tick a training item.
--
-- Training completion is self-reported and carries no historical value, so it
-- is the one table where a hard delete is the right model. Every other table
-- stays insert/update-only for the application role.
-- ============================================================================

GRANT DELETE ON training_completions TO waresport_app;

CREATE POLICY training_completions_delete ON training_completions FOR DELETE
  USING (app.is_admin() OR (app.is_active() AND user_id = app.current_user_id()));
