ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS stage_message text,
  ADD COLUMN IF NOT EXISTS repair_attempts integer NOT NULL DEFAULT 0 CHECK (repair_attempts >= 0);

CREATE TABLE IF NOT EXISTS project_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('secret', 'api', 'smtp', 'database', 'git', 'service')),
  name text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  environment text NOT NULL DEFAULT 'development' CHECK (environment IN ('development', 'staging', 'production', 'all')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  encrypted_value text,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name, environment),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_resources_project ON project_resources (project_id, environment, kind);

CREATE TABLE IF NOT EXISTS project_runtime_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('preview', 'build', 'agent', 'system')),
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_runtime_logs_project_time ON project_runtime_logs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_runtime_logs_run_time ON project_runtime_logs (run_id, created_at DESC) WHERE run_id IS NOT NULL;
