-- Contests (entry-fee brackets) per game and player count
CREATE TABLE IF NOT EXISTS contests (
  id SERIAL PRIMARY KEY,
  game_id INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_count INT NOT NULL,
  point_value VARCHAR(20),
  entry VARCHAR(20) NOT NULL,
  win_upto VARCHAR(20),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_player_count CHECK (player_count IN (2, 4, 6))
);

CREATE INDEX IF NOT EXISTS idx_contests_game_player ON contests(game_id, player_count);
