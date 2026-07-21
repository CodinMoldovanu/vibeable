ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS deployment_profile_name text,
  ADD COLUMN IF NOT EXISTS adapter text,
  ADD COLUMN IF NOT EXISTS adapter_config jsonb,
  ADD COLUMN IF NOT EXISTS resource_names jsonb;

UPDATE deployments d
   SET deployment_profile_name = p.name,
       adapter = p.adapter,
       adapter_config = p.config,
       resource_names = p.resource_names
  FROM deployment_profiles p
 WHERE d.profile_id = p.id
   AND (d.deployment_profile_name IS NULL OR d.adapter IS NULL OR d.adapter_config IS NULL OR d.resource_names IS NULL);

ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_adapter_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_adapter_check
  CHECK (adapter IS NULL OR adapter IN ('kubernetes', 'helm', 'docker_swarm', 'compose', 'gitops', 'webhook'));
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_adapter_config_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_adapter_config_check
  CHECK (adapter_config IS NULL OR jsonb_typeof(adapter_config) = 'object');
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_resource_names_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_resource_names_check
  CHECK (resource_names IS NULL OR jsonb_typeof(resource_names) = 'array');
