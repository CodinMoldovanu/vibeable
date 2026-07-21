ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'local';

ALTER TABLE users
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE memberships
  DROP CONSTRAINT IF EXISTS memberships_source_check;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_source_check CHECK (source IN ('local', 'oidc'));

CREATE TABLE IF NOT EXISTS user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('oidc')),
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject),
  UNIQUE (user_id, provider, issuer)
);

CREATE INDEX IF NOT EXISTS user_identities_user_id ON user_identities (user_id);

CREATE TABLE IF NOT EXISTS oidc_login_attempts (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  encrypted_code_verifier text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oidc_login_attempts_expires_at ON oidc_login_attempts (expires_at);
