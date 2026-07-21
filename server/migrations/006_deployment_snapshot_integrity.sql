ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_snapshot_integrity_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_snapshot_integrity_check CHECK (
  profile_id IS NULL OR (
    deployment_profile_name IS NOT NULL AND
    adapter IS NOT NULL AND
    adapter_config IS NOT NULL AND
    resource_names IS NOT NULL
  )
);
