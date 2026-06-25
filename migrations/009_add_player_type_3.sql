-- Add player_count 3 and play_type 3 to constraints
ALTER TABLE contests DROP CONSTRAINT IF EXISTS chk_player_count;
ALTER TABLE contests ADD CONSTRAINT chk_player_count CHECK (player_count IN (2, 3, 4, 6));

ALTER TABLE contest_play_types DROP CONSTRAINT IF EXISTS chk_play_type;
ALTER TABLE contest_play_types ADD CONSTRAINT chk_play_type CHECK (play_type IN (2, 3, 4, 6));
