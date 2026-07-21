ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS active_branch text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS offloaded_at timestamptz;

CREATE TABLE IF NOT EXISTS stack_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'team', 'project')),
  scope_id uuid NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  rules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rules) = 'object'),
  is_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, scope_type, scope_id, name),
  UNIQUE (id, organization_id)
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS stack_profile_id uuid;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_stack_profile_fk;
ALTER TABLE projects ADD CONSTRAINT projects_stack_profile_fk
  FOREIGN KEY (stack_profile_id, organization_id) REFERENCES stack_profiles(id, organization_id) ON DELETE SET NULL (stack_profile_id);

CREATE TABLE IF NOT EXISTS project_git_settings (
  project_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  repository_url text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  branch_prefix text NOT NULL DEFAULT 'vibeable/',
  sync_mode text NOT NULL DEFAULT 'mirror' CHECK (sync_mode IN ('mirror', 'source')),
  encrypted_credential text,
  credential_type text NOT NULL DEFAULT 'bearer' CHECK (credential_type IN ('bearer', 'basic')),
  enabled boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_sync_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  name text NOT NULL,
  base_branch text NOT NULL DEFAULT 'main',
  working_branch text NOT NULL,
  auto_push boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  last_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, working_branch),
  UNIQUE (id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE
);

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS target_branch text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS worker_id uuid;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_worker_fk;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_worker_fk
  FOREIGN KEY (worker_id, organization_id) REFERENCES project_workers(id, organization_id) ON DELETE SET NULL (worker_id);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_project
  ON agent_runs(project_id)
  WHERE status IN ('waiting_approval', 'queued', 'planning', 'editing', 'testing');

CREATE TABLE IF NOT EXISTS deployment_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('team', 'project')),
  scope_id uuid NOT NULL,
  name text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('kubernetes', 'helm', 'docker_swarm', 'compose', 'gitops', 'webhook')),
  environment text NOT NULL CHECK (environment IN ('staging', 'production')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  resource_names jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(resource_names) = 'array'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, scope_type, scope_id, name),
  UNIQUE (id, organization_id)
);

ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS profile_id uuid,
  ADD COLUMN IF NOT EXISTS branch text NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollback_of uuid REFERENCES deployments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('preflight', 'planned', 'waiting_approval', 'approved', 'running', 'deployed', 'failed', 'rolled_back'));
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_profile_fk;
ALTER TABLE deployments ADD CONSTRAINT deployments_profile_fk
  FOREIGN KEY (profile_id, organization_id) REFERENCES deployment_profiles(id, organization_id) ON DELETE RESTRICT;

ALTER TABLE deployment_events
  ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS projects_lifecycle ON projects (organization_id, archived_at, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS stack_profiles_scope ON stack_profiles (organization_id, scope_type, scope_id);
CREATE UNIQUE INDEX IF NOT EXISTS stack_profiles_one_default_per_scope
  ON stack_profiles (organization_id, scope_type, scope_id) WHERE is_default AND enabled;
CREATE INDEX IF NOT EXISTS deployment_profiles_scope ON deployment_profiles (organization_id, scope_type, scope_id, environment);
CREATE INDEX IF NOT EXISTS project_workers_project ON project_workers (project_id, status, updated_at DESC);
