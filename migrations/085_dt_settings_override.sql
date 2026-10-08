-- migrations/XXXXXX_dt_settings_override.sql

ALTER TABLE dt_settings
  ADD COLUMN IF NOT EXISTS override_result VARCHAR(8)
    CHECK (override_result IN ('dragon', 'tiger', 'tie')),
  ADD COLUMN IF NOT EXISTS override_set_at TIMESTAMPTZ;

COMMENT ON COLUMN dt_settings.override_result IS
  'Manual next-round winner chosen by admin. Applies to exactly one round, '
  'then cleared. NULL = no override. Takes precedence over difficulty.';
COMMENT ON COLUMN dt_settings.override_set_at IS
  'When the override was set. Used for audit trail and stale override detection.';