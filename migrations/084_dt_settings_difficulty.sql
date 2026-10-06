-- migrations/084_dt_settings_difficulty.sql

ALTER TABLE dt_settings
  ADD COLUMN IF NOT EXISTS difficulty VARCHAR(8)
    NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('min', 'medium', 'high'));

COMMENT ON COLUMN dt_settings.difficulty IS
  'Outcome bias tier, read at the start of each round. '
  'min = highest-staked side of THIS round wins (users win). '
  'high = lowest-staked side of THIS round wins (house wins). '
  'medium = no bias; shoe draws naturally.';