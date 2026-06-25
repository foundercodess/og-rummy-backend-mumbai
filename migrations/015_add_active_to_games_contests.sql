-- Add active flag to games and contests for admin activate/deactivate.
-- Default true so existing rows remain active.
ALTER TABLE games ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE contests ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_games_active ON games(active);
CREATE INDEX IF NOT EXISTS idx_contests_active ON contests(active);

COMMENT ON COLUMN games.active IS 'When false, game is hidden from public config (admin deactivated)';
COMMENT ON COLUMN contests.active IS 'When false, contest is hidden from public config (admin deactivated)';
