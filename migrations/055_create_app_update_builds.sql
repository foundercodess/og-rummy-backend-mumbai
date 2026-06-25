CREATE TABLE IF NOT EXISTS app_update_builds (
  id BIGSERIAL PRIMARY KEY,
  platform VARCHAR(20) NOT NULL,
  version VARCHAR(32) NOT NULL,
  download_url TEXT NOT NULL,
  s3_key TEXT NOT NULL,
  release_notes TEXT,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  uploaded_by INT REFERENCES admins(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ NULL,
  deleted_by INT REFERENCES admins(id) ON DELETE SET NULL,
  delete_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_app_update_builds_platform CHECK (platform IN ('android', 'ios'))
);

CREATE INDEX IF NOT EXISTS idx_app_update_builds_platform_created
  ON app_update_builds(platform, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_app_update_builds_platform_deleted
  ON app_update_builds(platform, is_deleted, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_update_builds_platform_s3_key
  ON app_update_builds(platform, s3_key);
