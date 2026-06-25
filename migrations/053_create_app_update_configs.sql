CREATE TABLE IF NOT EXISTS app_update_configs (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(20) NOT NULL UNIQUE,
  latest_version VARCHAR(32) NOT NULL,
  minimum_version VARCHAR(32) NOT NULL,
  download_url TEXT NOT NULL,
  release_notes TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by INT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_update_configs
  ADD CONSTRAINT chk_app_update_platform
  CHECK (platform IN ('android', 'ios'));

CREATE INDEX IF NOT EXISTS idx_app_update_platform ON app_update_configs(platform);

INSERT INTO app_update_configs (
  platform,
  latest_version,
  minimum_version,
  download_url,
  release_notes,
  enabled,
  metadata
) VALUES
  ('android', '1.0.0', '1.0.0', '', '', false, '{}'::jsonb),
  ('ios', '1.0.0', '1.0.0', '', '', false, '{}'::jsonb)
ON CONFLICT (platform) DO NOTHING;
