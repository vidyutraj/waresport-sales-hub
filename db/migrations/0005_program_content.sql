-- ============================================================================
-- 0005_program_content: resources, training, provisioning checklist,
--                       projects, and the end-of-program reflection
-- ============================================================================

CREATE TYPE resource_category AS ENUM (
  'email_script', 'linkedin_script', 'personalization',
  'training', 'program_doc', 'platform', 'other'
);
CREATE TYPE resource_audience AS ENUM ('all', 'interns', 'admins');

CREATE TABLE resources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL CHECK (btrim(title) <> ''),
  category           resource_category NOT NULL DEFAULT 'other',
  summary            text,
  body_markdown      text,
  link_url           text,
  -- Private files are stored outside the web root and streamed through an
  -- authorization-checked route; the path is never publicly addressable.
  file_path          text,
  file_name          text,
  file_mime          text,
  file_bytes         integer,
  -- True for example scripts written by this project rather than supplied by
  -- Waresport. Surfaced in the UI as "editable starter example".
  is_starter_example boolean NOT NULL DEFAULT false,
  audience           resource_audience NOT NULL DEFAULT 'all',
  sort_order         integer NOT NULL DEFAULT 100,
  is_archived        boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES users (id),
  row_version        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resources_category_idx ON resources (category, sort_order);

CREATE TRIGGER resources_touch BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Training topics (from the program guide) and per-intern completion.
-- ---------------------------------------------------------------------------
CREATE TABLE training_topics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  title       text NOT NULL,
  description text,
  sort_order  integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE training_completions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  topic_id     uuid NOT NULL REFERENCES training_topics (id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_completions_unique UNIQUE (user_id, topic_id)
);

-- ---------------------------------------------------------------------------
-- Admin-managed provisioning checklist. This records what an admin says they
-- have set up externally; the app never provisions accounts itself.
-- ---------------------------------------------------------------------------
CREATE TABLE intern_provisioning (
  user_id                       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  outreach_email_provisioned_at timestamptz,
  outreach_email_note           text,
  linkedin_premium_started_on   date,
  linkedin_premium_expires_on   date,
  linkedin_premium_note         text,
  updated_by                    uuid REFERENCES users (id),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_premium_window CHECK (
    linkedin_premium_expires_on IS NULL
    OR linkedin_premium_started_on IS NULL
    OR linkedin_premium_expires_on >= linkedin_premium_started_on
  )
);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
CREATE TYPE project_status     AS ENUM ('draft', 'active', 'completed', 'cancelled');
CREATE TYPE assignment_status  AS ENUM ('assigned', 'in_progress', 'ready_for_review', 'completed');

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id   uuid REFERENCES cohorts (id) ON DELETE SET NULL,
  title       text NOT NULL CHECK (btrim(title) <> ''),
  description text,
  due_on      date,
  status      project_status NOT NULL DEFAULT 'active',
  created_by  uuid NOT NULL REFERENCES users (id),
  row_version integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status     assignment_status NOT NULL DEFAULT 'assigned',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_assignments_unique UNIQUE (project_id, user_id)
);

CREATE TABLE project_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  notes         text,
  link_url      text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  feedback      text,
  feedback_by   uuid REFERENCES users (id),
  feedback_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_submissions_project_idx ON project_submissions (project_id, submitted_at DESC);

CREATE TRIGGER projects_touch BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER project_assignments_touch BEFORE UPDATE ON project_assignments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- End-of-program reflection (the four questions from the program guide).
-- ---------------------------------------------------------------------------
CREATE TABLE reflections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cohort_id          uuid NOT NULL REFERENCES cohorts (id) ON DELETE CASCADE,
  what_worked        text,
  what_did_not_work  text,
  successful_sports  text,
  recommendations    text,
  submitted_at       timestamptz,
  row_version        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reflections_unique UNIQUE (user_id, cohort_id)
);

CREATE TRIGGER reflections_touch BEFORE UPDATE ON reflections
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
